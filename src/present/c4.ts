/**
 * The C4 model, as a projection of the fact graph.
 *
 * Every element and every relationship here is an aggregation of `node` and
 * `edge` rows, and carries the evidence that produced it. Where C4 asks for
 * something no fact supplies — a person, a deployment topology, a system we
 * never observed a call to — the diagram omits the box and says so in `notes`.
 * That refusal is ADR-0019 and it is the point of this file.
 *
 * Nothing here writes to the database. Layer 5 reads.
 */

import { basename } from 'node:path';

import { observedHttpCalls } from '../analysis/http-links.js';
import {
  ancestorOfCte,
  buildPackageGraph,
  supportingEdges,
  DEPENDENCY_EDGE_KINDS,
} from '../analysis/package-graph.js';
import type { Db } from '../db/database.js';
import type { Confidence, EdgeKind } from '../facts/types.js';

/** How many underlying rows a single element or relationship will cite. */
const EVIDENCE_LIMIT = 5;

/**
 * Edge kinds that connect one container to another.
 *
 * The dependency kinds, plus `http_calls` — which is the whole reason a
 * container diagram of a full-stack repository is worth drawing, and which
 * arrives as `confidence = 'inferred'` (ADR-0018) and stays labelled that way.
 */
const CONTAINER_EDGE_KINDS: readonly EdgeKind[] = [...DEPENDENCY_EDGE_KINDS, 'http_calls'];

/** Edge kinds that mean "this code touches that table". */
const TABLE_EDGE_KINDS: readonly EdgeKind[] = ['maps_to', 'reads_table', 'writes_table'];

export type C4Level = 'context' | 'container' | 'component';

export type C4ElementKind = 'system' | 'container' | 'component' | 'datastore' | 'external';

/** One citable row behind an element or a relationship. */
export interface Evidence {
  kind: 'node' | 'edge' | 'file' | 'run';
  /** Rendered for a human: `src/shop/Order.java:41`, or an fqn. */
  label: string;
  path: string | null;
  line: number | null;
}

export interface C4Element {
  /** Stable within a diagram, and safe as a Mermaid and Structurizr identifier. */
  id: string;
  name: string;
  kind: C4ElementKind;
  /** Observed languages, never a framework or a version nobody read. */
  technology: string | null;
  description: string | null;
  /** True when `name` or `description` came from a model, not from a parser. */
  inference: boolean;
  /** A grouping boundary — a cluster, at level 3. Null when ungrouped. */
  group: string | null;
  /** Whether the group's name is model-authored. */
  groupInference: boolean;
  evidence: Evidence[];
}

