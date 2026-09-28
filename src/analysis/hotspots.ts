/**
 * Hotspots and bus factor.
 *
 * A hotspot is a source file that is both changed a lot lately and
 * complicated — the two together, because neither alone is interesting. A
 * file nobody touches can be as tangled as it likes, and a file everyone
 * touches can be trivial. ADR-0031 fixes what "a lot", "lately" and "source"
 * mean, and why the two terms are combined as percentiles.
 *
 * Bus factor is the smallest number of people whose commits account for more
 * than half of a file's history. One is a risk; it is not a judgement about
 * the person, and the finding says so.
 */

import type { Db } from '../db/database.js';

export interface Hotspot {
  path: string;
  /** All-time non-merge commits. */
  commits: number;
  /** Commits in the hotspot window, sweeps and ignored revisions excluded. */
  recentCommits: number;
  churn: number;
  /** Total indentation in the file's own unit. Null files are not ranked. */
  complexity: number;
  /** Share of ranked files with no more recent commits than this one, 0..1. */
  recentPercentile: number;
  /** Share of ranked files of the same type no more deeply indented than this one, 0..1. */
  complexityPercentile: number;
  /** `recentPercentile × complexityPercentile`. */
  score: number;
  authors: number;
  /** Share of commits by the most frequent author, 0..1. */
  topAuthorShare: number;
  /** Smallest set of authors accounting for more than half the commits. */
  busFactor: number;
  /** Email of the author with the most commits, for the citation. */
  topAuthor: string | null;
  lastChangeAt: string | null;
}

type Row = Omit<Hotspot, 'busFactor' | 'topAuthor' | 'recentPercentile' | 'complexityPercentile' | 'score'>;

const COLUMNS = /* sql */ `
  m.path, m.commits, m.recent_commits AS recentCommits, m.churn,
  COALESCE(m.complexity, 0) AS complexity, m.authors,
  COALESCE(m.top_author_share, 0) AS topAuthorShare, m.last_change_at AS lastChangeAt`;

/**
 * The source files where recent change and complexity meet, highest first.
 *
 * Files with no complexity score are excluded rather than ranked at zero: an
 * unmeasured file is not a simple one, and putting it last would say it was.
 */
export function topHotspots(db: Db, runId: number, limit: number): Hotspot[] {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT ${COLUMNS}
        FROM file_metric m
        JOIN file_role r ON r.run_id = m.run_id AND r.path = m.path AND r.role = 'source'
       WHERE m.run_id = @runId AND m.complexity IS NOT NULL AND m.recent_commits > 0`,
    )
    .all({ runId }) as Row[];

  const recent = percentiles(rows.map((row) => row.recentCommits));
  const complexity = complexityWithinType(rows);
  const ranked = rows
    .map((row) => {
      const recentPercentile = recent(row.recentCommits);
      const complexityPercentile = complexity(row);
      return {
        ...row,
        recentPercentile,
        complexityPercentile,
        // Complexity scales the change term between half and full weight
        // (ADR-0031, amended after the M11 scorecard): a heavily changed file
        // stays near the top however simple, and complexity orders the rest.
        score: recentPercentile * (0.5 + 0.5 * complexityPercentile),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.recentCommits - a.recentCommits ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, limit);

  return withOwnership(db, runId, ranked);
}

export interface HotspotWindow {
  windowStart: string | null;
  windowEnd: string | null;
  months: number;
  maxFiles: number;
  commits: number;
  excludedBulk: number;
  excludedIgnored: number;
}

/** How the ranking's change term was measured, or null when history predates it. */
export function hotspotWindow(db: Db, runId: number): HotspotWindow | null {
  const row = db
    .prepare(
      /* sql */ `
      SELECT window_start AS windowStart, window_end AS windowEnd, months, max_files AS maxFiles,
             commits, excluded_bulk AS excludedBulk, excluded_ignored AS excludedIgnored
        FROM history_window WHERE run_id = ?`,
    )
    .get(runId) as HotspotWindow | undefined;
  return row ?? null;
}

/**
 * One sentence on how the ranking was made, and — when it is empty — why.
 *
 * An empty hotspot list with no explanation reads as "nothing is risky". It
 * almost never means that: usually the window held only sweeping commits, or
 * the history predates file roles. The reader is owed which.
 */
export function explainHotspots(db: Db, runId: number, ranked: number): string {
  const window = hotspotWindow(db, runId);
  const roles = (
    db.prepare('SELECT COUNT(*) AS n FROM file_role WHERE run_id = ?').get(runId) as { n: number }
  ).n;
  if (window === null || roles === 0) {
    return (
      'This run\'s history was mined before file roles and the hotspot window existed, so ' +
      'nothing can be ranked. Fix: `stratigraph history`.'
    );
  }
  if (window.windowStart === null) return 'No commits were mined, so nothing can be ranked.';

  const span = `the ${window.months} months to ${(window.windowEnd ?? '').slice(0, 10)}`;
  const excluded = window.excludedBulk + window.excludedIgnored;
  const how =
    `Ranked among source files changed in ${span}: ${window.commits} commit(s), of which ` +
    `${window.excludedBulk} touched more than ${window.maxFiles} files and ` +
    `${window.excludedIgnored} are listed in .git-blame-ignore-revs; those are not counted.`;
  if (ranked > 0) return how;
  if (window.commits > 0 && excluded === window.commits) {
    return (
      `No hotspots: every one of the ${window.commits} commit(s) in ${span} was a sweep ` +
      `(more than ${window.maxFiles} files) or a listed mechanical revision, so no source file ` +
      `shows deliberate recent change. Raise history.maxFilesPerCommit or ` +
      `history.hotspotMonths if these commits are real work.`
    );
  }
  return `No hotspots: no source file was changed in ${span}. ${how}`;
}

/** How many files `topHotspots` ranks among: source, measured, changed in the window. */
export function hotspotCandidates(db: Db, runId: number): number {
  return (
    db
      .prepare(
        /* sql */ `
        SELECT COUNT(*) AS n
          FROM file_metric m
          JOIN file_role r ON r.run_id = m.run_id AND r.path = m.path AND r.role = 'source'
         WHERE m.run_id = ? AND m.complexity IS NOT NULL AND m.recent_commits > 0`,
      )
      .get(runId) as { n: number }
  ).n;
}

/**
 * Source files whose history is concentrated in one person, most recently
 * active first.
 *
 * `minCommits` keeps out files that only one person has touched because only
 * one person has ever touched them — two commits by one author is not a bus
 * factor, it is a new file. A file nobody has touched within the window is left
 * out too: its knowledge is not in use.
 */
export function busFactorRisks(
  db: Db,
  runId: number,
  limit: number,
  minCommits: number,
): Hotspot[] {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT ${COLUMNS}
        FROM file_metric m
        JOIN file_role r ON r.run_id = m.run_id AND r.path = m.path AND r.role = 'source'
       WHERE m.run_id = @runId AND m.commits >= @minCommits AND m.recent_commits > 0
       ORDER BY m.recent_commits DESC, m.commits DESC, m.path`,
    )
    .all({ runId, minCommits }) as Row[];

  const unranked = rows.map((row) => ({
    ...row,
    recentPercentile: 0,
    complexityPercentile: 0,
    score: 0,
  }));
  return withOwnership(db, runId, unranked)
    .filter((file) => file.busFactor <= 1)
    .slice(0, limit);
}

