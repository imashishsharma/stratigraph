/**
 * Per-file history metrics.
 *
 * Arithmetic over `git_commit` and `commit_file`, plus one measurement off
 * disk. No judgement, no ranking, no threshold — see ADR-0010 for why those
 * live in `finding` instead.
 */

import { join } from 'node:path';

import type { Db } from '../db/database.js';
import { measureFile } from './complexity.js';

export interface MetricsStats {
  /** `file_metric` rows written. */
  files: number;
  /** Of those, how many got a complexity score. */
  measured: number;
  skippedBinary: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  /** Start of the hotspot window (ADR-0031); null when there are no commits. */
  windowStart: string | null;
  /** Commits in the window left out of `recent_commits` for touching too many files. */
  excludedBulk: number;
  /** Commits in the window left out because `.git-blame-ignore-revs` lists them. */
  excludedIgnored: number;
}

export interface MetricsOptions {
  /** Months back from the newest non-merge commit. Default 12. */
  windowMonths?: number;
  /** Commits touching more files than this are sweeps. Default 50. */
  maxFilesPerCommit?: number;
  /** Full SHAs whose changes are mechanical — `.git-blame-ignore-revs`. */
  ignoreRevs?: readonly string[];
}

/**
 * Merges are excluded from every metric (ADR-0011). git prints no diff for
 * them by default, so today this changes nothing — but the moment anyone adds
 * `--diff-merges` to the log for some other reason, every count would silently
 * double without it.
 *
 * `top_author_share` is a share of *commits*, not of lines: one reformatting
 * commit can rewrite a whole file, and ownership by line would then credit the
 * whole file to whoever ran the formatter.
 */
const AGGREGATE = /* sql */ `
INSERT INTO file_metric
  (run_id, path, commits, churn, authors, top_author_share, first_change_at, last_change_at,
   recent_commits)
WITH
  changed AS (
    SELECT cf.canonical_path AS path, cf.commit_id, cf.insertions, cf.deletions,
           c.author_email, c.authored_at
      FROM commit_file cf
      JOIN git_commit c ON c.id = cf.commit_id
     WHERE cf.run_id = @runId AND c.is_merge = 0
  ),
  per_file AS (
    SELECT path,
           COUNT(DISTINCT commit_id)      AS commits,
           SUM(insertions + deletions)    AS churn,
           COUNT(DISTINCT author_email)   AS authors,
           MIN(authored_at)               AS first_change_at,
           MAX(authored_at)               AS last_change_at
      FROM changed
     GROUP BY path
  ),
  per_author AS (
    SELECT path, author_email, COUNT(DISTINCT commit_id) AS commits
      FROM changed
     GROUP BY path, author_email
  ),
  top_author AS (
    SELECT path, MAX(commits) AS commits FROM per_author GROUP BY path
  ),
  -- ADR-0031: how often people went back to the file lately. Sweeps and
  -- revisions the repository itself marks as mechanical say nothing about that.
  recent AS (
    SELECT ch.path, COUNT(DISTINCT ch.commit_id) AS commits
      FROM changed ch
      JOIN git_commit c ON c.id = ch.commit_id
     WHERE ch.authored_at >= @windowStart
       AND ch.commit_id NOT IN (SELECT commit_id FROM bulk_commit)
       AND c.sha NOT IN (SELECT sha FROM ignored_rev)
     GROUP BY ch.path
  )
SELECT @runId, f.path, f.commits, f.churn, f.authors,
       CAST(t.commits AS REAL) / f.commits,
       f.first_change_at, f.last_change_at,
       COALESCE(r.commits, 0)
  FROM per_file f
  JOIN top_author t ON t.path = f.path
  LEFT JOIN recent r ON r.path = f.path
  -- ADR-0011: only files that still exist. A deleted file has no content to
  -- measure and coupling between two of them cannot be acted on. History that
  -- was renamed forward is kept, because canonical_path already resolved it.
  JOIN tracked_file k ON k.path = f.path
`;

/**
 * Fill `file_metric` for a run.
 *
 * `trackedFiles` is what `git ls-files` reported, repo-relative.
 */
