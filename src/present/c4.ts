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

import { loadModuleInfo, type ModuleInfo } from '../analysis/deployables.js';
import { observedHttpCalls } from '../analysis/http-links.js';
import {
  ancestorOfCte,
  buildPackageGraph,
  declaredInTest,
  moduleAncestry,
  moduleOfNodeInPackage,
  packageEdgeFromTest,
  packageInModule,
  supportingEdgesForPairs,
  testOnlyPackage,
  DEPENDENCY_EDGE_KINDS,
  type PackageGraph,
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
  const modules = loadModuleInfo(db, runId);
  // ADR-0040: a container is a deployable. With none proved, every module is
  // drawn as before, and the diagram says why.
  const deployables = modules.filter((module) => module.role === 'deployable');
  const fallback = deployables.length === 0;
  const containers = fallback ? modules : deployables;

  const externals = loadExternalSystems(db, runId, containers);
  const tables = countTables(db, runId);

  const context = buildContext(db, runId, externals, tables);
  const container = buildContainer(db, runId, { containers, modules, fallback }, externals, tables);

  const graph = containers.length > 0 ? buildPackageGraph(db, runId) : null;
  const membership = loadPackageMembership(db, runId);
  const containerIds = new Set(containers.map((module) => module.id));
  const components =
    graph === null
      ? []
      : containers
          .map((module) =>
            buildComponents(db, runId, module, { graph, membership, containerIds, modules }, options),
          )
          .filter((diagram): diagram is C4Diagram => diagram !== null);

  return { context, container, components };
}

