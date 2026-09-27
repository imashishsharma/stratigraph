/**
 * The package-level dependency graph, aggregated from the class- and
 * method-level edges an extractor emitted.
 *
 * Nothing here is a new fact. Every package edge is a count of observed
 * source-level edges, and each one can be traced back to the `edge` rows that
 * produced it — which is what makes a cycle finding citable.
 */

import type { Db } from '../db/database.js';
import type { EdgeKind } from '../facts/types.js';

/**
 * Edge kinds that mean "code in A depends on code in B".
 *
 * `annotated_with` is deliberately absent: using an annotation requires
 * importing it, so `imports` already carries that dependency, and counting both
 * would double-weight every annotated class. `handles`, `maps_to`,
 * `reads_table` and `http_calls` are absent because their targets are endpoints
 * and tables, which live in no package.
 */
export const DEPENDENCY_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'calls',
  'extends',
  'implements',
  'injects',
];

export interface PackageRef {
  id: number;
  fqn: string;
}

export interface PackageDependency {
  src: number;
  dst: number;
  /** Sum of the underlying edge weights, i.e. how many observed references. */
  weight: number;
}

export interface PackageGraph {
  packages: Map<number, PackageRef>;
  dependencies: PackageDependency[];
  /** Adjacency, for the SCC pass. */
  adjacency: Map<number, number[]>;
}

/**
 * SQL: true when the node `alias` was declared in a file whose role is `test`
 * (ADR-0030). Test code is real code and its facts stay in the store; it is
 * left out of every aggregate that describes the system's structure
 * (ADR-0034), because a test depending on everything it tests would otherwise
 * draw arrows the running system does not have.
 */
export function declaredInTest(alias: string): string {
  return /* sql */ `EXISTS (
    SELECT 1 FROM source_file tf
      JOIN file_role tr ON tr.run_id = tf.run_id AND tr.path = tf.path AND tr.role = 'test'
     WHERE tf.id = ${alias}.file_id)`;
}

/**
 * SQL: true for a package that declares at least one type, all of them test
 * code. A package mixing main and test types is a main package; one declaring
 * no types at all is kept, since nothing says it is test code.
 */
export function testOnlyPackage(alias: string): string {
  return /* sql */ `(
    EXISTS (SELECT 1 FROM node tt WHERE tt.parent_id = ${alias}.id
             AND tt.kind IN ('class','interface','enum','annotation') AND tt.is_stub = 0)
    AND NOT EXISTS (SELECT 1 FROM node tt WHERE tt.parent_id = ${alias}.id
             AND tt.kind IN ('class','interface','enum','annotation') AND tt.is_stub = 0
             AND NOT ${declaredInTest('tt')}))`;
}

/** Node kinds that own other nodes, and that an edge can therefore be lifted to. */
export type AncestorKind = 'package' | 'module';

/**
 * A CTE resolving each node on a matching edge to its enclosing node of `kind`,
 * by walking `parent_id` upwards. Exposes one relation:
 * `ancestor_of(node_id, ancestor_id)`.
 *
 * Recursive rather than a fixed number of joins because nesting has no fixed
 * depth: a method of a nested class of a nested class is four hops from its
 * package, and one more from its module. Seeded from the nodes that actually
 * appear on an edge, so the walk is over the interesting nodes rather than
 * every method in the repository.
 *
 * Third-party targets fall out here for free. `SqliteFactWriter` creates stubs
 * with no parent, so a call into a jar we never parsed resolves to no package
 * and contributes nothing — which is correct. We do not know what is in that
 * jar, and deriving a package name from the string would be inventing structure
 * we did not observe.
 *
 * `confidence` is a parameter rather than a constant because the two callers
 * want different things and both are right: the package graph takes facts only,
 * so no cycle can be assembled out of a guess, while the container diagram
 * (ADR-0019) draws inferred cross-stack calls too — dashed, and labelled as
 * inference.
 *
 * The interpolated values are a closed set of literals from this file and from
 * `EdgeKind`; nothing here is reachable from user input.
 */
