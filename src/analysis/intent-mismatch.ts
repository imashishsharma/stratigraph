/**
 * Intent versus structure: a package named alongside one group, clustered with
 * another.
 *
 * The claim is arithmetic over the partition, not a judgement about what a name
 * means — see ADR-0014 for why that distinction is load-bearing. A package name
 * is a path, and the packages sharing its parent path are its declared
 * neighbourhood; "named alongside these four, clustered with those seven" is
 * checkable by anyone with the repository open, and the edges that pulled it
 * across are cited with file and line.
 *
 * The model may later describe what the two responsibilities appear to be. It
 * never decides that a mismatch exists.
 */

import type { Db } from '../db/database.js';
import { sharedPrefix, type ClusterSummary } from './clusters.js';
import { DEPENDENCY_EDGE_KINDS, type SupportingEdge } from './package-graph.js';

export const RULE = 'intent-mismatch';

/**
 * The name group must have at least this many members. With one, the finding
 * would be about a pair, and a pair disagreeing is as likely to mean the pair
 * is wrong as that the package is (ADR-0014).
 */
const MIN_NAME_GROUP = 2;

/** Edges cited per pulling package, and commits cited per coupled pair. */
const EVIDENCE = 3;

export interface IntentMismatch {
  findingId: number;
  /** The package whose name and edges disagree. */
  fqn: string;
  /** Its parent path — the neighbourhood its name claims. */
  parent: string;
  /** Packages named alongside it that went elsewhere, and where they went. */
  nameGroup: string[];
  /** The cluster the majority of the name group sits in. */
  expectedPrefix: string;
  /**
   * Where it actually landed, named by the prefix its *other* cluster members
   * share. Null when they share none, or when it landed alone.
   *
   * Not the cluster's own label: this package is in that cluster, so it drags
   * the shared prefix up to whatever it has in common with the others —
   * `shop`, when the useful answer is `shop.admin`. The prefix degrades exactly
   * when the mismatch is most interesting, so the finding excludes the package
   * it is about.
   */
  actualPrefix: string | null;
  /** How many packages it landed among. Names the destination when the prefix cannot. */
  actualSize: number;
  /** It grouped with nothing at all, rather than with the wrong group. */
  landedAlone: boolean;
  /** Packages in the actual cluster that this one is connected to. */
  pulledBy: string[];
  severity: 'medium' | 'high';
  unanimous: boolean;
  /** Exactly what was stored, so stdout and the database cannot drift apart. */
  title: string;
  detail: string;
}

/**
 * Find and record mismatches for a run, replacing any from a previous analysis.
 *
 * Runs only when a static graph exists. Without one, "no edge connects them"
 * would be an absence nobody established, which is the failure CLAUDE.md is
 * written against.
 */
export function detectIntentMismatches(
  db: Db,
  runId: number,
  clusters: readonly ClusterSummary[],
): IntentMismatch[] {
  const clusterOf = new Map<string, ClusterSummary>();
  const idOf = new Map<string, number>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      clusterOf.set(member.fqn, cluster);
      idOf.set(member.fqn, member.nodeId);
    }
  }

  // Group packages by parent path. A package with no dot has no declared
  // neighbourhood, so it takes no part.
  const byParent = new Map<string, string[]>();
  for (const fqn of clusterOf.keys()) {
    const cut = fqn.lastIndexOf('.');
    if (cut <= 0) continue;
    const parent = fqn.slice(0, cut);
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(fqn);
    else byParent.set(parent, [fqn]);
  }

  const candidates: IntentMismatch[] = [];
  for (const [parent, siblings] of [...byParent].sort(([a], [b]) => a.localeCompare(b))) {
    for (const fqn of [...siblings].sort()) {
      const nameGroup = siblings.filter((sibling) => sibling !== fqn);
      if (nameGroup.length < MIN_NAME_GROUP) continue;

      const mine = clusterOf.get(fqn) as ClusterSummary;
      const home = strictMajorityCluster(nameGroup, clusterOf);
      if (home === null || home.cluster.clusterId === mine.clusterId) continue;

      const landed = neighbourPrefix(mine, fqn);
      candidates.push({
        findingId: 0,
        fqn,
        parent,
        nameGroup: [...nameGroup].sort(),
        expectedPrefix: home.cluster.prefix,
        actualPrefix: landed.prefix,
        actualSize: landed.size,
        landedAlone: landed.alone,
        pulledBy: [],
        severity: home.unanimous ? 'high' : 'medium',
        unanimous: home.unanimous,
        title: '',
        detail: '',
      });
    }
  }

  return record(db, runId, candidates, clusterOf, idOf);
}

