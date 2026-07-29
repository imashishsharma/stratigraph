/**
 * Package clusters: run the combined graph through Louvain and record the
 * partition.
 *
 * A cluster is not a fact — it is the output of an algorithm run over a
 * projection of the facts — so it lands in the layer-4 `cluster` table with
 * `authored_by = 'algorithm'`, alongside the findings. See ADR-0012.
 *
 * `cluster.name` and `cluster.description` stay NULL here. Those are the
 * model's to write (ADR-0013), and the report has to be useful without them,
 * so each cluster also carries a derived label: the longest package prefix its
 * members share. That label is a pure function of the membership and is
 * computed on read rather than stored, for the same reason the package graph is
 * not stored (ADR-0008).
 */

import type { Db } from '../db/database.js';
import {
  buildCombinedGraph,
  type CombinedGraphStats,
  type CombinedGraphOptions,
} from './combined-graph.js';
import { louvain } from './louvain.js';

export const ALGORITHM = 'louvain';

export interface ClusterMember {
  nodeId: number;
  fqn: string;
}

export interface ClusterSummary {
  clusterId: number;
  /** Community index within the run, numbered by lowest member fqn. */
  label: number;
  /**
   * The longest package prefix every member shares, or — when they share
   * nothing — the alphabetically first member's fqn. Derived, not authored:
   * it says where the cluster sits, never what it is for.
   */
  prefix: string;
  members: ClusterMember[];
  /** Model-authored. Null until the interpretation layer fills it in. */
  name: string | null;
  description: string | null;
}

export interface ClusterResult {
  algorithm: string;
  clusters: ClusterSummary[];
  modularity: number;
  /** Clusters of exactly one package. Kept in the store, collapsed in reports. */
  singletons: number;
  stats: CombinedGraphStats;
}

/**
 * Partition a run's packages, replacing any partition from a previous analysis.
 *
 * Idempotent for the same facts and the same `couplingWeight`: Louvain here has
 * no random order (ADR-0012), so re-running produces the same clusters with the
 * same numbering. Members cascade on delete.
 */
export function detectClusters(
  db: Db,
  runId: number,
  options: CombinedGraphOptions,
): ClusterResult {
  const graph = buildCombinedGraph(db, runId, options);
  const fqn = new Map(graph.nodes.map((node) => [node.id, node.key]));
  const partition = louvain(graph);

  const write = db.transaction((): ClusterSummary[] => {
    db.prepare('DELETE FROM cluster WHERE run_id = ? AND algorithm = ?').run(runId, ALGORITHM);

    const insertCluster = db.prepare(
      `INSERT INTO cluster (run_id, algorithm, label, authored_by)
       VALUES (?, ?, ?, 'algorithm')`,
    );
    const insertMember = db.prepare(
      'INSERT INTO cluster_member (cluster_id, node_id) VALUES (?, ?)',
    );

    return partition.communities.map((nodeIds, label) => {
      const clusterId = Number(insertCluster.run(runId, ALGORITHM, label).lastInsertRowid);
      for (const nodeId of nodeIds) insertMember.run(clusterId, nodeId);

      const members = nodeIds
        .map((nodeId) => ({ nodeId, fqn: fqn.get(nodeId) ?? '<unknown>' }))
        .sort((a, b) => a.fqn.localeCompare(b.fqn));

      return {
        clusterId,
        label,
        prefix: commonPrefix(members.map((member) => member.fqn)),
        members,
        name: null,
        description: null,
      };
    });
  });

  const clusters = write();

  return {
    algorithm: ALGORITHM,
    clusters,
    modularity: partition.modularity,
    singletons: clusters.filter((cluster) => cluster.members.length === 1).length,
    stats: graph.stats,
  };
}

/** Read back a run's clusters, including anything the model has since written. */
export function loadClusters(db: Db, runId: number): ClusterSummary[] {
  const rows = db
    .prepare(
      `SELECT id, label, name, description FROM cluster
        WHERE run_id = ? AND algorithm = ? ORDER BY label`,
    )
    .all(runId, ALGORITHM) as Array<{
    id: number;
    label: number;
    name: string | null;
    description: string | null;
  }>;

  const memberRows = db
    .prepare(
      `SELECT m.cluster_id AS clusterId, m.node_id AS nodeId, n.fqn AS fqn
         FROM cluster_member m
         JOIN cluster c ON c.id = m.cluster_id
         JOIN node n ON n.id = m.node_id
        WHERE c.run_id = ? AND c.algorithm = ?
        ORDER BY n.fqn`,
    )
    .all(runId, ALGORITHM) as Array<{ clusterId: number; nodeId: number; fqn: string }>;

  const byCluster = new Map<number, ClusterMember[]>();
  for (const row of memberRows) {
    const members = byCluster.get(row.clusterId);
    if (members) members.push({ nodeId: row.nodeId, fqn: row.fqn });
    else byCluster.set(row.clusterId, [{ nodeId: row.nodeId, fqn: row.fqn }]);
  }

  return rows.map((row) => {
    const members = byCluster.get(row.id) ?? [];
    return {
      clusterId: row.id,
      label: row.label,
      prefix: commonPrefix(members.map((member) => member.fqn)),
      members,
      name: row.name,
      description: row.description,
    };
  });
}

/**
 * The longest dot-separated prefix every fqn shares, or null when they share
 * none.
 *
 * Segment-wise rather than character-wise, so `com.foo.billing` and
 * `com.foo.billfold` share `com.foo` and not `com.foo.bill` — the latter is not
 * a package and naming a cluster after it would be asserting a package that
 * does not exist.
 *
 * Null rather than a fallback, because callers need to tell the two apart. A
 * cluster of `com.alibaba.dubbo.config.spring` and `org.apache.dubbo.config`
 * shares nothing, and a caller that quietly substitutes one member's name for
 * the group implies a coherent destination that is not there. Dubbo produced
 * exactly that, in a finding title.
 */
export function sharedPrefix(fqns: readonly string[]): string | null {
  const first = fqns[0];
  if (first === undefined) return null;
  if (fqns.length === 1) return first;

  let shared = first.split('.');
  for (const fqn of fqns.slice(1)) {
    const segments = fqn.split('.');
    let at = 0;
    while (at < shared.length && at < segments.length && shared[at] === segments[at]) at += 1;
    shared = shared.slice(0, at);
    if (shared.length === 0) return null;
  }

  return shared.join('.');
}

/**
 * A label for a group of packages, for places that need a string.
 *
 * Falls back to the alphabetically first member when nothing is shared — true
 * of the group, and adequate as a list heading where the members are printed
 * directly underneath. Anywhere the label has to carry the claim on its own,
 * use `sharedPrefix` and handle the null.
 */
export function commonPrefix(fqns: readonly string[]): string {
  return sharedPrefix(fqns) ?? ([...fqns].sort()[0] ?? '');
}
