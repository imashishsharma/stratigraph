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
  /** Share of ranked files no more deeply indented than this one, 0..1. */
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
  const complexity = percentiles(rows.map((row) => row.complexity));
  const ranked = rows
    .map((row) => {
      const recentPercentile = recent(row.recentCommits);
      const complexityPercentile = complexity(row.complexity);
      return {
        ...row,
        recentPercentile,
        complexityPercentile,
        score: recentPercentile * complexityPercentile,
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