/**
 * The common prefix of a cluster's members other than `exclude`, and whether
 * there were any.
 *
 * A cluster of `shop.admin.{user,role,audit}` plus a stray `shop.billing.report`
 * has the common prefix `shop`, which tells a reader nothing. Dropping the
 * package the finding is about recovers `shop.admin` — the thing it actually
 * landed among.
 *
 * A cluster of one has no neighbours to name. Falling back to the cluster's own
 * label there produced "X is named under P but clusters with X", which is both
 * confusing and vacuous; the honest statement is that it grouped with nothing.
 */
function neighbourPrefix(
  cluster: ClusterSummary,
  exclude: string,
): { prefix: string | null; size: number; alone: boolean } {
  const others = cluster.members
    .map((member) => member.fqn)
    .filter((fqn) => fqn !== exclude);
  return {
    prefix: others.length > 0 ? sharedPrefix(others) : null,
    size: others.length,
    alone: others.length === 0,
  };
}

/**
 * The cluster holding more than half the name group, if there is one.
 *
 * Plurality is deliberately not enough: a group split three ways has no home
 * for the package to have left, and reporting one would be reporting a
 * tie-break (ADR-0014).
 */
function strictMajorityCluster(
  nameGroup: readonly string[],
  clusterOf: Map<string, ClusterSummary>,
): { cluster: ClusterSummary; unanimous: boolean } | null {
  const counts = new Map<number, { cluster: ClusterSummary; count: number }>();
  for (const fqn of nameGroup) {
    const cluster = clusterOf.get(fqn);
    if (cluster === undefined) continue;
    const seen = counts.get(cluster.clusterId);
    if (seen) seen.count += 1;
    else counts.set(cluster.clusterId, { cluster, count: 1 });
  }

  for (const { cluster, count } of counts.values()) {
    if (count * 2 > nameGroup.length) {
      return { cluster, unanimous: count === nameGroup.length };
    }
  }
  return null;
}

/**
 * Resolve every node to its enclosing package, once, into an indexed temp
 * table.
 *
 * The obvious implementation calls `supportingEdges` per (candidate, cluster
 * member) pair, and each of those runs the recursive containment walk over the
 * whole graph again. On dubbo — 47k nodes, a 130-package cluster — that is
 * thousands of full-graph walks and `analyze` does not finish. The walk is the
 * same every time, so it is done once and joined against.
 */
function withPackageIndex<T>(db: Db, runId: number, run: () => T): T {
  db.exec('DROP TABLE IF EXISTS temp.package_of');
  db.exec('DROP TABLE IF EXISTS temp.file_package');
  db.exec(`
    CREATE TEMP TABLE package_of (node_id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL);
    CREATE TEMP TABLE file_package (file_id INTEGER NOT NULL, fqn TEXT NOT NULL);
  `);

  db.prepare(
    /* sql */ `
    INSERT INTO temp.package_of (node_id, package_id)
    WITH RECURSIVE
      ancestry(start_id, node_id, kind) AS (
          SELECT n.id, n.id, n.kind FROM node n WHERE n.run_id = ?
        UNION ALL
          SELECT a.start_id, p.id, p.kind
            FROM ancestry a
            JOIN node c ON c.id = a.node_id
            JOIN node p ON p.id = c.parent_id
           WHERE a.kind <> 'package'
      )
    SELECT a.start_id, a.node_id
      FROM ancestry a JOIN node p ON p.id = a.node_id
     WHERE a.kind = 'package' AND p.is_stub = 0`,
  ).run(runId);

  db.prepare(
    /* sql */ `
    INSERT INTO temp.file_package (file_id, fqn)
    SELECT DISTINCT n.file_id, p.fqn
      FROM node n
      JOIN temp.package_of po ON po.node_id = n.id
      JOIN node p ON p.id = po.package_id
     WHERE n.run_id = ? AND n.file_id IS NOT NULL AND n.is_stub = 0`,
  ).run(runId);

  db.exec(`
    CREATE INDEX temp.package_of_pkg ON package_of (package_id);
    CREATE INDEX temp.file_package_file ON file_package (file_id);
  `);

  try {
    return run();
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.package_of');
    db.exec('DROP TABLE IF EXISTS temp.file_package');
  }
}