/** Which modules a run's containers are drawn from, and what the rest are. */
interface ContainerSet {
  containers: ModuleInfo[];
  modules: ModuleInfo[];
  /** True when no module is a proved deployable and every module is a container. */
  fallback: boolean;
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
  set: ContainerSet,
  externals: ExternalSystem[],
  tables: TableSummary,
): C4Diagram {
  const run = loadRun(db, runId);
  const elements: C4Element[] = [];
  const notes: string[] = [];
  const { containers, modules, fallback } = set;

  const languagesByModule = loadModuleLanguages(db, runId);
  const sizesByModule = loadModuleSizes(db, runId);

  for (const module of containers) {
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
      evidence: [
        { kind: 'node', label: module.fqn, path: null, line: null },
        ...module.proofs.slice(0, EVIDENCE_LIMIT).map((proof) => ({
          kind: proof.source,
          label:
            proof.subject === null
              ? `${proof.kind}: ${proof.rule}`
              : `${proof.kind}: @SpringBootApplication ${proof.subject}`,
          path: proof.path,
          line: proof.line,
        })),
      ],
    });
  }

  if (modules.length === 0) {
    notes.push(
      'No build module was observed, so this run has no containers. Run ' +
        '`stratigraph extract` — history alone cannot say what is deployed.',
    );
  } else if (fallback) {
    notes.push(
      'No module is a proved deployable — no @SpringBootApplication class, Spring Boot ' +
        'plugin, WAR packaging, or Angular/Nx application project was found — so every ' +
        'build module is drawn as a container, libraries and aggregators included ' +
        '(ADR-0040).',
    );
    if (modules.length === 1) {
      notes.push(
        'One container: this repository builds as a single module. Its internal ' +
          'structure is the component diagram, not this one.',
      );
    }
  } else {
    notes.push(
      'A container is a deployable proved by a build file or a @SpringBootApplication ' +
        'class; each cites its proof (ADR-0040).',
    );
    if (containers.length === 1) {
      notes.push(
        'One container: this repository deploys a single application. Its internal ' +
          'structure is the component diagram, not this one.',
      );
    }
    const byRole = (role: ModuleInfo['role']): string[] =>
      modules.filter((module) => module.role === role).map((module) => module.name);
    const aggregators = byRole('aggregator');
    const libraries = byRole('library');
    if (aggregators.length > 0) {
      notes.push(
        `Not containers — aggregator or BOM modules (packaging pom), which group the ` +
          `build and deploy nothing: ${listed(aggregators)}.`,
      );
    }
    if (libraries.length > 0) {
      notes.push(
        `Not containers — library modules, with no deployability proof: ${listed(libraries)}. ` +
          'They are drawn inside the component diagram of each container that depends on them.',
      );
    }
  }

  const { relationships, fromLibraries } = containerRelationships(db, runId, containers, modules);
  if (fromLibraries > 0) {
    notes.push(
      `${fromLibraries} reference(s) start or end in library or aggregator code and are not ` +
        'container relationships: a library is compiled into the containers that use it.',
    );
  }

  if (tables.count > 0) {
    elements.push(datastoreElement(tables));
    const containerFqns = new Set(containers.map((module) => module.fqn));
    const touching = tableRelationshipsByModule(db, runId);
    for (const row of touching) {
      if (containerFqns.has(row.moduleFqn)) relationships.push(row.relationship);
    }
    const elsewhere = [...new Set(touching.filter((row) => !containerFqns.has(row.moduleFqn)).map((row) => row.moduleName))];
    if (elsewhere.length > 0) {
      notes.push(
        `Table mappings declared in ${listed(elsewhere)} are not drawn here: that code is not ` +
          'a container, and which deployable uses it is not a fact in this run.',
      );
    }
  }
  for (const external of externals) {
    elements.push(externalElement(external));
    for (const [moduleId, calls] of external.byModule) {
      const module = containers.find((m) => m.id === moduleId);
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

/** `a, b, c` — or the first few and a count, so a note stays a sentence. */
function listed(names: string[]): string {
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown} and ${names.length - 8} more` : shown;
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
  containers: ModuleInfo[],
  modules: ModuleInfo[],
): { relationships: C4Relationship[]; fromLibraries: number } {
  if (modules.length < 2) return { relationships: [], fromLibraries: 0 };
  const byId = new Map(containers.map((module) => [module.id, module]));
  const known = new Set(modules.map((module) => module.id));
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
           AND NOT ${packageEdgeFromTest('e')}
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
  let fromLibraries = 0;
  for (const row of rows) {
    const from = byId.get(row.src);
    const to = byId.get(row.dst);
    if (from === undefined || to === undefined) {
      if (known.has(row.src) && known.has(row.dst)) fromLibraries += row.weight;
      continue;
    }

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
  return { relationships: [...merged.values()], fromLibraries };
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
           AND NOT ${packageEdgeFromTest('e')}
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

/** Which modules touch the data store, and how — one relationship per module. */
function tableRelationshipsByModule(
  db: Db,
  runId: number,
): Array<{ moduleFqn: string; moduleName: string; relationship: C4Relationship }> {
  const kinds = TABLE_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const rows = db
    .prepare(
      ancestorOfCte('module', TABLE_EDGE_KINDS, 'fact') +
        /* sql */ `
        SELECT m.fqn AS moduleFqn, m.name AS moduleName, e.kind AS kind, COUNT(*) AS n,
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
    moduleName: string;
    kind: string;
    n: number;
    path: string | null;
    line: number | null;
    tableFqn: string;
  }>;

  const merged = new Map<string, { moduleFqn: string; moduleName: string; relationship: C4Relationship }>();
  for (const row of rows) {
    const from = elementId('container', row.moduleFqn);
    const evidence: Evidence = {
      kind: 'edge',
      label: `${row.kind} → ${row.tableFqn}`,
      path: row.path,
      line: row.line,
    };
    const existing = merged.get(from);
    if (existing === undefined) {
      merged.set(from, {
        moduleFqn: row.moduleFqn,
        moduleName: row.moduleName,
        relationship: {
          from,
          to: 'datastore',
          label: row.kind,
          count: row.n,
          confidence: 'fact',
          evidence: [evidence],
        },
      });
    } else {
      existing.relationship.label += `, ${row.kind}`;
      existing.relationship.count += row.n;
      if (existing.relationship.evidence.length < EVIDENCE_LIMIT) {
        existing.relationship.evidence.push(evidence);
      }
    }
  }
  return [...merged.values()];
}

// ------------------------------------------------------------------ level 3

/** What level 3 needs from the whole run, computed once rather than per container. */
interface ComponentContext {
  graph: PackageGraph;
  /** Package id → the modules it belongs to (more than one when split, ADR-0041). */
  membership: Map<number, number[]>;
  containerIds: Set<number>;
  modules: ModuleInfo[];
}

/**
 * One container's packages and the dependencies between them, plus the
 * library packages it depends on directly (ADR-0040).
 *
 * `buildPackageGraph` is reused rather than reimplemented, so "depends on"
 * means exactly what it means to the cycle detector. Filtering afterwards keeps
 * the two definitions from drifting apart.
 *
 * A library is compiled into the containers that use it, so its packages are
 * drawn inside each such container, grouped under `library <name>`. A package
 * that can appear in more than one diagram — a library package, or a package
 * split across two containers — gets an identifier scoped by the container, so
 * Structurizr, which nests components inside containers, never sees one
 * declared twice.
 */
