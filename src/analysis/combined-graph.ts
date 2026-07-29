/**
 * The combined graph: one undirected weighted graph over packages, built from
 * layer 2 (what the code says) and layer 3 (what the history says).
 *
 * Nothing here is a new fact. A static edge is a count of observed source-level
 * edges, projected up the containment tree exactly as `package-graph.ts` does
 * it; a temporal edge is a `temporal_coupling` row, whose two file paths are
 * resolved to the packages those files declare types in. Both are recomputed on
 * demand rather than stored, for ADR-0008's reason: a stored projection is a
 * cache that goes stale whenever the facts under it change.
 *
 * The weighting, and why the two families have to be normalised before they can
 * be added at all, is ADR-0012.
 */

import type { Db } from '../db/database.js';
import type { GraphNode, WeightedEdge, WeightedGraph } from './louvain.js';
import { buildPackageGraph, type PackageGraph } from './package-graph.js';

export interface CombinedGraphOptions {
  /**
   * What one unit of normalised co-change weighs against one unit of
   * normalised structural dependency. At 0 the graph is exactly the static one,
   * which is what makes this knob's effect testable rather than a matter of
   * opinion.
   */
  couplingWeight: number;
}

export interface CombinedGraphStats {
  packages: number;
  /** Package pairs with a structural dependency in either direction. */
  staticPairs: number;
  /** Package pairs joined by co-change. */
  temporalPairs: number;
  /** Coupling rows stored for this run. */
  couplingRows: number;
  /**
   * Coupling rows that placed into two different packages.
   *
   * The remainder are rows naming a file no extractor walked — XML, SQL,
   * properties — or two files in the same package. Neither is discarded
   * silently: the difference is reported, because a run where most of the
   * history could not be placed must not read like one with little coupling.
   */
  couplingRowsPlaced: number;
  /** Largest observed reference count on a package pair, before scaling. */
  maxReferences: number;
  /** Largest observed summed coupling strength on a package pair. */
  maxCoupling: number;
}

export interface CombinedGraph extends WeightedGraph {
  stats: CombinedGraphStats;
  /** The underlying static graph, so callers do not build it twice. */
  packageGraph: PackageGraph;
}

/**
 * Resolve each source file to the package of the types it declares.
 *
 * Seeded from type declarations rather than from every node with a file: a
 * method's package is its class's package, so starting at methods and fields
 * would walk the same chains again for no new answer. A file no extractor
 * walked has no `source_file` row at all and so appears nowhere here — which is
 * the point. We did not observe what package it belongs to, and deriving one
 * from its path string would be structure nobody reported.
 */
const PACKAGE_OF_FILE = /* sql */ `
  WITH RECURSIVE
    ancestry(file_id, node_id, kind) AS (
        SELECT n.file_id, n.id, n.kind
          FROM node n
         WHERE n.run_id = @runId
           AND n.file_id IS NOT NULL
           AND n.is_stub = 0
           AND n.kind IN ('class', 'interface', 'enum', 'annotation')
      UNION ALL
        SELECT a.file_id, p.id, p.kind
          FROM ancestry a
          JOIN node c ON c.id = a.node_id
          JOIN node p ON p.id = c.parent_id
         WHERE a.kind <> 'package'
    ),
    package_of_file(file_id, package_id) AS (
      SELECT DISTINCT a.file_id, a.node_id
        FROM ancestry a JOIN node p ON p.id = a.node_id
       WHERE a.kind = 'package' AND p.is_stub = 0
    )
`;

/** The join from a coupling row to the two packages its files sit in. */
const PLACED_COUPLING = /* sql */ `
    FROM temporal_coupling tc
    JOIN source_file fa ON fa.run_id = tc.run_id AND fa.path = tc.path_a
    JOIN source_file fb ON fb.run_id = tc.run_id AND fb.path = tc.path_b
    JOIN package_of_file pa ON pa.file_id = fa.id
    JOIN package_of_file pb ON pb.file_id = fb.id
   WHERE tc.run_id = @runId
     AND pa.package_id <> pb.package_id
`;

export function buildCombinedGraph(
  db: Db,
  runId: number,
  options: CombinedGraphOptions,
): CombinedGraph {
  const packageGraph = buildPackageGraph(db, runId);

  const nodes: GraphNode[] = [...packageGraph.packages.values()].map((pkg) => ({
    id: pkg.id,
    key: pkg.fqn,
  }));

  // Fold the directed package dependencies into undirected pairs. A cycle is a
  // directed finding (ADR-0008); a community is not.
  const references = new Map<string, number>();
  for (const dependency of packageGraph.dependencies) {
    add(references, pairKey(dependency.src, dependency.dst), dependency.weight);
  }

  const coupling = new Map<string, number>();
  const placed = temporalPairs(db, runId);
  for (const row of placed.rows) {
    add(coupling, pairKey(row.a, row.b), row.strength);
  }

  const maxReferences = largest(references);
  const maxCoupling = largest(coupling);

  // Each family is scaled into 0..1 before the two are added, because a
  // reference count and a co-change strength are not the same unit and adding
  // them raw would let the static half decide everything (ADR-0012).
  const staticScale = maxReferences > 0 ? Math.log1p(maxReferences) : 0;
  const weights = new Map<string, number>();
  for (const [key, count] of references) {
    if (staticScale > 0) add(weights, key, Math.log1p(count) / staticScale);
  }
  if (options.couplingWeight > 0 && maxCoupling > 0) {
    for (const [key, strength] of coupling) {
      add(weights, key, (options.couplingWeight * strength) / maxCoupling);
    }
  }

  const edges: WeightedEdge[] = [...weights].map(([key, weight]) => {
    const [a, b] = key.split(':');
    return { a: Number(a), b: Number(b), weight };
  });

  return {
    nodes,
    edges,
    packageGraph,
    stats: {
      packages: nodes.length,
      staticPairs: references.size,
      temporalPairs: coupling.size,
      couplingRows: countCouplingRows(db, runId),
      couplingRowsPlaced: placed.rowsPlaced,
      maxReferences,
      maxCoupling,
    },
  };
}

function temporalPairs(
  db: Db,
  runId: number,
): { rows: Array<{ a: number; b: number; strength: number }>; rowsPlaced: number } {
  const rows = db
    .prepare(
      PACKAGE_OF_FILE +
        /* sql */ `
        SELECT pa.package_id AS a,
               pb.package_id AS b,
               SUM(tc.strength) AS strength
        ${PLACED_COUPLING}
        GROUP BY pa.package_id, pb.package_id`,
    )
    .all({ runId }) as Array<{ a: number; b: number; strength: number }>;

  const rowsPlaced = (
    db
      .prepare(
        PACKAGE_OF_FILE + /* sql */ ` SELECT COUNT(DISTINCT tc.id) AS n ${PLACED_COUPLING}`,
      )
      .get({ runId }) as { n: number }
  ).n;

  return { rows, rowsPlaced };
}

function countCouplingRows(db: Db, runId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM temporal_coupling WHERE run_id = ?').get(runId) as {
      n: number;
    }
  ).n;
}

/** Unordered pair key, so `a → b` and `b → a` land in the same bucket. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function add(into: Map<string, number>, key: string, value: number): void {
  into.set(key, (into.get(key) ?? 0) + value);
}

function largest(values: Map<string, number>): number {
  let max = 0;
  for (const value of values.values()) if (value > max) max = value;
  return max;
}