export interface C4Relationship {
  from: string;
  to: string;
  /** The observed edge kinds, e.g. `imports, calls`. */
  label: string;
  /** How many underlying edges were aggregated into this line. */
  count: number;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface C4Diagram {
  level: C4Level;
  /** The container a component diagram is inside. Null at levels 1 and 2. */
  scope: string | null;
  title: string;
  elements: C4Element[];
  relationships: C4Relationship[];
  /**
   * What this diagram does not show, and why. Never empty at level 1: the
   * absence of any person is itself a statement about the facts.
   */
  notes: string[];
}

export interface C4Model {
  context: C4Diagram;
  container: C4Diagram;
  /** One per container that has packages in it. */
  components: C4Diagram[];
}

export interface C4Options {
  /** Maximum elements drawn per component diagram. */
  top: number;
}

interface ModuleRow {
  id: number;
  fqn: string;
  name: string;
}

/**
 * Build all three levels for a run.
 *
 * The levels are built in order because each reuses the last one's identifiers:
 * the datastore and external systems established at level 1 are the same
 * elements at level 2, so a reader following a line from one diagram to the
 * next is following the same box.
 */
export function buildC4Model(db: Db, runId: number, options: C4Options): C4Model {
  const modules = loadModules(db, runId);
  const externals = loadExternalSystems(db, runId, modules);
  const tables = countTables(db, runId);

  const context = buildContext(db, runId, externals, tables);
  const container = buildContainer(db, runId, modules, externals, tables);
  const components = modules
    .map((module) => buildComponents(db, runId, module, options))
    .filter((diagram): diagram is C4Diagram => diagram !== null);

  return { context, container, components };
}

// ------------------------------------------------------------------ level 1

function buildContext(
  db: Db,
  runId: number,
  externals: ExternalSystem[],
  tables: TableSummary,
): C4Diagram {
  const run = loadRun(db, runId);
  const languages = loadLanguages(db, runId);

  const system: C4Element = {
    id: 'system',
    name: run.name,
    kind: 'system',
    technology: languages.length > 0 ? languages.join(', ') : null,
    description: null,
    inference: false,
    group: null,
    groupInference: false,
    evidence: [
      {
        kind: 'run',
        label: run.head === null ? run.repoPath : `${run.repoPath} @ ${run.head.slice(0, 10)}`,
        path: null,
        line: null,
      },
    ],
  };

  const elements: C4Element[] = [system];
  const relationships: C4Relationship[] = [];
  const notes: string[] = [
    'No fact in this run identifies a person, a role or a user, so no actor is ' +
      'drawn. C4 normally puts one here; this diagram shows only what a parser read.',
    'Deployment, processes and protocols are absent for the same reason: nothing ' +
      'in a source tree states them.',
  ];

  if (tables.count > 0) {
    elements.push(datastoreElement(tables));
    relationships.push({
      from: 'system',
      to: 'datastore',
      label: tables.kinds.join(', '),
      count: tables.edges,
      confidence: 'fact',
      evidence: tables.evidence,
    });
  }

  for (const external of externals) {
    elements.push(externalElement(external));
    relationships.push({
      from: 'system',
      to: external.id,
      label: external.methods.join(', '),
      count: external.count,
      confidence: 'fact',
      evidence: external.evidence,
    });
  }

  if (externals.length === 0) {
    notes.push(
      'No absolute URL appears in any literal an extractor read, so no external ' +
        'system is drawn. A call assembled from variables is invisible here (ADR-0018).',
    );
  }
  if (tables.count === 0) {
    notes.push('No table mapping was observed, so no data store is drawn.');
  }

  return {
    level: 'context',
    scope: null,
    title: `System context — ${run.name}`,
    elements,
    relationships,
    notes,
  };
}

// ------------------------------------------------------------------ level 2

function buildContainer(
  db: Db,
  runId: number,
  modules: ModuleRow[],
  externals: ExternalSystem[],
  tables: TableSummary,
): C4Diagram {
  const run = loadRun(db, runId);
  const elements: C4Element[] = [];
  const notes: string[] = [];

  const languagesByModule = loadModuleLanguages(db, runId);
  const sizesByModule = loadModuleSizes(db, runId);

  for (const module of modules) {
    const languages = languagesByModule.get(module.id) ?? [];
    const size = sizesByModule.get(module.id);
    elements.push({
      id: elementId('container', module.fqn),
      name: module.name,
      kind: 'container',
      technology: languages.length > 0 ? languages.join(', ') : null,
      description:
        size === undefined
          ? null
          : `${size.packages} package(s), ${size.types} type(s)`,
      inference: false,
      group: null,
      groupInference: false,
      evidence: [{ kind: 'node', label: module.fqn, path: null, line: null }],
    });
  }

  if (modules.length === 0) {
    notes.push(
      'No build module was observed, so this run has no containers. Run ' +
        '`stratigraph extract` — history alone cannot say what is deployed.',
    );
  } else if (modules.length === 1) {
    notes.push(
      'One container: this repository builds as a single module. Its internal ' +
        'structure is the component diagram, not this one.',
    );
  }

  const relationships = containerRelationships(db, runId, modules);

  if (tables.count > 0) {
    elements.push(datastoreElement(tables));
    for (const row of tableRelationshipsByModule(db, runId)) {
      relationships.push(row);
    }
  }
  for (const external of externals) {
    elements.push(externalElement(external));
    for (const [moduleId, calls] of external.byModule) {
      const module = modules.find((m) => m.id === moduleId);
      if (module === undefined) continue;
      relationships.push({
        from: elementId('container', module.fqn),
        to: external.id,
        label: calls.methods.join(', '),
        count: calls.count,
        confidence: 'fact',
        evidence: calls.evidence,
      });
    }
  }

  const inferred = relationships.filter((r) => r.confidence === 'inferred').length;
  if (inferred > 0) {
    notes.push(
      `${inferred} relationship(s) are inferred by URL matching, not observed — ` +
        'drawn dashed (ADR-0018). Open the cited line before relying on one.',
    );
  }

  return {
    level: 'container',
    scope: null,
    title: `Containers — ${run.name}`,
    elements,
    relationships,
    notes,
  };
}

/**
 * Module-to-module edges, aggregated by (source, target, confidence).
 *
 * Confidence is part of the key rather than collapsed, because one observed
 * `imports` and one guessed `http_calls` between the same pair are two
 * different claims and must not merge into a single confident line.
 */
function containerRelationships(
  db: Db,
  runId: number,
  modules: ModuleRow[],
): C4Relationship[] {
  if (modules.length < 2) return [];
  const byId = new Map(modules.map((module) => [module.id, module]));
  const kinds = CONTAINER_EDGE_KINDS.map((k) => `'${k}'`).join(', ');

  const rows = db
    .prepare(
      ancestorOfCte('module', CONTAINER_EDGE_KINDS, 'any') +
        /* sql */ `
        SELECT sm.ancestor_id AS src,
               dm.ancestor_id AS dst,
               e.confidence   AS confidence,
               e.kind         AS kind,
               SUM(e.weight)  AS weight
          FROM edge e
          JOIN ancestor_of sm ON sm.node_id = e.src_id
          JOIN ancestor_of dm ON dm.node_id = e.dst_id
         WHERE e.run_id = @runId
           AND e.kind IN (${kinds})
           AND sm.ancestor_id <> dm.ancestor_id
         GROUP BY sm.ancestor_id, dm.ancestor_id, e.confidence, e.kind
         ORDER BY sm.ancestor_id, dm.ancestor_id, e.confidence, e.kind`,
    )
    .all({ runId }) as Array<{
    src: number;
    dst: number;
    confidence: Confidence;
    kind: string;
    weight: number;
  }>;

  const merged = new Map<string, C4Relationship>();
  for (const row of rows) {
    const from = byId.get(row.src);
    const to = byId.get(row.dst);
    if (from === undefined || to === undefined) continue;

    const key = `${row.src} ${row.dst} ${row.confidence}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        from: elementId('container', from.fqn),
        to: elementId('container', to.fqn),
        label: row.kind,
        count: row.weight,
        confidence: row.confidence,
        evidence: moduleEdgeEvidence(db, runId, row.src, row.dst, row.confidence),
      });
    } else {
      existing.label += `, ${row.kind}`;
      existing.count += row.weight;
    }
  }
  return [...merged.values()];
}

/** Up to `EVIDENCE_LIMIT` of the source-level edges behind one container line. */
function moduleEdgeEvidence(
  db: Db,
  runId: number,
  srcModule: number,
  dstModule: number,
  confidence: Confidence,
): Evidence[] {
  const kinds = CONTAINER_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const rows = db
    .prepare(
      ancestorOfCte('module', CONTAINER_EDGE_KINDS, 'any') +
        /* sql */ `
        SELECT e.kind AS kind, sn.fqn AS srcFqn, dn.fqn AS dstFqn,
               f.path AS path, e.line AS line
          FROM edge e
          JOIN ancestor_of sm ON sm.node_id = e.src_id
          JOIN ancestor_of dm ON dm.node_id = e.dst_id
          JOIN node sn ON sn.id = e.src_id
          JOIN node dn ON dn.id = e.dst_id
          LEFT JOIN source_file f ON f.id = e.file_id
         WHERE e.run_id = @runId
           AND e.kind IN (${kinds})
           AND e.confidence = @confidence
           AND sm.ancestor_id = @srcModule
           AND dm.ancestor_id = @dstModule
         ORDER BY e.id
         LIMIT @limit`,
    )
    .all({ runId, srcModule, dstModule, confidence, limit: EVIDENCE_LIMIT }) as Array<{
    kind: string;
    srcFqn: string;
    dstFqn: string;
    path: string | null;
    line: number | null;
  }>;

  return rows.map((row) => ({
    kind: 'edge' as const,
    label: `${row.kind} ${row.srcFqn} → ${row.dstFqn}`,
    path: row.path,
    line: row.line,
  }));
}

/** Which containers touch the data store, and how. */
function tableRelationshipsByModule(db: Db, runId: number): C4Relationship[] {
  const kinds = TABLE_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const rows = db
    .prepare(
      ancestorOfCte('module', TABLE_EDGE_KINDS, 'fact') +
        /* sql */ `
        SELECT m.fqn AS moduleFqn, e.kind AS kind, COUNT(*) AS n,
               MIN(f.path) AS path, MIN(e.line) AS line,
               MIN(dn.fqn) AS tableFqn
          FROM edge e
          JOIN ancestor_of sm ON sm.node_id = e.src_id
          JOIN node m  ON m.id  = sm.ancestor_id
          JOIN node dn ON dn.id = e.dst_id AND dn.kind = 'table'
          LEFT JOIN source_file f ON f.id = e.file_id
         WHERE e.run_id = @runId AND e.kind IN (${kinds}) AND e.confidence = 'fact'
         GROUP BY m.fqn, e.kind
         ORDER BY m.fqn, e.kind`,
    )
    .all({ runId }) as Array<{
    moduleFqn: string;
    kind: string;
    n: number;
    path: string | null;
    line: number | null;
    tableFqn: string;
  }>;

  const merged = new Map<string, C4Relationship>();
  for (const row of rows) {
    const from = elementId('container', row.moduleFqn);
    const existing = merged.get(from);
    if (existing === undefined) {
      merged.set(from, {
        from,
        to: 'datastore',
        label: row.kind,
        count: row.n,
        confidence: 'fact',
        evidence: [
          { kind: 'edge', label: `${row.kind} → ${row.tableFqn}`, path: row.path, line: row.line },
        ],
      });
    } else {
      existing.label += `, ${row.kind}`;
      existing.count += row.n;
      if (existing.evidence.length < EVIDENCE_LIMIT) {
        existing.evidence.push({
          kind: 'edge',
          label: `${row.kind} → ${row.tableFqn}`,
          path: row.path,
          line: row.line,
        });
      }
    }
  }
  return [...merged.values()];
}

// ------------------------------------------------------------------ level 3

/**
 * One container's packages and the dependencies between them.
 *
 * `buildPackageGraph` is reused rather than reimplemented, so "depends on"
 * means exactly what it means to the cycle detector. Filtering afterwards keeps
 * the two definitions from drifting apart, which is worth one wasted whole-repo
 * aggregation per module.
 */
function buildComponents(
  db: Db,
  runId: number,
  module: ModuleRow,
  options: C4Options,
): C4Diagram | null {
  const packages = loadPackages(db, runId, module.id);
  if (packages.length === 0) return null;

  const graph = buildPackageGraph(db, runId);
  const clusters = loadClusterNames(db, runId);

  // Rank by how connected a package is, so a capped diagram keeps the packages
  // that carry the structure rather than the alphabetically luckiest ones.
  const degree = new Map<number, number>();
  for (const dependency of graph.dependencies) {
    degree.set(dependency.src, (degree.get(dependency.src) ?? 0) + dependency.weight);
    degree.set(dependency.dst, (degree.get(dependency.dst) ?? 0) + dependency.weight);
  }
  const ranked = [...packages].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.fqn.localeCompare(b.fqn),
  );
  const shown = ranked.slice(0, options.top);
  const shownIds = new Set(shown.map((p) => p.id));

  const elements: C4Element[] = shown
    .map((pkg) => {
      const cluster = clusters.get(pkg.id);
      return {
        id: elementId('component', pkg.fqn),
        name: pkg.fqn,
        kind: 'component' as const,
        technology: null,
        description: null,
        inference: false,
        group: cluster?.label ?? null,
        groupInference: cluster?.inference ?? false,
        evidence: [{ kind: 'node' as const, label: pkg.fqn, path: null, line: null }],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const relationships: C4Relationship[] = [];
  for (const dependency of graph.dependencies) {
    if (!shownIds.has(dependency.src) || !shownIds.has(dependency.dst)) continue;
    const src = byId.get(dependency.src);
    const dst = byId.get(dependency.dst);
    /* c8 ignore next */
    if (src === undefined || dst === undefined) continue;

    const supporting = supportingEdges(db, runId, dependency.src, dependency.dst, EVIDENCE_LIMIT);
    relationships.push({
      from: elementId('component', src.fqn),
      to: elementId('component', dst.fqn),
      label: [...new Set(supporting.map((edge) => edge.kind))].join(', ') || 'depends on',
      count: dependency.weight,
      confidence: 'fact',
      evidence: supporting.map((edge) => ({
        kind: 'edge' as const,
        label: `${edge.kind} ${edge.srcFqn} → ${edge.dstFqn}`,
        path: edge.path,
        line: edge.line,
      })),
    });
  }
  relationships.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const notes: string[] = [];
  if (packages.length > shown.length) {
    notes.push(
      `Showing ${shown.length} of ${packages.length} packages, the most connected ` +
        `first. Raise --top for more.`,
    );
  }
  if (elements.some((element) => element.groupInference)) {
    notes.push(
      'Group names marked as inference were written by a model over the ' +
        'algorithmic clustering, not read from the source (ADR-0013).',
    );
  }

  return {
    level: 'component',
    scope: module.fqn,
    title: `Components — ${module.name}`,
    elements,
    relationships,
    notes,
  };
}

// -------------------------------------------------------------- shared parts

interface TableSummary {
  count: number;
  edges: number;
  kinds: string[];
  evidence: Evidence[];
}

function datastoreElement(tables: TableSummary): C4Element {
  return {
    id: 'datastore',
    name: 'Database',
    kind: 'datastore',
    technology: null,
    description: `${tables.count} table(s) observed`,
    inference: false,
    group: null,
    groupInference: false,
    evidence: tables.evidence,
  };
}

interface ExternalCalls {
  count: number;
  methods: string[];
  evidence: Evidence[];
}

interface ExternalSystem {
  id: string;
  host: string;
  count: number;
  methods: string[];
  evidence: Evidence[];
  byModule: Map<number, ExternalCalls>;
}

function externalElement(external: ExternalSystem): C4Element {
  return {
    id: external.id,
    name: external.host,
    kind: 'external',
    technology: 'HTTP',
    description: `${external.count} call site(s) name this host`,
    inference: false,
    group: null,
    groupInference: false,
    evidence: external.evidence,
  };
}

/**
 * Hosts named in an absolute URL that an extractor read out of a literal.
 *
 * ADR-0019: the host is a fact, and the box claims only that — not that the
 * call reaches any particular endpoint of it. A relative URL produces nothing,
 * because a relative URL that matched no endpoint is a gap in our reading of
 * this repository, not evidence of a system outside it.
 */
function loadExternalSystems(db: Db, runId: number, modules: ModuleRow[]): ExternalSystem[] {
  const calls = observedHttpCalls(db, runId);
  const withHost = calls
    .map((call) => ({ call, host: hostOf(call.url) }))
    .filter((entry): entry is { call: (typeof calls)[number]; host: string } => entry.host !== null);
  if (withHost.length === 0) return [];

  const moduleOf = modulesOfNodes(
    db,
    runId,
    withHost.map((entry) => entry.call.nodeId),
  );
  const known = new Set(modules.map((module) => module.id));

  const byHost = new Map<string, ExternalSystem>();
  for (const { call, host } of withHost) {
    let system = byHost.get(host);
    if (system === undefined) {
      system = {
        id: elementId('external', host),
        host,
        count: 0,
        methods: [],
        evidence: [],
        byModule: new Map(),
      };
      byHost.set(host, system);
    }
    system.count += 1;
    if (!system.methods.includes(call.method)) system.methods.push(call.method);
    const evidence: Evidence = {
      kind: 'node',
      label: `${call.method} ${call.url} in ${call.nodeFqn}`,
      path: call.file,
      line: call.line,
    };
    if (system.evidence.length < EVIDENCE_LIMIT) system.evidence.push(evidence);

    const moduleId = moduleOf.get(call.nodeId);
    if (moduleId === undefined || !known.has(moduleId)) continue;
    let perModule = system.byModule.get(moduleId);
    if (perModule === undefined) {
      perModule = { count: 0, methods: [], evidence: [] };
      system.byModule.set(moduleId, perModule);
    }
    perModule.count += 1;
    if (!perModule.methods.includes(call.method)) perModule.methods.push(call.method);
    if (perModule.evidence.length < EVIDENCE_LIMIT) perModule.evidence.push(evidence);
  }

  for (const system of byHost.values()) system.methods.sort();
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * The host of an absolute URL, or null.
 *
 * Deliberately strict. A URL the extractor reduced to `{}/{}` because it was
 * assembled at runtime has no host to read, and guessing one from a nearby
 * string is the invention this whole layer refuses.
 */
export function hostOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#\s]+)/i.exec(url);
  if (match === null) return null;
  const host = match[2] as string;
  // An interpolated segment means the host itself was computed at runtime.
  return host.includes('{') ? null : host.toLowerCase();
}

/** Resolve a specific set of nodes to their enclosing module. */
function modulesOfNodes(db: Db, runId: number, nodeIds: number[]): Map<number, number> {
  const unique = [...new Set(nodeIds)].filter((id) => Number.isInteger(id));
  if (unique.length === 0) return new Map();
  const list = unique.join(', ');

  const rows = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE ancestry(start_id, node_id, kind) AS (
          SELECT n.id, n.id, n.kind FROM node n
           WHERE n.run_id = @runId AND n.id IN (${list})
        UNION ALL
          SELECT a.start_id, p.id, p.kind
            FROM ancestry a
            JOIN node c ON c.id = a.node_id
            JOIN node p ON p.id = c.parent_id
           WHERE a.kind <> 'module'
      )
      SELECT start_id AS nodeId, node_id AS moduleId
        FROM ancestry WHERE kind = 'module'`,
    )
    .all({ runId }) as Array<{ nodeId: number; moduleId: number }>;

  return new Map(rows.map((row) => [row.nodeId, row.moduleId]));
}

function countTables(db: Db, runId: number): TableSummary {
  const count = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND kind = 'table'`)
      .get(runId) as { n: number }
  ).n;
  if (count === 0) return { count: 0, edges: 0, kinds: [], evidence: [] };

  const kinds = TABLE_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS n FROM edge e JOIN node d ON d.id = e.dst_id AND d.kind = 'table'
        WHERE e.run_id = ? AND e.kind IN (${kinds}) AND e.confidence = 'fact'`,
    )
    .get(runId) as { n: number };

