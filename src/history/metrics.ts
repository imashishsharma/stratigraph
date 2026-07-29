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
  (run_id, path, commits, churn, authors, top_author_share, first_change_at, last_change_at)
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
  )
SELECT @runId, f.path, f.commits, f.churn, f.authors,
       CAST(t.commits AS REAL) / f.commits,
       f.first_change_at, f.last_change_at
  FROM per_file f
  JOIN top_author t ON t.path = f.path
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
): MetricsStats {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS tracked_file (path TEXT PRIMARY KEY)');

  const stats: MetricsStats = {
    files: 0,
    measured: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
  };

  db.transaction(() => {
    db.exec('DELETE FROM tracked_file');
    const track = db.prepare('INSERT OR IGNORE INTO tracked_file (path) VALUES (?)');
    for (const path of trackedFiles) track.run(path);

    db.prepare('DELETE FROM file_metric WHERE run_id = ?').run(runId);
    stats.files = db.prepare(AGGREGATE).run({ runId }).changes;
  })();

  // Complexity comes off disk, so it is a second pass rather than part of the
  // aggregate. Files are read one at a time; a repository's worth of source
  // does not need to be resident at once.
  const rows = db
    .prepare('SELECT id, path FROM file_metric WHERE run_id = ?')
    .all(runId) as Array<{ id: number; path: string }>;
  const update = db.prepare('UPDATE file_metric SET complexity = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      const measurement = measureFile(join(repoPath, row.path));
      update.run(measurement.complexity, row.id);
      if (measurement.skipped === null) stats.measured += 1;
      else if (measurement.skipped === 'binary') stats.skippedBinary += 1;
      else if (measurement.skipped === 'too-large') stats.skippedTooLarge += 1;
      else stats.skippedUnreadable += 1;
    }
  })();

  db.exec('DROP TABLE IF EXISTS tracked_file');
  return stats;
}
