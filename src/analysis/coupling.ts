/**
 * Temporal coupling: files that change together.
 *
 * The point of M2. Two files that change in the same commit again and again,
 * with nothing in the code connecting them, are held together by something
 * nobody wrote down — and the static graph cannot see it by construction.
 *
 * Every threshold here, and the failure it prevents, is in ADR-0011. Nothing
 * is filtered silently: the returned stats say what each rule removed, because
 * a repository whose history was mostly filtered away must announce itself
 * rather than look like one with little coupling.
 */

import type { Db } from '../db/database.js';
import { DEPENDENCY_EDGE_KINDS } from './package-graph.js';

export interface CouplingOptions {
  /** Commits touching more than this take no part. */
  maxFilesPerCommit: number;
  /** A pair must co-change at least this often. */
  minShared: number;
  /** Each file must have changed at least this often. */
  minCommits: number;
  /** Safety valve; see `MAX_PAIRS`. Overridable so the guard itself is testable. */
  maxPairs?: number | undefined;
}

export interface CoupledPair {
  pathA: string;
  pathB: string;
  /** Commits touching both. */
  shared: number;
  /** Commits touching each, within the set that took part. */
  commitsA: number;
  commitsB: number;
  /** `shared / min(commitsA, commitsB)`. The stored, ranked measure. */
  strength: number;
  /** Co-changes over co-changes expected by chance. Must exceed 1. */
  lift: number;
  /** Layer-2 edges connecting the two files. The interesting pairs have none. */
  staticEdges: number;
}

export interface CouplingStats {
  /** Non-merge commits with at least two in-scope files. */
  commitsConsidered: number;
  /** Excluded by `maxFilesPerCommit`. */
  commitsCapped: number;
  /** Files frequent enough to be paired at all. */
  filesConsidered: number;
  /** Distinct pairs counted before thresholds. */
  pairsSeen: number;
  pairsBelowMinShared: number;
  pairsBelowLift: number;
  stored: number;
}

/**
 * Guard against a repository whose shape defeats the thresholds.
 *
 * A pair map this large means the settings are wrong for the repository, and
 * failing with advice beats being killed by the OS with none.
 */
export const MAX_PAIRS = 5_000_000;

export class CouplingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouplingError';
  }
}

/**
 * Only files that survived into `file_metric` take part — which is ADR-0011's
 * "present at HEAD, and inside include/exclude", already applied once.
 *
 * DISTINCT because two paths in one commit can canonicalise to the same file:
 * a rename resolves the pre-image forward, and the post-image may be touched
 * in the same commit.
 */
const COMMIT_FILES = /* sql */ `
  SELECT DISTINCT cf.commit_id AS commitId, cf.canonical_path AS path
    FROM commit_file cf
    JOIN git_commit c ON c.id = cf.commit_id
    JOIN file_metric m ON m.run_id = cf.run_id AND m.path = cf.canonical_path
   WHERE cf.run_id = @runId AND c.is_merge = 0
   ORDER BY cf.commit_id
`;

/**
 * Compute coupling for a run and store it, replacing whatever a previous
 * analysis left.
 *
 * Returns the pairs as well as the stats, because `lift` has no column — the
 * schema stores `strength`, and lift is cheap to recompute but needs the
 * considered-commit total, which only this function knows.
 */