export function computeFileMetrics(
  db: Db,
  runId: number,
  repoPath: string,
  trackedFiles: readonly string[],
  options: MetricsOptions = {},
): MetricsStats {
  const windowMonths = options.windowMonths ?? 12;
  const maxFiles = options.maxFilesPerCommit ?? 50;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS tracked_file (path TEXT PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS bulk_commit (commit_id INTEGER PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS ignored_rev (sha TEXT PRIMARY KEY)');

  const newest = (
    db
      .prepare('SELECT MAX(authored_at) AS at FROM git_commit WHERE run_id = ? AND is_merge = 0')
      .get(runId) as { at: string | null }
  ).at;
  const windowStart = newest === null ? null : monthsBefore(newest, windowMonths);

  const stats: MetricsStats = {
    files: 0,
    measured: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
    windowStart,
    excludedBulk: 0,
    excludedIgnored: 0,
  };

  db.transaction(() => {
    db.exec('DELETE FROM tracked_file');
    const track = db.prepare('INSERT OR IGNORE INTO tracked_file (path) VALUES (?)');
    for (const path of trackedFiles) track.run(path);

    db.exec('DELETE FROM bulk_commit');
    db.prepare(
      `INSERT INTO bulk_commit (commit_id)
       SELECT commit_id FROM commit_file WHERE run_id = ? GROUP BY commit_id HAVING COUNT(*) > ?`,
    ).run(runId, maxFiles);
    db.exec('DELETE FROM ignored_rev');
    const ignore = db.prepare('INSERT OR IGNORE INTO ignored_rev (sha) VALUES (?)');
    for (const sha of options.ignoreRevs ?? []) ignore.run(sha);

    if (windowStart !== null) {
      const inWindow = `FROM git_commit c
         WHERE c.run_id = @runId AND c.is_merge = 0 AND c.authored_at >= @windowStart`;
      stats.excludedBulk = (
        db
          .prepare(`SELECT COUNT(*) AS n ${inWindow} AND c.id IN (SELECT commit_id FROM bulk_commit)`)
          .get({ runId, windowStart }) as { n: number }
      ).n;
      stats.excludedIgnored = (
        db
          .prepare(
            `SELECT COUNT(*) AS n ${inWindow} AND c.sha IN (SELECT sha FROM ignored_rev)
               AND c.id NOT IN (SELECT commit_id FROM bulk_commit)`,
          )
          .get({ runId, windowStart }) as { n: number }
      ).n;
    }

    const windowCommits =
      windowStart === null
        ? 0
        : (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM git_commit
                  WHERE run_id = ? AND is_merge = 0 AND authored_at >= ?`,
              )
              .get(runId, windowStart) as { n: number }
          ).n;
    db.prepare(
      `INSERT OR REPLACE INTO history_window
         (run_id, window_start, window_end, months, max_files, commits, excluded_bulk, excluded_ignored)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      windowStart,
      newest,
      windowMonths,
      maxFiles,
      windowCommits,
      stats.excludedBulk,
      stats.excludedIgnored,
    );

    db.prepare('DELETE FROM file_metric WHERE run_id = ?').run(runId);
    stats.files = db.prepare(AGGREGATE).run({ runId, windowStart: windowStart ?? '' }).changes;
  })();

  // Complexity comes off disk, so it is a second pass rather than part of the
  // aggregate. Files are read one at a time; a repository's worth of source
  // does not need to be resident at once.
  const rows = db
    .prepare('SELECT id, path FROM file_metric WHERE run_id = ?')
    .all(runId) as Array<{ id: number; path: string }>;
  const update = db.prepare('UPDATE file_metric SET complexity = ?, indent_unit = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      const measurement = measureFile(join(repoPath, row.path));
      update.run(measurement.complexity, measurement.indentUnit, row.id);
      if (measurement.skipped === null) stats.measured += 1;
      else if (measurement.skipped === 'binary') stats.skippedBinary += 1;
      else if (measurement.skipped === 'too-large') stats.skippedTooLarge += 1;
      else stats.skippedUnreadable += 1;
    }
  })();

  db.exec('DROP TABLE IF EXISTS tracked_file');
  db.exec('DROP TABLE IF EXISTS bulk_commit');
  db.exec('DROP TABLE IF EXISTS ignored_rev');
  return stats;
}

/** `iso` moved back by whole calendar months, in UTC. */
function monthsBefore(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

/**
 * The SHAs in `.git-blame-ignore-revs`: one per line, `#` comments allowed.
 * The file is the repository's own statement that a commit is mechanical, so
 * it is read rather than second-guessed. Missing file, no revisions.
 */
export function readIgnoreRevs(text: string | null): string[] {
  if (text === null) return [];
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(line));
}