  const kindRows = db
    .prepare(
      `SELECT DISTINCT e.kind AS kind FROM edge e JOIN node d ON d.id = e.dst_id AND d.kind = 'table'
        WHERE e.run_id = ? AND e.kind IN (${kinds}) AND e.confidence = 'fact' ORDER BY e.kind`,
    )
    .all(runId) as Array<{ kind: string }>;

  const evidence = db
    .prepare(
      `SELECT n.fqn AS fqn, f.path AS path, n.start_line AS line
         FROM node n LEFT JOIN source_file f ON f.id = n.file_id
        WHERE n.run_id = ? AND n.kind = 'table' ORDER BY n.fqn LIMIT ?`,
    )
    .all(runId, EVIDENCE_LIMIT) as Array<{
    fqn: string;
    path: string | null;
    line: number | null;
  }>;

  return {
    count,
    edges: summary.n,
    kinds: kindRows.map((row) => row.kind),
    evidence: evidence.map((row) => ({
      kind: 'node' as const,
      label: row.fqn,
      path: row.path,
      line: row.line,
    })),
  };
}

function loadModules(db: Db, runId: number): ModuleRow[] {
  return db
    .prepare(
      `SELECT id, fqn, name FROM node
        WHERE run_id = ? AND kind = 'module' AND is_stub = 0 ORDER BY fqn`,
    )
    .all(runId) as ModuleRow[];
}