export function computeTemporalCoupling(
  db: Db,
  runId: number,
  options: CouplingOptions,
): { stats: CouplingStats; pairs: CoupledPair[] } {
  const commits = groupByCommit(
    db.prepare(COMMIT_FILES).all({ runId }) as Array<{ commitId: number; path: string }>,
  );

  const stats: CouplingStats = {
    commitsConsidered: 0,
    commitsCapped: 0,
    filesConsidered: 0,
    pairsSeen: 0,
    pairsBelowMinShared: 0,
    pairsBelowLift: 0,
    stored: 0,
  };

  // Pass one: how often each file changes, among the commits that take part.
  // Pairing only files that clear `minCommits` is what keeps the pair map
  // tractable — in any real repository most files change once or twice, and
  // pairing them would dominate memory while producing nothing that survives
  // the thresholds anyway.
  const fileCommits = new Map<string, number>();
  const pairable: string[][] = [];
  for (const files of commits) {
    if (files.length > options.maxFilesPerCommit) {
      stats.commitsCapped += 1;
      continue;
    }
    // A single-file commit produces no pair, but it is still a commit that
    // touched that file and did *not* touch anything else. Leaving it out of
    // the denominator would inflate every file's base rate — a file changed in
    // 100 of 1000 commits would look like one changed in 100 of 200, and lift
    // would then reject genuine coupling as coincidence.
    stats.commitsConsidered += 1;
    for (const path of files) fileCommits.set(path, (fileCommits.get(path) ?? 0) + 1);
    if (files.length >= 2) pairable.push(files);
  }

  const frequent = new Set(
    [...fileCommits].filter(([, n]) => n >= options.minCommits).map(([path]) => path),
  );
  stats.filesConsidered = frequent.size;

  // Pass two: count co-changes among those files.
  const maxPairs = options.maxPairs ?? MAX_PAIRS;
  const shared = new Map<string, number>();
  for (const files of pairable) {
    // Sorted, so that a pair has one key however the commit happened to list
    // its files — and so that key agrees with the one `fileEdgeCounts` builds.
    const paired = files.filter((path) => frequent.has(path)).sort();
    for (let i = 0; i < paired.length; i += 1) {
      for (let j = i + 1; j < paired.length; j += 1) {
        const key = `${paired[i]}\0${paired[j]}`;
        const seen = shared.get(key);
        if (seen === undefined && shared.size >= maxPairs) {
          throw new CouplingError(
            `more than ${maxPairs.toLocaleString('en-US')} co-changing file pairs — this ` +
              `repository's commits are too broad for the current settings. Raise ` +
              `history.minCommits (now ${options.minCommits}) or lower ` +
              `history.maxFilesPerCommit (now ${options.maxFilesPerCommit}).`,
          );
        }
        shared.set(key, (seen ?? 0) + 1);
      }
    }
  }
  stats.pairsSeen = shared.size;

  const staticEdges = fileEdgeCounts(db, runId);
  const total = stats.commitsConsidered;
  const pairs: CoupledPair[] = [];

  for (const [key, count] of shared) {
    if (count < options.minShared) {
      stats.pairsBelowMinShared += 1;
      continue;
    }
    const [pathA, pathB] = key.split('\0') as [string, string];
    const commitsA = fileCommits.get(pathA) as number;
    const commitsB = fileCommits.get(pathB) as number;

    // Two files each touched in 30% of commits share about 9% by coincidence.
    // Reporting that as coupling is reporting the base rate.
    const expected = (commitsA * commitsB) / total;
    const lift = count / expected;
    if (lift <= 1) {
      stats.pairsBelowLift += 1;
      continue;
    }

    pairs.push({
      pathA,
      pathB,
      shared: count,
      commitsA,
      commitsB,
      strength: count / Math.min(commitsA, commitsB),
      lift,
      staticEdges: staticEdges.get(key) ?? 0,
    });
  }

  // Ranked by the stored measure, so what the report shows and what the table
  // holds agree. Ties broken by name, so two runs produce the same order.
  pairs.sort(
    (a, b) =>
      b.strength - a.strength ||
      b.shared - a.shared ||
      a.pathA.localeCompare(b.pathA) ||
      a.pathB.localeCompare(b.pathB),
  );

  db.transaction(() => {
    db.prepare('DELETE FROM temporal_coupling WHERE run_id = ?').run(runId);
    const insert = db.prepare(
      `INSERT INTO temporal_coupling
         (run_id, path_a, path_b, shared, commits_a, commits_b, strength, static_edges)
       VALUES (@runId, @pathA, @pathB, @shared, @commitsA, @commitsB, @strength, @staticEdges)`,
    );
    for (const pair of pairs) {
      // Named explicitly rather than spread: `lift` has no column, and the
      // schema is the thing that decides what is stored.
      insert.run({
        runId,
        pathA: pair.pathA,
        pathB: pair.pathB,
        shared: pair.shared,
        commitsA: pair.commitsA,
        commitsB: pair.commitsB,
        strength: pair.strength,
        staticEdges: pair.staticEdges,
      });
    }
  })();
  stats.stored = pairs.length;

  return { stats, pairs };
}

function groupByCommit(rows: Array<{ commitId: number; path: string }>): string[][] {
  const commits: string[][] = [];
  let current: string[] = [];
  let currentId: number | null = null;

  for (const row of rows) {
    if (row.commitId !== currentId) {
      if (currentId !== null) commits.push(current);
      current = [];
      currentId = row.commitId;
    }
    current.push(row.path);
  }
  if (currentId !== null) commits.push(current);
  return commits;
}

/**
 * How many layer-2 edges connect each pair of files, in either direction.
 *
 * "A static dependency" has to mean the same thing here as it does in the
 * package graph, so the edge kinds come from there rather than being listed
 * again. A pair with zero of these is what ADR-0010 makes a finding of.
 */
function fileEdgeCounts(db: Db, runId: number): Map<string, number> {
  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const rows = db
    .prepare(
      /* sql */ `
      SELECT sf.path AS a, df.path AS b, COUNT(*) AS n
        FROM edge e
        JOIN node sn ON sn.id = e.src_id
        JOIN node dn ON dn.id = e.dst_id
        JOIN source_file sf ON sf.id = sn.file_id
        JOIN source_file df ON df.id = dn.file_id
       WHERE e.run_id = @runId
         AND e.kind IN (${kinds})
         AND e.confidence = 'fact'
         AND sf.path <> df.path
       GROUP BY sf.path, df.path`,
    )
    .all({ runId }) as Array<{ a: string; b: string; n: number }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.a < row.b ? `${row.a}\0${row.b}` : `${row.b}\0${row.a}`;
    counts.set(key, (counts.get(key) ?? 0) + row.n);
  }
  return counts;
}