function record(
  db: Db,
  runId: number,
  candidates: IntentMismatch[],
  clusterOf: Map<string, ClusterSummary>,
  idOf: Map<string, number>,
): IntentMismatch[] {
  if (candidates.length === 0) return [];
  return withPackageIndex(db, runId, () =>
    recordWithIndex(db, runId, candidates, clusterOf, idOf),
  );
}

function recordWithIndex(
  db: Db,
  runId: number,
  candidates: IntentMismatch[],
  clusterOf: Map<string, ClusterSummary>,
  idOf: Map<string, number>,
): IntentMismatch[] {
  const sharedCommits = db.prepare(
    /* sql */ `
    SELECT c.sha FROM git_commit c
     WHERE c.run_id = @runId AND c.is_merge = 0
       AND EXISTS (SELECT 1 FROM commit_file f
                    WHERE f.commit_id = c.id AND f.canonical_path = @a)
       AND EXISTS (SELECT 1 FROM commit_file f
                    WHERE f.commit_id = c.id AND f.canonical_path = @b)
     ORDER BY c.authored_at DESC
     LIMIT @limit`,
  );

  const write = db.transaction((): IntentMismatch[] => {
    db.prepare('DELETE FROM finding WHERE run_id = ? AND rule = ?').run(runId, RULE);

    const insertFinding = db.prepare(
      `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by, cluster_id)
       VALUES (@runId, @rule, @title, @detail, @severity, 'algorithm', @clusterId)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO citation (finding_id, kind, edge_id, line) VALUES (?, 'edge', ?, ?)`,
    );
    const insertNode = db.prepare(
      `INSERT INTO citation (finding_id, kind, node_id) VALUES (?, 'node', ?)`,
    );
    const insertCommit = db.prepare(
      `INSERT INTO citation (finding_id, kind, commit_sha) VALUES (?, 'commit', ?)`,
    );

    const found: IntentMismatch[] = [];
    for (const candidate of candidates) {
      const mine = clusterOf.get(candidate.fqn) as ClusterSummary;
      const self = idOf.get(candidate.fqn) as number;

      // What in the cluster it landed in is actually connected to it — in one
      // query, both directions, capped per neighbour by the window function.
      const pulls = edgesToClusterMates(db, runId, self, mine, EVIDENCE);

      const coupled = couplingBetween(db, runId, candidate.fqn, mine, EVIDENCE);
      const withPulls: IntentMismatch = {
        ...candidate,
        pulledBy: [...pulls.map((pull) => pull.fqn), ...coupled.map((pair) => pair.fqn)]
          .filter((fqn, at, all) => all.indexOf(fqn) === at)
          .sort(),
      };
      const enriched: IntentMismatch = {
        ...withPulls,
        title: title(withPulls),
        detail: detail(withPulls, pulls, coupled),
      };

      const findingId = Number(
        insertFinding.run({
          runId,
          rule: RULE,
          title: enriched.title,
          detail: enriched.detail,
          severity: enriched.severity,
          clusterId: mine.clusterId,
        }).lastInsertRowid,
      );

      for (const pull of pulls) {
        for (const edge of pull.edges) insertEdge.run(findingId, edge.edgeId, edge.line);
      }
      // The siblings it was named alongside and did not go with.
      for (const sibling of enriched.nameGroup) {
        const nodeId = idOf.get(sibling);
        if (nodeId !== undefined) insertNode.run(findingId, nodeId);
      }
      for (const pair of coupled) {
        for (const row of sharedCommits.all({
          runId,
          a: pair.pathA,
          b: pair.pathB,
          limit: EVIDENCE,
        }) as Array<{ sha: string }>) {
          insertCommit.run(findingId, row.sha);
        }
      }

      found.push({ ...enriched, findingId });
    }
    return found;
  });

  return write();
}