export function ancestorOfCte(
  kind: AncestorKind,
  edgeKinds: readonly EdgeKind[],
  confidence: 'fact' | 'any',
): string {
  const kinds = edgeKinds.map((k) => `'${k}'`).join(', ');
  const factsOnly = confidence === 'fact' ? `AND confidence = 'fact'` : '';
  const seed = /* sql */ `
    endpoint_node(id) AS (
      SELECT src_id FROM edge WHERE run_id = @runId AND kind IN (${kinds}) ${factsOnly}
      UNION
      SELECT dst_id FROM edge WHERE run_id = @runId AND kind IN (${kinds}) ${factsOnly}
    ),`;
  if (kind === 'module') return `WITH RECURSIVE ${seed}${moduleAncestry('endpoint_node')}`;
  return /* sql */ `
  WITH RECURSIVE ${seed}
    ancestry(start_id, node_id, kind) AS (
        SELECT e.id, n.id, n.kind
          FROM endpoint_node e JOIN node n ON n.id = e.id
         WHERE NOT ${declaredInTest('n')}
      UNION ALL
        SELECT a.start_id, p.id, p.kind
          FROM ancestry a
          JOIN node c ON c.id = a.node_id
          JOIN node p ON p.id = c.parent_id
         WHERE a.kind <> '${kind}'
    ),
    ancestor_of(node_id, ancestor_id) AS (
      SELECT a.start_id, a.node_id
        FROM ancestry a JOIN node p ON p.id = a.node_id
       WHERE a.kind = '${kind}' AND p.is_stub = 0
    )
`;
}

/**
 * SQL: the module a node declared in `pkg` belongs to (ADR-0041).
 *
 * A package declared in one module has that module as its `parent`. A split
 * package has a `contains` edge from each module declaring it, and a node in
 * it belongs to the one whose `root` is the nearest directory above the node's
 * file — the nearest-root rule the extractor used to pick the module in the
 * first place. A node with no file (the package itself, as the source of a
 * TypeScript `imports` edge) falls back to `parent`.
 */
export function moduleOfNodeInPackage(nodeAlias: string, pkgAlias: string): string {
  return /* sql */ `COALESCE(
    (SELECT c.src_id
       FROM edge c
       JOIN node m ON m.id = c.src_id AND m.kind = 'module'
       JOIN source_file f ON f.id = ${nodeAlias}.file_id
      WHERE c.run_id = ${pkgAlias}.run_id AND c.kind = 'contains' AND c.dst_id = ${pkgAlias}.id
        AND ${underRoot('f.path', `json_extract(m.attrs, '$.root')`)}
      ORDER BY length(json_extract(m.attrs, '$.root')) DESC
      LIMIT 1),
    ${pkgAlias}.parent_id)`;
}

/**
 * SQL: true when package `pkgAlias` belongs to the module whose id is `moduleExpr`
 * — by a `contains` edge when it is split, by `parent` when it is not.
 */
export function packageInModule(pkgAlias: string, moduleExpr: string): string {
  return /* sql */ `(
    EXISTS (SELECT 1 FROM edge c WHERE c.run_id = ${pkgAlias}.run_id AND c.kind = 'contains'
             AND c.dst_id = ${pkgAlias}.id AND c.src_id = ${moduleExpr})
    OR (${pkgAlias}.parent_id = ${moduleExpr}
        AND NOT EXISTS (SELECT 1 FROM edge c WHERE c.run_id = ${pkgAlias}.run_id
                         AND c.kind = 'contains' AND c.dst_id = ${pkgAlias}.id)))`;
}

/** SQL: `path` lies under the module directory `root` (`.` is the repository). */
function underRoot(path: string, root: string): string {
  return `(${root} = '.' OR substr(${path}, 1, length(${root}) + 1) = ${root} || '/')`;
}

/**
 * The CTE body resolving every node in relation `seed(id)` to its module,
 * exposing `ancestor_of(node_id, ancestor_id)`. Test code is left out, as for
 * packages (ADR-0034).
 */