function buildComponents(
  db: Db,
  runId: number,
  module: ModuleInfo,
  context: ComponentContext,
  options: C4Options,
): C4Diagram | null {
  const { graph, membership, containerIds } = context;
  const packages = loadPackages(db, runId, module.id);
  if (packages.length === 0) return null;
  const clusters = loadClusterNames(db, runId);
  const moduleById = new Map(context.modules.map((m) => [m.id, m]));

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
  const ownIds = new Set(packages.map((p) => p.id));
  const shownOwn = new Set(shown.map((p) => p.id));

  // Library packages the shown packages depend on directly, heaviest first.
  const libraryWeight = new Map<number, number>();
  for (const dependency of graph.dependencies) {
    if (!shownOwn.has(dependency.src) || ownIds.has(dependency.dst)) continue;
    const owners = membership.get(dependency.dst) ?? [];
    if (owners.length === 0 || owners.some((owner) => containerIds.has(owner))) continue;
    libraryWeight.set(dependency.dst, (libraryWeight.get(dependency.dst) ?? 0) + dependency.weight);
  }
  const libraryAll = [...libraryWeight.entries()]
    .map(([id, weight]) => ({ id, weight, pkg: graph.packages.get(id) }))
    .filter((entry): entry is { id: number; weight: number; pkg: { id: number; fqn: string } } =>
      entry.pkg !== undefined,
    )
    .sort((a, b) => b.weight - a.weight || a.pkg.fqn.localeCompare(b.pkg.fqn));
  const libraries = libraryAll.slice(0, options.top);

  const scoped = (pkgId: number, fqn: string): string => {
    const shared = !ownIds.has(pkgId) || (membership.get(pkgId)?.length ?? 1) > 1;
    return shared ? elementId('component', `${module.fqn} ${fqn}`) : elementId('component', fqn);
  };

  // A partition of one is not a partition. When every package on the diagram
  // landed in the same cluster, the boundary box says nothing a reader can use,
  // so it is not drawn — the clustering is still reported by `analyze`.
  const distinctGroups = new Set(
    shown.map((pkg) => clusters.get(pkg.id)?.label).filter((label) => label !== undefined),
  );
  const worthGrouping = distinctGroups.size > 1;

  const ids = new Map<number, string>();
  const elements: C4Element[] = shown.map((pkg) => {
    const cluster = worthGrouping ? clusters.get(pkg.id) : undefined;
    const id = scoped(pkg.id, pkg.fqn);
    ids.set(pkg.id, id);
    return {
      id,
      name: pkg.fqn,
      kind: 'component' as const,
      technology: null,
      description: null,
      inference: false,
      group: cluster?.label ?? null,
      groupInference: cluster?.inference ?? false,
      evidence: [{ kind: 'node' as const, label: pkg.fqn, path: null, line: null }],
    };
  });
  for (const { id: pkgId, pkg } of libraries) {
    const owners = (membership.get(pkgId) ?? []).map((owner) => moduleById.get(owner)?.name ?? '?');
    const id = scoped(pkgId, pkg.fqn);
    ids.set(pkgId, id);
    elements.push({
      id,
      name: pkg.fqn,
      kind: 'component',
      technology: null,
      description: null,
      inference: false,
      group: `library ${owners.join(', ')}`,
      groupInference: false,
      evidence: [{ kind: 'node', label: pkg.fqn, path: null, line: null }],
    });
  }
  elements.sort((a, b) => a.name.localeCompare(b.name));

  const drawn = graph.dependencies.filter((d) => ids.has(d.src) && ids.has(d.dst));
  const evidenceByPair = supportingEdgesForPairs(
    db,
    runId,
    drawn.map((d) => [d.src, d.dst] as const),
    EVIDENCE_LIMIT,
  );
  const relationships: C4Relationship[] = [];
  for (const dependency of drawn) {
    const from = ids.get(dependency.src) as string;
    const to = ids.get(dependency.dst) as string;
    const supporting = evidenceByPair.get(`${dependency.src} ${dependency.dst}`) ?? [];
    relationships.push({
      from,
      to,
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
  if (libraries.length > 0) {
    notes.push(
      'Packages grouped under "library" belong to library modules compiled into this ' +
        'container; they are drawn because this container’s packages depend on them directly' +
        (libraryAll.length > libraries.length
          ? ` (${libraries.length} of ${libraryAll.length} shown).`
          : '.'),
    );
  }
  const split = shown.filter((pkg) => (membership.get(pkg.id)?.length ?? 1) > 1);
  if (split.length > 0) {
    notes.push(
      `${listed(split.map((pkg) => pkg.fqn))}: split across modules (ADR-0041). A package ` +
        'is one node, so its dependencies here are those of both halves.',
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
function loadExternalSystems(db: Db, runId: number, modules: Array<{ id: number }>): ExternalSystem[] {
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

/** Resolve a specific set of nodes to their enclosing module (ADR-0041's rule). */
function modulesOfNodes(db: Db, runId: number, nodeIds: number[]): Map<number, number> {
  const unique = [...new Set(nodeIds)].filter((id) => Number.isInteger(id));
  if (unique.length === 0) return new Map();
  const list = unique.join(', ');

  const rows = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        seed(id) AS (SELECT id FROM node WHERE run_id = @runId AND id IN (${list})),
        ${moduleAncestry('seed')}
      SELECT node_id AS nodeId, ancestor_id AS moduleId FROM ancestor_of`,
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

/** A module's packages: by `parent`, or by a `contains` edge when split (ADR-0041). */
function loadPackages(db: Db, runId: number, moduleId: number): ModuleRow[] {
  return db
    .prepare(
      `SELECT id, fqn, name FROM node pkg
        WHERE run_id = @runId AND kind = 'package' AND is_stub = 0
          AND ${packageInModule('pkg', '@moduleId')}
          AND NOT ${testOnlyPackage('pkg')}
        ORDER BY fqn`,
    )
    .all({ runId, moduleId }) as ModuleRow[];
}

/** Package id → every module it belongs to. */
function loadPackageMembership(db: Db, runId: number): Map<number, number[]> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT c.dst_id AS pkg, c.src_id AS module
        FROM edge c JOIN node m ON m.id = c.src_id AND m.kind = 'module'
       WHERE c.run_id = @runId AND c.kind = 'contains'
      UNION
      SELECT pkg.id, pkg.parent_id
        FROM node pkg
       WHERE pkg.run_id = @runId AND pkg.kind = 'package' AND pkg.parent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM edge c WHERE c.run_id = pkg.run_id
                          AND c.kind = 'contains' AND c.dst_id = pkg.id)
       ORDER BY 1, 2`,
    )
    .all({ runId }) as Array<{ pkg: number; module: number }>;
  const byPackage = new Map<number, number[]>();
  for (const row of rows) {
    const list = byPackage.get(row.pkg) ?? [];
    list.push(row.module);
    byPackage.set(row.pkg, list);
  }
  return byPackage;
}

/**
 * The module each declared type belongs to, for sizes and languages. A type in
 * a split package is placed by its file (ADR-0041); test code is left out
 * (ADR-0034).
 */
const TYPES_BY_MODULE = /* sql */ `
  SELECT ${moduleOfNodeInPackage('n', 'pkg')} AS moduleId, n.id AS typeId, n.file_id AS fileId
    FROM node pkg
    JOIN node n ON n.parent_id = pkg.id AND n.is_stub = 0
   WHERE pkg.run_id = @runId AND pkg.kind = 'package' AND pkg.is_stub = 0
     AND NOT ${declaredInTest('n')}`;

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
      SELECT t.moduleId AS moduleId, sf.language AS language, COUNT(*) AS n
        FROM (${TYPES_BY_MODULE}) t
        JOIN source_file sf ON sf.id = t.fileId
       GROUP BY t.moduleId, sf.language
       ORDER BY t.moduleId, n DESC, sf.language`,
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
  const packages = db
    .prepare(
      /* sql */ `
      SELECT m.id AS moduleId, COUNT(*) AS n
        FROM node m JOIN node pkg ON pkg.run_id = m.run_id AND pkg.kind = 'package'
             AND pkg.is_stub = 0 AND ${packageInModule('pkg', 'm.id')}
       WHERE m.run_id = @runId AND m.kind = 'module' AND NOT ${testOnlyPackage('pkg')}
       GROUP BY m.id`,
    )
    .all({ runId }) as Array<{ moduleId: number; n: number }>;
  const types = db
    .prepare(
      /* sql */ `
      SELECT t.moduleId AS moduleId, COUNT(*) AS n
        FROM (${TYPES_BY_MODULE}) t
        JOIN node n ON n.id = t.typeId AND n.kind IN ('class','interface','enum','annotation','component','service')
       GROUP BY t.moduleId`,
    )
    .all({ runId }) as Array<{ moduleId: number; n: number }>;

  const typeCount = new Map(types.map((row) => [row.moduleId, row.n]));
  return new Map(
    packages.map((row) => [row.moduleId, { packages: row.n, types: typeCount.get(row.moduleId) ?? 0 }]),
  );
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