/**
 * Every dependency edge, in either direction, between one package and the rest
 * of its cluster — capped per neighbour rather than in total, so one heavily
 * connected neighbour cannot crowd the others out of the evidence.
 *
 * Requires the temp index built by `withPackageIndex`.
 */
function edgesToClusterMates(
  db: Db,
  runId: number,
  self: number,
  cluster: ClusterSummary,
  perMate: number,
): Array<{ fqn: string; edges: SupportingEdge[] }> {
  const mates = cluster.members
    .filter((member) => member.nodeId !== self)
    .map((member) => member.nodeId);
  if (mates.length === 0) return [];

  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const placeholders = mates.map(() => '?').join(', ');

  const rows = db
    .prepare(
      /* sql */ `
      SELECT edgeId, kind, srcFqn, dstFqn, path, line, otherId FROM (
        SELECT e.id AS edgeId, e.kind AS kind, sn.fqn AS srcFqn, dn.fqn AS dstFqn,
               f.path AS path, e.line AS line,
               CASE WHEN sp.package_id = ? THEN dp.package_id ELSE sp.package_id END AS otherId,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN sp.package_id = ? THEN dp.package_id ELSE sp.package_id END
                 ORDER BY e.id
               ) AS rn
          FROM edge e
          JOIN temp.package_of sp ON sp.node_id = e.src_id
          JOIN temp.package_of dp ON dp.node_id = e.dst_id
          JOIN node sn ON sn.id = e.src_id
          JOIN node dn ON dn.id = e.dst_id
          LEFT JOIN source_file f ON f.id = e.file_id
         WHERE e.run_id = ?
           AND e.kind IN (${kinds})
           AND e.confidence = 'fact'
           AND sp.package_id <> dp.package_id
           AND ((sp.package_id = ? AND dp.package_id IN (${placeholders}))
             OR (dp.package_id = ? AND sp.package_id IN (${placeholders})))
      ) WHERE rn <= ?
      ORDER BY otherId, edgeId`,
    )
    .all(self, self, runId, self, ...mates, self, ...mates, perMate) as Array<
    SupportingEdge & { otherId: number }
  >;

  const fqnOf = new Map(cluster.members.map((member) => [member.nodeId, member.fqn]));
  const byMate = new Map<string, SupportingEdge[]>();
  for (const row of rows) {
    const fqn = fqnOf.get(row.otherId);
    if (fqn === undefined) continue;
    const edges = byMate.get(fqn);
    if (edges) edges.push(row);
    else byMate.set(fqn, [row]);
  }

  return [...byMate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fqn, edges]) => ({ fqn, edges }));
}

interface CoupledPull {
  fqn: string;
  pathA: string;
  pathB: string;
  strength: number;
}

/**
 * Coupling pairs joining this package's files to files in the rest of its
 * cluster. When a package was pulled across by history rather than by code,
 * this is the evidence that says so.
 */
function couplingBetween(
  db: Db,
  runId: number,
  fqn: string,
  cluster: ClusterSummary,
  limit: number,
): CoupledPull[] {
  const others = cluster.members.map((member) => member.fqn).filter((other) => other !== fqn);
  if (others.length === 0) return [];

  const placeholders = others.map(() => '?').join(', ');
  return db
    .prepare(
      /* sql */ `
      SELECT tc.path_a AS pathA, tc.path_b AS pathB, tc.strength AS strength,
             CASE WHEN ka.fqn = ? THEN kb.fqn ELSE ka.fqn END AS fqn
        FROM temporal_coupling tc
        JOIN source_file fa ON fa.run_id = tc.run_id AND fa.path = tc.path_a
        JOIN source_file fb ON fb.run_id = tc.run_id AND fb.path = tc.path_b
        JOIN temp.file_package ka ON ka.file_id = fa.id
        JOIN temp.file_package kb ON kb.file_id = fb.id
       WHERE tc.run_id = ?
         AND ((ka.fqn = ? AND kb.fqn IN (${placeholders}))
           OR (kb.fqn = ? AND ka.fqn IN (${placeholders})))
       ORDER BY tc.strength DESC, tc.path_a, tc.path_b
       LIMIT ?`,
    )
    .all(fqn, runId, fqn, ...others, fqn, ...others, limit) as CoupledPull[];
}