function loadPackages(db: Db, runId: number, moduleId: number): ModuleRow[] {
  return db
    .prepare(
      `SELECT id, fqn, name FROM node
        WHERE run_id = ? AND kind = 'package' AND is_stub = 0 AND parent_id = ?
        ORDER BY fqn`,
    )
    .all(runId, moduleId) as ModuleRow[];
}

/**
 * Languages per module, from the files of the types declared in its packages.
 *
 * One join deep rather than a recursive walk: every top-level type sits
 * directly under its package, which is more than enough to label a container
 * `Java` or `TypeScript`.
 */
function loadModuleLanguages(db: Db, runId: number): Map<number, string[]> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT m.id AS moduleId, sf.language AS language, COUNT(*) AS n
        FROM node pkg
        JOIN node m  ON m.id = pkg.parent_id AND m.kind = 'module'
        JOIN node n  ON n.parent_id = pkg.id
        JOIN source_file sf ON sf.id = n.file_id
       WHERE pkg.run_id = @runId AND pkg.kind = 'package'
       GROUP BY m.id, sf.language
       ORDER BY m.id, n DESC, sf.language`,
    )
    .all({ runId }) as Array<{ moduleId: number; language: string; n: number }>;

  const byModule = new Map<number, string[]>();
  for (const row of rows) {
    const existing = byModule.get(row.moduleId);
    if (existing) existing.push(row.language);
    else byModule.set(row.moduleId, [row.language]);
  }
  return byModule;
}

function loadModuleSizes(db: Db, runId: number): Map<number, { packages: number; types: number }> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT m.id AS moduleId,
             COUNT(DISTINCT pkg.id) AS packages,
             COUNT(n.id)            AS types
        FROM node pkg
        JOIN node m ON m.id = pkg.parent_id AND m.kind = 'module'
        LEFT JOIN node n ON n.parent_id = pkg.id AND n.is_stub = 0
       WHERE pkg.run_id = @runId AND pkg.kind = 'package' AND pkg.is_stub = 0
       GROUP BY m.id`,
    )
    .all({ runId }) as Array<{ moduleId: number; packages: number; types: number }>;
  return new Map(rows.map((row) => [row.moduleId, { packages: row.packages, types: row.types }]));
}

