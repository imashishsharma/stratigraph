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
import { commonPrefix, type ClusterSummary } from './clusters.js';
import { supportingEdges, type SupportingEdge } from './package-graph.js';

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
   * Where it actually landed, named by the common prefix of its *other* cluster
   * members.
   *
   * Not the cluster's own label: this package is in that cluster, so it drags
   * the shared prefix up to whatever it has in common with the others —
   * `shop`, when the useful answer is `shop.admin`. The prefix degrades exactly
   * when the mismatch is most interesting, so the finding excludes the package
   * it is about.
   */
  actualPrefix: string;
  /** Packages in the actual cluster that this one is connected to. */
  pulledBy: string[];
  severity: 'medium' | 'high';
  unanimous: boolean;
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

      candidates.push({
        findingId: 0,
        fqn,
        parent,
        nameGroup: [...nameGroup].sort(),
        expectedPrefix: home.cluster.prefix,
        actualPrefix: neighbourPrefix(mine, fqn),
        pulledBy: [],
        severity: home.unanimous ? 'high' : 'medium',
        unanimous: home.unanimous,
      });
    }
  }

  return record(db, runId, candidates, clusterOf, idOf);
}

/**
 * The common prefix of a cluster's members other than `exclude`.
 *
 * A cluster of `shop.admin.{user,role,audit}` plus a stray `shop.billing.report`
 * has the common prefix `shop`, which tells a reader nothing. Dropping the
 * package the finding is about recovers `shop.admin` — the thing it actually
 * landed among. A cluster of one leaves nothing to name, so its own label
 * stands in.
 */
function neighbourPrefix(cluster: ClusterSummary, exclude: string): string {
  const others = cluster.members
    .map((member) => member.fqn)
    .filter((fqn) => fqn !== exclude);
  return others.length > 0 ? commonPrefix(others) : cluster.prefix;
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

function record(
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

      // What in the cluster it landed in is actually connected to it.
      const pulls: Array<{ fqn: string; edges: SupportingEdge[] }> = [];
      for (const member of mine.members) {
        if (member.fqn === candidate.fqn) continue;
        const edges = [
          ...supportingEdges(db, runId, self, member.nodeId, EVIDENCE),
          ...supportingEdges(db, runId, member.nodeId, self, EVIDENCE),
        ].slice(0, EVIDENCE);
        if (edges.length > 0) pulls.push({ fqn: member.fqn, edges });
      }

      const coupled = couplingBetween(db, runId, candidate.fqn, mine, EVIDENCE);
      const enriched: IntentMismatch = {
        ...candidate,
        pulledBy: [...pulls.map((pull) => pull.fqn), ...coupled.map((pair) => pair.fqn)]
          .filter((fqn, at, all) => all.indexOf(fqn) === at)
          .sort(),
      };

      const findingId = Number(
        insertFinding.run({
          runId,
          rule: RULE,
          title: title(enriched),
          detail: detail(enriched, pulls, coupled),
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
      WITH RECURSIVE
        ancestry(file_id, node_id, kind) AS (
            SELECT n.file_id, n.id, n.kind FROM node n
             WHERE n.run_id = ? AND n.file_id IS NOT NULL AND n.is_stub = 0
               AND n.kind IN ('class', 'interface', 'enum', 'annotation')
          UNION ALL
            SELECT a.file_id, p.id, p.kind
              FROM ancestry a
              JOIN node c ON c.id = a.node_id
              JOIN node p ON p.id = c.parent_id
             WHERE a.kind <> 'package'
        ),
        file_package(file_id, fqn) AS (
          SELECT DISTINCT a.file_id, p.fqn
            FROM ancestry a JOIN node p ON p.id = a.node_id
           WHERE a.kind = 'package' AND p.is_stub = 0
        )
      SELECT tc.path_a AS pathA, tc.path_b AS pathB, tc.strength AS strength,
             CASE WHEN ka.fqn = ? THEN kb.fqn ELSE ka.fqn END AS fqn
        FROM temporal_coupling tc
        JOIN source_file fa ON fa.run_id = tc.run_id AND fa.path = tc.path_a
        JOIN source_file fb ON fb.run_id = tc.run_id AND fb.path = tc.path_b
        JOIN file_package ka ON ka.file_id = fa.id
        JOIN file_package kb ON kb.file_id = fb.id
       WHERE tc.run_id = ?
         AND ((ka.fqn = ? AND kb.fqn IN (${placeholders}))
           OR (kb.fqn = ? AND ka.fqn IN (${placeholders})))
       ORDER BY tc.strength DESC, tc.path_a, tc.path_b
       LIMIT ?`,
    )
    .all(runId, fqn, runId, fqn, ...others, fqn, ...others, limit) as CoupledPull[];
}

function title(mismatch: IntentMismatch): string {
  return (
    `${mismatch.fqn} is named under ${mismatch.parent} but clusters with ` +
    `${mismatch.actualPrefix}`
  );
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
    `  This one sits in ${mismatch.actualPrefix} instead.`,
  ];

  if (pulls.length === 0 && coupled.length === 0) {
    lines.push(
      `  Nothing connects it to the rest of its cluster: no import, call, inheritance ` +
        `or injection, and no co-change. The static graph was built for this run, so ` +
        `that is an absence we looked for, not one we assumed.`,
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