/**
 * Three shapes, because one sentence cannot carry all of them honestly.
 *
 * The package landed alone, landed with the very package its name sits under,
 * or landed with some other group. Petclinic produced the first two on the
 * first real run, and the single-sentence version rendered them as
 * "X is named under P but clusters with X" — vacuous — and
 * "X is named under P but clusters with P" — which reads like a contradiction
 * rather than the real claim, that it went with its parent instead of its
 * siblings.
 */
function title(mismatch: IntentMismatch): string {
  return `${mismatch.fqn} is named under ${mismatch.parent} but ${landedPhrase(mismatch)}`;
}

/**
 * How to name where it went.
 *
 * Four cases, because collapsing them produced three separate nonsenses on the
 * first real runs: "X groups with X" for a package alone in its cluster, "named
 * under P but groups with P" for one that went with its own parent, and — the
 * worst — "groups with com.alibaba.dubbo.config.spring.context.annotation" for
 * a destination cluster whose members share no prefix at all, where that string
 * was just the alphabetically first member standing in for a group it does not
 * describe.
 */
function landedPhrase(mismatch: IntentMismatch): string {
  if (mismatch.landedAlone) return 'groups with nothing';
  if (mismatch.actualPrefix === null) {
    return `groups with ${mismatch.actualSize} packages that share no common prefix`;
  }
  if (mismatch.actualPrefix === mismatch.parent) {
    return `groups with ${mismatch.parent} itself rather than with the packages named alongside it`;
  }
  return `groups with ${mismatch.actualPrefix}`;
}

/** The same four cases, as a sentence for the detail body. */
function landedSentence(mismatch: IntentMismatch): string {
  if (mismatch.landedAlone) return 'This one is in a group of its own.';
  if (mismatch.actualPrefix === null) {
    return `This one sits with ${mismatch.actualSize} packages that share no common prefix.`;
  }
  if (mismatch.actualPrefix === mismatch.parent) {
    return `This one sits with ${mismatch.parent} itself instead.`;
  }
  return `This one sits with ${mismatch.actualPrefix} instead.`;
}

function detail(
  mismatch: IntentMismatch,
  pulls: ReadonlyArray<{ fqn: string; edges: SupportingEdge[] }>,
  coupled: readonly CoupledPull[],
): string {
  const lines = [
    `  ${mismatch.unanimous ? 'All' : 'A majority'} of the ${mismatch.nameGroup.length} ` +
      `packages named under ${mismatch.parent} sit in ${mismatch.expectedPrefix}: ` +
      `${mismatch.nameGroup.join(', ')}.`,
    `  ${landedSentence(mismatch)}`,
  ];

  if (pulls.length === 0 && coupled.length === 0) {
    lines.push(
      `  Nothing connects it to ${mismatch.landedAlone ? 'anything else' : 'the rest of its group'}: ` +
        `no import, call, inheritance or injection, and no co-change. The static graph was ` +
        `built for this run, so that is an absence we looked for, not one we assumed.`,
    );
    return lines.join('\n');
  }

  for (const pull of pulls) {
    const where = pull.edges
      .map((edge) => `${edge.kind} ${edge.srcFqn} → ${edge.dstFqn}${at(edge)}`)
      .join('; ');
    lines.push(`  connected to ${pull.fqn}: ${where}`);
  }
  for (const pair of coupled) {
    lines.push(
      `  changes with ${pair.fqn}: ${pair.pathA} and ${pair.pathB}, ` +
        `strength ${pair.strength.toFixed(2)}`,
    );
  }
  // Clustering is a partition of a weighted graph, so which edges "caused" the
  // placement is not a question the algorithm answers. These are the edges that
  // exist, which is what can be checked.
  lines.push(`  Cluster membership follows from the whole graph, not from any one edge.`);
  return lines.join('\n');
}

function at(edge: SupportingEdge): string {
  if (!edge.path) return '';
  return edge.line === null ? ` (${edge.path})` : ` (${edge.path}:${edge.line})`;
}