export function moduleAncestry(seed: string): string {
  return /* sql */ `
    ancestry(start_id, node_id, kind) AS (
        SELECT e.id, n.id, n.kind
          FROM ${seed} e JOIN node n ON n.id = e.id
         WHERE NOT ${declaredInTest('n')}
      UNION ALL
        SELECT a.start_id, p.id, p.kind
          FROM ancestry a
          JOIN node c ON c.id = a.node_id
          JOIN node p ON p.id = c.parent_id
         WHERE a.kind NOT IN ('package', 'module')
    ),
    module_candidate(node_id, ancestor_id) AS (
        SELECT a.start_id, ${moduleOfNodeInPackage('s', 'pkg')}
          FROM ancestry a
          JOIN node pkg ON pkg.id = a.node_id
          JOIN node s   ON s.id = a.start_id
         WHERE a.kind = 'package'
      UNION ALL
        SELECT a.start_id, a.node_id FROM ancestry a WHERE a.kind = 'module'
    ),
    ancestor_of(node_id, ancestor_id) AS (
      SELECT mc.node_id, mc.ancestor_id
        FROM module_candidate mc JOIN node p ON p.id = mc.ancestor_id
       WHERE p.kind = 'module' AND p.is_stub = 0
    )
`;
}

/**
 * Build the package graph for a run.
 *
 * Only `confidence = 'fact'` edges take part. A cycle assembled partly from
 * inferred edges is itself an inference, and this analysis reports its output
 * as observed structure.
 */
export function buildPackageGraph(db: Db, runId: number): PackageGraph {
  const kinds = DEPENDENCY_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const rows = db
    .prepare(
      ancestorOfCte('package', DEPENDENCY_EDGE_KINDS, 'fact') +
        /* sql */ `
        SELECT sp.ancestor_id AS src,
               dp.ancestor_id AS dst,
               SUM(e.weight)  AS weight
          FROM edge e
          JOIN ancestor_of sp ON sp.node_id = e.src_id
          JOIN ancestor_of dp ON dp.node_id = e.dst_id
         WHERE e.run_id = @runId
           AND e.kind IN (${kinds})
           AND e.confidence = 'fact'
           AND sp.ancestor_id <> dp.ancestor_id
         GROUP BY sp.ancestor_id, dp.ancestor_id`,
    )
    .all({ runId }) as Array<{ src: number; dst: number; weight: number }>;

  const packages = new Map<number, PackageRef>();
  for (const row of db
    .prepare(
      `SELECT id, fqn FROM node pkg
        WHERE run_id = ? AND kind = 'package' AND is_stub = 0 AND NOT ${testOnlyPackage('pkg')}`,
    )
    .all(runId) as Array<{ id: number; fqn: string }>) {
    packages.set(row.id, row);
  }

  const adjacency = new Map<number, number[]>();
  for (const row of rows) {
    const existing = adjacency.get(row.src);
    if (existing) existing.push(row.dst);
    else adjacency.set(row.src, [row.dst]);
  }

  return { packages, dependencies: rows, adjacency };
}

export interface SupportingEdge {
  edgeId: number;
  kind: string;
  srcFqn: string;
  dstFqn: string;
  path: string | null;
  line: number | null;
}

/**
 * The source-level edges that put `srcPackage` → `dstPackage` in the graph.
 *
 * This is the evidence half of a cycle finding: without it a report can say
 * two packages depend on each other but cannot show where, which is precisely
 * the unfalsifiable claim CLAUDE.md forbids.
 */
export function supportingEdges(
  db: Db,
  runId: number,
  srcPackage: number,
  dstPackage: number,
  limit: number,
): SupportingEdge[] {
  const kinds = DEPENDENCY_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  return db
    .prepare(
      ancestorOfCte('package', DEPENDENCY_EDGE_KINDS, 'fact') +
        /* sql */ `
        SELECT e.id      AS edgeId,
               e.kind    AS kind,
               sn.fqn    AS srcFqn,
               dn.fqn    AS dstFqn,
               f.path    AS path,
               e.line    AS line
          FROM edge e
          JOIN ancestor_of sp ON sp.node_id = e.src_id
          JOIN ancestor_of dp ON dp.node_id = e.dst_id
          JOIN node sn ON sn.id = e.src_id
          JOIN node dn ON dn.id = e.dst_id
          LEFT JOIN source_file f ON f.id = e.file_id
         WHERE e.run_id = @runId
           AND e.kind IN (${kinds})
           AND e.confidence = 'fact'
           AND sp.ancestor_id = @srcPackage
           AND dp.ancestor_id = @dstPackage
         ORDER BY e.id
         LIMIT @limit`,
    )
    .all({ runId, srcPackage, dstPackage, limit }) as SupportingEdge[];
}