/**
 * The cluster each package was grouped into, and whether a model named it.
 *
 * A cluster with no model name falls back to nothing rather than to a made-up
 * label: the group boundary still exists in the data, but an unnamed one adds
 * only noise to a diagram, so `loadClusterNames` returns the model's name or
 * the algorithm's own label — and says which.
 */
function loadClusterNames(
  db: Db,
  runId: number,
): Map<number, { label: string; inference: boolean }> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT cm.node_id AS nodeId, c.label AS label, c.name AS name,
             c.authored_by AS authoredBy
        FROM cluster c
        JOIN cluster_member cm ON cm.cluster_id = c.id
       WHERE c.run_id = @runId`,
    )
    .all({ runId }) as Array<{
    nodeId: number;
    label: number;
    name: string | null;
    authoredBy: string;
  }>;

  const byNode = new Map<number, { label: string; inference: boolean }>();
  for (const row of rows) {
    byNode.set(row.nodeId, {
      label: row.name ?? `cluster ${row.label}`,
      inference: row.name !== null && row.authoredBy === 'model',
    });
  }
  return byNode;
}

function loadRun(db: Db, runId: number): { name: string; repoPath: string; head: string | null } {
  const row = db
    .prepare(`SELECT repo_path AS repoPath, repo_head AS head FROM run WHERE id = ?`)
    .get(runId) as { repoPath: string; head: string | null } | undefined;
  /* c8 ignore next */
  if (row === undefined) return { name: 'repository', repoPath: '', head: null };
  return { name: basename(row.repoPath) || row.repoPath, repoPath: row.repoPath, head: row.head };
}

function loadLanguages(db: Db, runId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT language FROM source_file WHERE run_id = ? ORDER BY language`,
      )
      .all(runId) as Array<{ language: string }>
  ).map((row) => row.language);
}

/**
 * A diagram-local identifier that Mermaid and Structurizr will both accept.
 *
 * Both want an identifier, not a string, so `com.shop.billing` and
 * `src/app/billing` have to become something without dots or slashes in it. The
 * prefix keeps a package and a module of the same name apart.
 */
export function elementId(prefix: string, fqn: string): string {
  const slug = fqn.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
  return `${prefix}_${slug}`;
}