/** A file type needs this many ranked files to be compared against itself. */
export const MIN_TYPE_POOL = 10;

/**
 * Complexity percentile within the file's own type (ADR-0031).
 *
 * Indentation is a different unit in each language: markup nests on every
 * element, Java on every branch. Pooled together, templates outrank code by
 * nesting alone. A type with too few files to rank against itself is ranked
 * against every ranked file, so a lone file is not top of its class by being
 * alone in it.
 */
function complexityWithinType(rows: readonly Row[]): (row: Row) => number {
  const byType = new Map<string, number[]>();
  for (const row of rows) {
    const type = fileType(row.path);
    const pool = byType.get(type) ?? [];
    pool.push(row.complexity);
    byType.set(type, pool);
  }
  const ranked = new Map<string, (v: number) => number>();
  for (const [type, values] of byType) {
    if (values.length >= MIN_TYPE_POOL) ranked.set(type, percentiles(values));
  }
  const pooled = percentiles(rows.map((row) => row.complexity));
  return (row) => (ranked.get(fileType(row.path)) ?? pooled)(row.complexity);
}

function fileType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Cumulative percentile: the share of values less than or equal to `v`. Ties
 * share a percentile, and the largest value is always 1.
 */
function percentiles(values: readonly number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) <= v) lo = mid + 1;
      else hi = mid;
    }
    return n === 0 ? 0 : lo / n;
  };
}

/**
 * Attach bus factor and top author, in one query over the files in question.
 *
 * Per-file rather than repository-wide: the author breakdown is files ×
 * authors rows, which on a large repository is far more than the report needs.
 */
function withOwnership(
  db: Db,
  runId: number,
  files: Array<Omit<Hotspot, 'busFactor' | 'topAuthor'>>,
): Hotspot[] {
  if (files.length === 0) return [];

  const placeholders = files.map(() => '?').join(', ');
  const rows = db
    .prepare(
      /* sql */ `
      SELECT cf.canonical_path AS path, c.author_email AS email,
             COUNT(DISTINCT cf.commit_id) AS commits
        FROM commit_file cf
        JOIN git_commit c ON c.id = cf.commit_id
       WHERE cf.run_id = ? AND c.is_merge = 0 AND cf.canonical_path IN (${placeholders})
       GROUP BY cf.canonical_path, c.author_email`,
    )
    .all(runId, ...files.map((f) => f.path)) as Array<{
    path: string;
    email: string;
    commits: number;
  }>;

  const byPath = new Map<string, Array<{ email: string; commits: number }>>();
  for (const row of rows) {
    const existing = byPath.get(row.path);
    if (existing) existing.push(row);
    else byPath.set(row.path, [row]);
  }

  return files.map((file) => {
    const authors = (byPath.get(file.path) ?? []).sort(
      (a, b) => b.commits - a.commits || a.email.localeCompare(b.email),
    );
    const total = authors.reduce((sum, author) => sum + author.commits, 0);

    let covered = 0;
    let busFactor = 0;
    for (const author of authors) {
      covered += author.commits;
      busFactor += 1;
      if (covered * 2 > total) break;
    }

    return {
      ...file,
      busFactor,
      topAuthor: authors[0]?.email ?? null,
    };
  });
}
