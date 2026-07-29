/**
 * Hotspots and bus factor.
 *
 * A hotspot is a file that is both changed a lot and complicated — the two
 * together, because neither alone is interesting. A file nobody touches can be
 * as tangled as it likes, and a file everyone touches can be trivial. The
 * product is where effort and difficulty meet.
 *
 * Bus factor is the smallest number of people whose commits account for more
 * than half of a file's history. One is a risk; it is not a judgement about
 * the person, and the finding says so.
 */

import type { Db } from '../db/database.js';

export interface Hotspot {
  path: string;
  commits: number;
  churn: number;
  /** Total indentation. Null files are not ranked — see `complexity.ts`. */
  complexity: number;
  /** `churn × complexity`. */
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

/**
 * The files where change and complexity meet, highest first.
 *
 * Files with no complexity score are excluded rather than ranked at zero: an
 * unmeasured file is not a simple one, and putting it last would say it was.
 * `history` already warns how many there are.
 */
export function topHotspots(db: Db, runId: number, limit: number): Hotspot[] {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT path, commits, churn, complexity, authors, top_author_share AS topAuthorShare,
             last_change_at AS lastChangeAt,
             churn * complexity AS score
        FROM file_metric
       WHERE run_id = @runId AND complexity IS NOT NULL AND churn > 0
       ORDER BY score DESC, churn DESC, path
       LIMIT @limit`,
    )
    .all({ runId, limit }) as Array<Omit<Hotspot, 'busFactor' | 'topAuthor'>>;

  return withOwnership(db, runId, rows);
}

/**
 * Files whose history is concentrated in one person.
 *
 * `minCommits` keeps out files that only one person has touched because only
 * one person has ever touched them — two commits by one author is not a bus
 * factor, it is a new file.
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
      SELECT path, commits, churn, COALESCE(complexity, 0) AS complexity, authors,
             top_author_share AS topAuthorShare, last_change_at AS lastChangeAt,
             churn * COALESCE(complexity, 0) AS score
        FROM file_metric
       WHERE run_id = @runId AND commits >= @minCommits
       ORDER BY churn DESC, path`,
    )
    .all({ runId, minCommits }) as Array<Omit<Hotspot, 'busFactor' | 'topAuthor'>>;

  return withOwnership(db, runId, rows)
    .filter((file) => file.busFactor <= 1)
    .slice(0, limit);
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
