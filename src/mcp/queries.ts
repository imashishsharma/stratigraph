/**
 * The queries behind the MCP tools.
 *
 * Layer 5 (ADR-0015): these read the fact store and nothing else. No extractor
 * is started, no row is written, and every function takes an already-open
 * read-only database. Keeping them here rather than inside the tool handlers is
 * what lets the whole surface be tested without a protocol.
 *
 * Two shapes recur, and both come from ADR-0015:
 *
 * - Everything returned carries its provenance — an `fqn`, a `file` and `line`,
 *   or a commit sha — because an answer a caller cannot check is the thing this
 *   project exists to avoid.
 * - Nothing empty is returned bare. `found` says whether the subject exists in
 *   this run at all, and `covered` says whether this run could have answered
 *   the question. An agent seeing `[]` must be able to tell "we looked and
 *   there is nothing" from "no extractor ever parsed that".
 */

import type { Db } from '../db/database.js';
import { busFactorRisks, topHotspots, type Hotspot } from '../analysis/hotspots.js';
import {
  buildPackageGraph,
  supportingEdges,
  DEPENDENCY_EDGE_KINDS,
  type PackageGraph,
  type SupportingEdge,
} from '../analysis/package-graph.js';
import type { NodeKind } from '../facts/types.js';

/** Kinds that declare a type. A member's owner is the nearest one of these. */
const TYPE_KINDS: readonly NodeKind[] = ['class', 'interface', 'enum', 'annotation'];

/** Default rows per answer. Enough to be useful, few enough to read. */
export const DEFAULT_LIMIT = 20;

/** Citable examples attached to an aggregated row. */
const EXAMPLES_PER_ROW = 3;

export interface NodeSummary {
  fqn: string;
  kind: string;
  name: string;
  file: string | null;
  line: number | null;
  /**
   * False for a node that exists only because an edge named it — a call into a
   * jar nobody parsed. It is a real reference and not a real declaration, and
   * the two must not read the same.
   */
  declared: boolean;
}

export interface EdgeSummary {
  kind: string;
  from: string;
  to: string;
  file: string | null;
  line: number | null;
}

/** What this database can and cannot answer. See `describeRun`. */
export interface Coverage {
  /** Any extracted code at all. */
  facts: boolean;
  /** Any dependency edges — without these, "no dependency" is not a finding. */
  staticGraph: boolean;
  /** Any mined commits. */
  history: boolean;
  /** Any per-file metrics, i.e. churn and complexity. */
  metrics: boolean;
  /**
   * Any stored output from `analyze` at all: a cluster, a finding, or a coupled
   * pair. False means no rule has been evaluated against this run, which reads
   * identically to "every rule passed" unless something says so — see
   * ADR-0021 on why an empty findings list must state which kind of empty it is.
   *
   * This describes what the store holds, never which commands were run: a run
   * that `analyze` genuinely left with nothing to say is reported the same way,
   * and the remedy printed is the same one.
   */
  analysis: boolean;
  /** Any model-authored cluster names or findings. */
  interpretation: boolean;
}

export interface RunSummary {
  runId: number;
  repoPath: string;
  /** HEAD when the facts were gathered. Answers describe this commit, not the work tree. */
  repoHead: string | null;
  toolVersion: string;
  startedAt: string;
  status: string;
  counts: {
    files: number;
    nodes: number;
    edges: number;
    packages: number;
    types: number;
    endpoints: number;
    tables: number;
    commits: number;
    clusters: number;
  };
  /** Which extractors declared facts in this run. */
  extractors: string[];
  /** Languages seen, from `source_file`. */
  languages: string[];
  coverage: Coverage;
  /** What is missing, and the command that would fix it. */
  gaps: string[];
}

/**
 * What this run contains, and what it does not.
 *
 * The gaps matter more than the counts. An agent that asks for Angular
 * components in a run where only the Java extractor was ever pointed at the
 * repository gets an empty list, and without this it has no way to tell that
 * from "this codebase has no Angular in it" (ADR-0015).
 */
export function describeRun(db: Db, runId: number): RunSummary | null {
  const run = db
    .prepare(
      `SELECT id, repo_path AS repoPath, repo_head AS repoHead, tool_version AS toolVersion,
              started_at AS startedAt, status
         FROM run WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: number;
        repoPath: string;
        repoHead: string | null;
        toolVersion: string;
        startedAt: string;
        status: string;
      }
    | undefined;
  if (run === undefined) return null;

  const counts = {
    files: count(db, 'SELECT COUNT(*) AS n FROM source_file WHERE run_id = ?', runId),
    nodes: count(db, 'SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND is_stub = 0', runId),
    edges: count(db, 'SELECT COUNT(*) AS n FROM edge WHERE run_id = ?', runId),
    packages: countKind(db, runId, 'package'),
    types: count(
      db,
      `SELECT COUNT(*) AS n FROM node
        WHERE run_id = ? AND is_stub = 0 AND kind IN ('class','interface','enum','annotation')`,
      runId,
    ),
    endpoints: countKind(db, runId, 'endpoint'),
    tables: countKind(db, runId, 'table'),
    commits: count(db, 'SELECT COUNT(*) AS n FROM git_commit WHERE run_id = ?', runId),
    clusters: count(db, 'SELECT COUNT(*) AS n FROM cluster WHERE run_id = ?', runId),
  };

  const coverage: Coverage = {
    facts: counts.nodes > 0,
    staticGraph: dependencyEdgeCount(db, runId) > 0,
    history: counts.commits > 0,
    metrics: count(db, 'SELECT COUNT(*) AS n FROM file_metric WHERE run_id = ?', runId) > 0,
    analysis:
      counts.clusters > 0 ||
      count(db, 'SELECT COUNT(*) AS n FROM finding WHERE run_id = ?', runId) > 0 ||
      count(db, 'SELECT COUNT(*) AS n FROM temporal_coupling WHERE run_id = ?', runId) > 0,
    interpretation:
      count(
        db,
        `SELECT COUNT(*) AS n FROM cluster WHERE run_id = ? AND authored_by = 'model'`,
        runId,
      ) > 0,
  };

  const gaps: string[] = [];
  if (!coverage.facts) {
    gaps.push(
      'No code was extracted into this run — every structural answer will be empty ' +
        'because nothing was parsed, not because nothing is there. Fix: `stratigraph extract`.',
    );
  } else if (!coverage.staticGraph) {
    gaps.push(
      'This run has nodes but no dependency edges, so "nothing depends on X" cannot be ' +
        'concluded from it.',
    );
  }
  if (!coverage.history) {
    gaps.push(
      'No git history was mined — hotspots, churn and co-change are unavailable. ' +
        'Fix: `stratigraph history`.',
    );
  }
  if (!coverage.interpretation && counts.clusters > 0) {
    gaps.push(
      'Clusters exist but none was named by a model; cluster names and descriptions ' +
        'will be absent. That is the `--no-llm` path, and everything structural is unaffected.',
    );
  }
  if (!coverage.analysis) {
    gaps.push(
      'No analysis output is stored for this run — no cluster, no finding, no coupled ' +
        'pair. An empty findings list here means no rule was evaluated, not that every ' +
        'rule passed. Fix: `stratigraph analyze`.',
    );
  } else if (counts.clusters === 0) {
    gaps.push('No clustering has been run for this run. Fix: `stratigraph analyze`.');
  }

  return {
    runId: run.id,
    repoPath: run.repoPath,
    repoHead: run.repoHead,
    toolVersion: run.toolVersion,
    startedAt: run.startedAt,
    status: run.status,
    counts,
    extractors: (
      db
        .prepare(
          `SELECT DISTINCT extractor FROM node
            WHERE run_id = ? AND extractor IS NOT NULL ORDER BY extractor`,
        )
        .all(runId) as Array<{ extractor: string }>
    ).map((row) => row.extractor),
    languages: (
      db
        .prepare(
          `SELECT DISTINCT language FROM source_file WHERE run_id = ? ORDER BY language`,
        )
        .all(runId) as Array<{ language: string }>
    ).map((row) => row.language),
    coverage,
    gaps,
  };
}

export interface FindNodeOptions {
  query: string;
  kind?: string | undefined;
  limit?: number | undefined;
  /** Include nodes that were only ever referenced, never declared. */
  includeUndeclared?: boolean | undefined;
}

export interface FindNodeResult {
  covered: boolean;
  total: number;
  nodes: NodeSummary[];
}

/**
 * Resolve a name, or part of one, to nodes.
 *
 * ADR-0007 makes an `fqn` guessable from source, which is what makes the other
 * tools usable by an agent that has the file open. Guessable is not certain,
 * and a wrong guess otherwise comes back as an empty result that looks like an
 * answer. This turns the guess into a lookup.
 *
 * Exact matches sort first, then prefix, then the rest — a caller that guessed
 * right should not have to read past four near misses to see it.
 */
export function findNode(db: Db, runId: number, options: FindNodeOptions): FindNodeResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const query = options.query.trim();
  const covered = count(db, 'SELECT COUNT(*) AS n FROM node WHERE run_id = ?', runId) > 0;
  if (query.length === 0) return { covered, total: 0, nodes: [] };

  const conditions = [
    'n.run_id = @runId',
    // ESCAPE binds to its own LIKE, so it goes here rather than after the
    // assembled WHERE clause.
    "(n.fqn LIKE @like ESCAPE '\\' OR n.name LIKE @like ESCAPE '\\')",
  ];
  if (options.kind !== undefined) conditions.push('n.kind = @kind');
  if (options.includeUndeclared !== true) conditions.push('n.is_stub = 0');

  const where = conditions.join(' AND ');
  const params = {
    runId,
    like: `%${escapeLike(query)}%`,
    exact: query,
    prefix: `${escapeLike(query)}%`,
    kind: options.kind ?? null,
    limit,
  };

  const total = count(db, `SELECT COUNT(*) AS n FROM node n WHERE ${where}`, params);

  const nodes = db
    .prepare(
      /* sql */ `
      SELECT n.fqn, n.kind, n.name, f.path AS file, n.start_line AS line,
             n.is_stub AS isStub
        FROM node n
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE ${where}
       ORDER BY CASE WHEN n.fqn = @exact THEN 0
                     WHEN n.name = @exact THEN 1
                     WHEN n.fqn LIKE @prefix ESCAPE '\\' THEN 2
                     ELSE 3 END,
                LENGTH(n.fqn), n.fqn
       LIMIT @limit`,
    )
    .all(params) as Array<Omit<NodeSummary, 'declared'> & { isStub: number }>;

  return { covered, total, nodes: nodes.map(toNodeSummary) };
}

export interface DependencyRow {
  /** The other end, at package granularity for a package, type granularity otherwise. */
  fqn: string;
  kind: string;
  /** Sum of the observed edge weights — how many references, not how many edges. */
  weight: number;
  edgeKinds: string[];
  /** Enough edges to check the row by opening a file. */
  examples: EdgeSummary[];
}

export interface DependenciesResult {
  found: boolean;
  covered: boolean;
  subject: NodeSummary | null;
  /** Granularity of the rows: package-to-package, or type-to-type. */
  granularity: 'package' | 'type' | null;
  dependsOn: DependencyRow[];
  dependedOnBy: DependencyRow[];
  note: string | null;
}

/**
 * What a package or type depends on, and what depends on it.
 *
 * A package subject goes through `buildPackageGraph` — the same aggregation
 * `analyze` reports cycles from, so the two can never disagree about what the
 * graph says. A type subject is aggregated here, over the type and everything
 * it declares, because a class's dependencies live mostly on its methods.
 *
 * `DEPENDENCY_EDGE_KINDS` is the shared definition of "code here depends on
 * code there"; `handles`, `maps_to` and `annotated_with` are deliberately not
 * in it (see `package-graph.ts`).
 */
export function queryDependencies(
  db: Db,
  runId: number,
  options: { fqn: string; limit?: number | undefined },
): DependenciesResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const covered = dependencyEdgeCount(db, runId) > 0;
  const subject = lookup(db, runId, options.fqn);

  if (subject === null) {
    return {
      found: false,
      covered,
      subject: null,
      granularity: null,
      dependsOn: [],
      dependedOnBy: [],
      note: null,
    };
  }

  const note = covered
    ? null
    : 'This run contains no dependency edges at all, so an empty result here means ' +
      'nothing was parsed — not that nothing depends on this.';

  if (subject.node.kind === 'package') {
    const graph = buildPackageGraph(db, runId);
    return {
      found: true,
      covered,
      subject: subject.summary,
      granularity: 'package',
      dependsOn: packageEdges(db, runId, graph, subject.node.id, 'out', limit),
      dependedOnBy: packageEdges(db, runId, graph, subject.node.id, 'in', limit),
      note,
    };
  }

  return {
    found: true,
    covered,
    subject: subject.summary,
    granularity: 'type',
    dependsOn: typeEdges(db, runId, subject.node.id, 'out', limit),
    dependedOnBy: typeEdges(db, runId, subject.node.id, 'in', limit),
    note,
  };
}

export interface CallerRow {
  /** The calling method or type. */
  caller: string;
  callerKind: string;
  /** The member actually called, when the subject is a type. */
  callee: string;
  file: string | null;
  line: number | null;
  edgeKind: string;
}

export interface CallersResult {
  found: boolean;
  covered: boolean;
  subject: NodeSummary | null;
  total: number;
  callers: CallerRow[];
  note: string | null;
}

/**
 * Who calls this method, or anything this type declares.
 *
 * `injects` counts as a caller: a Spring bean wired into a constructor is a
 * dependency on that type by any reading, and leaving it out would let
 * "nothing calls this" be said about a service used everywhere.
 */
export function findCallers(
  db: Db,
  runId: number,
  options: { fqn: string; limit?: number | undefined },
): CallersResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const covered =
    count(
      db,
      `SELECT COUNT(*) AS n FROM edge WHERE run_id = ? AND kind IN ('calls','injects')`,
      runId,
    ) > 0;
  const subject = lookup(db, runId, options.fqn);

  if (subject === null) {
    return { found: false, covered, subject: null, total: 0, callers: [], note: null };
  }

  const params = { runId, nodeId: subject.node.id, limit };
  const inbound = /* sql */ `
    WITH RECURSIVE subtree(id) AS (
        SELECT @nodeId
      UNION
        SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
    )
    SELECT src.fqn AS caller, src.kind AS callerKind, dst.fqn AS callee,
           f.path AS file, e.line AS line, e.kind AS edgeKind
      FROM edge e
      JOIN subtree t   ON t.id = e.dst_id
      JOIN node src    ON src.id = e.src_id
      JOIN node dst    ON dst.id = e.dst_id
      LEFT JOIN source_file f ON f.id = e.file_id
     WHERE e.run_id = @runId
       AND e.kind IN ('calls','injects')
       AND e.confidence = 'fact'
       AND e.src_id NOT IN (SELECT id FROM subtree)`;

  const total = count(db, `SELECT COUNT(*) AS n FROM (${inbound})`, params);
  const callers = db
    .prepare(`${inbound} ORDER BY src.fqn, f.path, e.line LIMIT @limit`)
    .all(params) as CallerRow[];

  return {
    found: true,
    covered,
    subject: subject.summary,
    total,
    callers,
    note: covered
      ? null
      : 'This run contains no call or injection edges, so an empty result means nothing ' +
        'was parsed — not that nothing calls this.',
  };
}

export interface EndpointRow {
  /** `<METHOD> <path>` — see ADR-0007. */
  fqn: string;
  httpMethod: string | null;
  path: string | null;
  framework: string | null;
  handler: string | null;
  file: string | null;
  line: number | null;
}

export interface EndpointsResult {
  covered: boolean;
  total: number;
  endpoints: EndpointRow[];
  note: string | null;
}

/**
 * The HTTP surface, with the method that serves each route.
 *
 * The handler comes from a `handles` edge, which the extractor emits at the
 * annotated method's own line — so every row here can be opened and read.
 */
export function listEndpoints(
  db: Db,
  runId: number,
  options: { contains?: string | undefined; httpMethod?: string | undefined; limit?: number | undefined } = {},
): EndpointsResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const covered = countKind(db, runId, 'endpoint') > 0;

  const conditions = ["n.run_id = @runId", "n.kind = 'endpoint'"];
  if (options.contains !== undefined && options.contains.trim() !== '') {
    conditions.push("n.fqn LIKE @like ESCAPE '\\'");
  }
  if (options.httpMethod !== undefined && options.httpMethod.trim() !== '') {
    conditions.push('UPPER(@httpMethod) = UPPER(SUBSTR(n.fqn, 1, LENGTH(@httpMethod)))');
  }
  const where = conditions.join(' AND ');
  const params = {
    runId,
    like: `%${escapeLike(options.contains ?? '')}%`,
    httpMethod: options.httpMethod ?? '',
    limit,
  };

  const total = count(db, `SELECT COUNT(*) AS n FROM node n WHERE ${where}`, params);
  const rows = db
    .prepare(
      /* sql */ `
      SELECT n.fqn, n.attrs AS attrs, n.name AS name,
             handler.fqn AS handler,
             COALESCE(hf.path, nf.path) AS file,
             COALESCE(h.line, n.start_line) AS line
        FROM node n
        LEFT JOIN edge h        ON h.run_id = n.run_id AND h.dst_id = n.id AND h.kind = 'handles'
        LEFT JOIN node handler  ON handler.id = h.src_id
        LEFT JOIN source_file hf ON hf.id = h.file_id
        LEFT JOIN source_file nf ON nf.id = n.file_id
       WHERE ${where}
       ORDER BY n.fqn
       LIMIT @limit`,
    )
    .all(params) as Array<{
    fqn: string;
    attrs: string | null;
    name: string;
    handler: string | null;
    file: string | null;
    line: number | null;
  }>;

  return {
    covered,
    total,
    endpoints: rows.map((row) => {
      const space = row.fqn.indexOf(' ');
      return {
        fqn: row.fqn,
        httpMethod: space === -1 ? null : row.fqn.slice(0, space),
        path: space === -1 ? null : row.fqn.slice(space + 1),
        framework: attr(row.attrs, 'framework'),
        handler: row.handler,
        file: row.file,
        line: row.line,
      };
    }),
    note: covered
      ? null
      : 'No endpoints were extracted in this run. If the codebase is a web service, ' +
        'either its framework is not one the extractor recognises or no extraction has run.',
  };
}

export interface ModuleResult {
  found: boolean;
  subject: NodeSummary | null;
  /** Types declared directly in the package. */
  members: NodeSummary[];
  memberCount: number;
  endpoints: EndpointRow[];
  tables: Array<{ table: string; mappedBy: string; file: string | null; line: number | null }>;
  dependsOn: DependencyRow[];
  dependedOnBy: DependencyRow[];
  /** Aggregated `file_metric` rows for the package's files. Null without history. */
  history: {
    files: number;
    commits: number;
    churn: number;
    authors: number;
    lastChangeAt: string | null;
  } | null;
  /**
   * The cluster this package was grouped into, and — separately — whatever a
   * model called it. Never merged: ADR-0015 keeps interpretation labelled, so a
   * caller can use the structure and ignore the prose.
   */
  cluster: {
    clusterId: number;
    label: number;
    memberCount: number;
    siblings: string[];
    interpretation: {
      name: string | null;
      description: string | null;
      authoredBy: 'model';
      model: string | null;
    } | null;
  } | null;
  note: string | null;
}

/**
 * Everything the store knows about one package, in one call.
 *
 * The point of this tool is to save an agent five round trips when it is
 * orienting itself. Every part of the answer is available separately; nothing
 * here is computed differently from the tool that computes it alone.
 */
export function describeModule(
  db: Db,
  runId: number,
  options: { fqn: string; limit?: number | undefined },
): ModuleResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const subject = lookup(db, runId, options.fqn);

  if (subject === null || subject.node.kind !== 'package') {
    return {
      found: false,
      subject: subject?.summary ?? null,
      members: [],
      memberCount: 0,
      endpoints: [],
      tables: [],
      dependsOn: [],
      dependedOnBy: [],
      history: null,
      cluster: null,
      note:
        subject === null
          ? null
          : `${options.fqn} is a ${subject.node.kind}, not a package — ` +
            `use query_dependencies or find_callers for it.`,
    };
  }

  const packageId = subject.node.id;
  const memberRows = db
    .prepare(
      /* sql */ `
      SELECT n.fqn, n.kind, n.name, f.path AS file, n.start_line AS line, n.is_stub AS isStub
        FROM node n
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = @runId AND n.parent_id = @packageId AND n.is_stub = 0
       ORDER BY n.fqn
       LIMIT @limit`,
    )
    .all({ runId, packageId, limit }) as Array<Omit<NodeSummary, 'declared'> & { isStub: number }>;

  const memberCount = count(
    db,
    'SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND parent_id = ? AND is_stub = 0',
    runId,
    packageId,
  );

  const graph = buildPackageGraph(db, runId);

  return {
    found: true,
    subject: subject.summary,
    members: memberRows.map(toNodeSummary),
    memberCount,
    endpoints: packageEndpoints(db, runId, packageId, limit),
    tables: packageTables(db, runId, packageId, limit),
    dependsOn: packageEdges(db, runId, graph, packageId, 'out', limit),
    dependedOnBy: packageEdges(db, runId, graph, packageId, 'in', limit),
    history: packageHistory(db, runId, packageId),
    cluster: packageCluster(db, runId, packageId),
    note: null,
  };
}

export interface HotspotsResult {
  covered: boolean;
  ranking: 'churn-complexity' | 'bus-factor';
  files: Hotspot[];
  note: string | null;
}

/**
 * Files where change and difficulty meet, or files whose history is one person.
 *
 * Straight through to the M2 analyses, so the numbers an agent gets are the
 * numbers `analyze` prints. Both are arithmetic over `git log` (ADR-0010) — no
 * judgement is being served here, and bus factor in particular is a fact about
 * a file's commits, not about a person.
 */
export function findHotspots(
  db: Db,
  runId: number,
  options: {
    ranking?: 'churn-complexity' | 'bus-factor' | undefined;
    limit?: number | undefined;
    minCommits?: number | undefined;
  } = {},
): HotspotsResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ranking = options.ranking ?? 'churn-complexity';
  const covered = count(db, 'SELECT COUNT(*) AS n FROM file_metric WHERE run_id = ?', runId) > 0;

  const files = covered
    ? ranking === 'bus-factor'
      ? busFactorRisks(db, runId, limit, options.minCommits ?? 5)
      : topHotspots(db, runId, limit)
    : [];

  return {
    covered,
    ranking,
    files,
    note: covered
      ? null
      : 'No history has been mined into this run, so there are no churn or complexity ' +
        'numbers to rank. Fix: `stratigraph history`.',
  };
}

export interface TableTraceResult {
  found: boolean;
  covered: boolean;
  table: string | null;
  /** Types declaring a mapping to the table, with the line that declares it. */
  mappedBy: Array<{ fqn: string; file: string | null; line: number | null }>;
  /** What calls or injects those types, one hop out. */
  reachedFrom: CallerRow[];
  /** Stated in the result, not only in the docs. See ADR-0015. */
  limits: string;
  note: string | null;
}

/**
 * What connects to a table, one citable hop at a time.
 *
 * This is deliberately not "data flow". The Java extractor emits `maps_to` — a
 * declared `@Entity`/`@Table` correspondence — and does not emit `reads_table`
 * or `writes_table`. So what can be shown is: the types mapped to this table,
 * and what calls or injects those types. Each hop is an edge with a file and a
 * line. Chaining call edges until something plausible appeared would be
 * inventing the answer that was asked for, which is the one thing this tool
 * must not do.
 */
export function traceToTable(
  db: Db,
  runId: number,
  options: { table: string; limit?: number | undefined },
): TableTraceResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const covered = count(
    db,
    `SELECT COUNT(*) AS n FROM edge WHERE run_id = ? AND kind = 'maps_to'`,
    runId,
  ) > 0;
  const limits =
    'Mappings are declared `@Entity`/`@Table` correspondences. This run has no ' +
    'statement-level table reads or writes, so nothing here claims that a query ran.';

  // ADR-0007 lower-cases a table fqn; a caller who types the declared spelling
  // must still find it.
  const name = options.table.trim().toLowerCase();
  const table = db
    .prepare(`SELECT id, fqn FROM node WHERE run_id = ? AND kind = 'table' AND fqn = ?`)
    .get(runId, name) as { id: number; fqn: string } | undefined;

  if (table === undefined) {
    return {
      found: false,
      covered,
      table: null,
      mappedBy: [],
      reachedFrom: [],
      limits,
      note: covered
        ? null
        : 'No table mappings were extracted in this run at all.',
    };
  }

  const mappedBy = db
    .prepare(
      /* sql */ `
      SELECT src.fqn AS fqn, f.path AS file, e.line AS line
        FROM edge e
        JOIN node src ON src.id = e.src_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE e.run_id = @runId AND e.kind = 'maps_to' AND e.dst_id = @tableId
       ORDER BY src.fqn
       LIMIT @limit`,
    )
    .all({ runId, tableId: table.id, limit }) as Array<{
    fqn: string;
    file: string | null;
    line: number | null;
  }>;

  const reachedFrom = mappedBy.flatMap(
    (entity) => findCallers(db, runId, { fqn: entity.fqn, limit }).callers,
  );

  return {
    found: true,
    covered,
    table: table.fqn,
    mappedBy,
    reachedFrom: reachedFrom.slice(0, limit),
    limits,
    note: mappedBy.length === 0 ? 'The table node exists, but no type declares a mapping to it.' : null,
  };
}

export interface CyclePath {
  path: string[];
  hops: Array<{ from: string; to: string; evidence: SupportingEdge[] }>;
}

export interface CycleCheckResult {
  found: boolean;
  covered: boolean;
  /** Which of the two names did not resolve, when one did not. */
  missing: string[];
  cyclic: boolean;
  forward: CyclePath | null;
  backward: CyclePath | null;
  note: string | null;
}

/**
 * Is there a dependency path each way between two packages?
 *
 * Computed from the graph rather than read from stored findings, because
 * `analyze` reports the *shortest cycle per component* and the question here is
 * about a specific pair — which may sit in a large component whose reported
 * cycle does not mention either of them. Every hop carries the edges that
 * justify it, so the answer is checkable line by line (ADR-0008).
 */
export function checkCycle(
  db: Db,
  runId: number,
  options: { from: string; to: string },
): CycleCheckResult {
  const covered = dependencyEdgeCount(db, runId) > 0;
  const graph = buildPackageGraph(db, runId);
  const byFqn = new Map([...graph.packages.values()].map((pkg) => [pkg.fqn, pkg.id]));

  const fromId = byFqn.get(options.from);
  const toId = byFqn.get(options.to);
  const missing = [
    ...(fromId === undefined ? [options.from] : []),
    ...(toId === undefined ? [options.to] : []),
  ];

  if (fromId === undefined || toId === undefined) {
    return {
      found: false,
      covered,
      missing,
      cyclic: false,
      forward: null,
      backward: null,
      note: covered
        ? 'No package with that name is in this run. `find_node` with kind "package" lists what is.'
        : 'This run has no package dependency graph — nothing was extracted.',
    };
  }

  const forward = shortestPath(db, runId, graph, fromId, toId);
  const backward = shortestPath(db, runId, graph, toId, fromId);

  return {
    found: true,
    covered,
    missing: [],
    cyclic: forward !== null && backward !== null,
    forward,
    backward,
    note:
      forward === null && backward === null
        ? 'Neither package reaches the other. They are independent in the static graph.'
        : null,
  };
}

/* ------------------------------------------------------------------ helpers */

interface Resolved {
  node: { id: number; kind: string; fqn: string };
  summary: NodeSummary;
}

/**
 * Exact `fqn` lookup, preferring a declared node over a stub.
 *
 * Exact rather than fuzzy on purpose: a tool that quietly answers about a
 * different node than the one asked for is worse than one that says it found
 * nothing, and `find_node` exists for the fuzzy case.
 */
function lookup(db: Db, runId: number, fqn: string): Resolved | null {
  const row = db
    .prepare(
      /* sql */ `
      SELECT n.id, n.kind, n.fqn, n.name, f.path AS file, n.start_line AS line,
             n.is_stub AS isStub
        FROM node n
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = ? AND n.fqn = ?
       ORDER BY n.is_stub, n.id
       LIMIT 1`,
    )
    .get(runId, fqn.trim()) as
    | (Omit<NodeSummary, 'declared'> & { id: number; isStub: number })
    | undefined;

  if (row === undefined) return null;
  return {
    node: { id: row.id, kind: row.kind, fqn: row.fqn },
    summary: toNodeSummary(row),
  };
}

/** Aggregated package-to-package dependencies, with citable examples. */
function packageEdges(
  db: Db,
  runId: number,
  graph: PackageGraph,
  packageId: number,
  direction: 'in' | 'out',
  limit: number,
): DependencyRow[] {
  const rows = graph.dependencies
    .filter((dep) => (direction === 'out' ? dep.src === packageId : dep.dst === packageId))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  return rows.map((dep) => {
    const otherId = direction === 'out' ? dep.dst : dep.src;
    const examples = supportingEdges(db, runId, dep.src, dep.dst, EXAMPLES_PER_ROW);
    return {
      fqn: graph.packages.get(otherId)?.fqn ?? '<unknown>',
      kind: 'package',
      weight: dep.weight,
      edgeKinds: [...new Set(examples.map((edge) => edge.kind))].sort(),
      examples: examples.map(toEdgeSummary),
    };
  });
}

/**
 * Aggregated type-to-type dependencies for one type and everything it declares.
 *
 * The other end is rolled up to its declaring type where it has one — a call to
 * `OrderService#save(...)` is a dependency on `OrderService` — and left as
 * itself where it has none, which is how endpoints and tables survive the
 * rollup instead of vanishing.
 */
function typeEdges(
  db: Db,
  runId: number,
  nodeId: number,
  direction: 'in' | 'out',
  limit: number,
): DependencyRow[] {
  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const typeKinds = TYPE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const near = direction === 'out' ? 'src_id' : 'dst_id';
  const far = direction === 'out' ? 'dst_id' : 'src_id';

  const rows = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        subtree(id) AS (
            SELECT @nodeId
          UNION
            SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
        ),
        -- Only the far ends of the edges we are about to aggregate. Seeding
        -- ancestry from every node in the run instead would walk the whole
        -- tree of a 47,000-node repository to answer a question about one
        -- class.
        far_node(id) AS (
          SELECT DISTINCT e.${far}
            FROM edge e JOIN subtree t ON t.id = e.${near}
           WHERE e.run_id = @runId
             AND e.kind IN (${kinds})
             AND e.confidence = 'fact'
        ),
        ancestry(start_id, node_id, kind, depth) AS (
            SELECT n.id, n.id, n.kind, 0 FROM far_node fn JOIN node n ON n.id = fn.id
          UNION ALL
            SELECT a.start_id, p.id, p.kind, a.depth + 1
              FROM ancestry a
              JOIN node c ON c.id = a.node_id
              JOIN node p ON p.id = c.parent_id
             WHERE a.kind NOT IN (${typeKinds}) AND a.depth < 8
        ),
        owner(node_id, owner_id) AS (
          SELECT start_id, node_id FROM ancestry
           WHERE kind IN (${typeKinds})
           GROUP BY start_id HAVING depth = MIN(depth)
        )
      SELECT COALESCE(o.fqn, far.fqn)   AS fqn,
             COALESCE(o.kind, far.kind) AS kind,
             SUM(e.weight)              AS weight,
             GROUP_CONCAT(DISTINCT e.kind) AS edgeKinds,
             COALESCE(o.id, far.id)     AS ownerId
        FROM edge e
        JOIN subtree t ON t.id = e.${near}
        JOIN node far  ON far.id = e.${far}
        LEFT JOIN owner ow ON ow.node_id = far.id
        LEFT JOIN node o   ON o.id = ow.owner_id
       WHERE e.run_id = @runId
         AND e.kind IN (${kinds})
         AND e.confidence = 'fact'
         AND e.${far} NOT IN (SELECT id FROM subtree)
       GROUP BY ownerId
       ORDER BY weight DESC, fqn
       LIMIT @limit`,
    )
    .all({ runId, nodeId, limit }) as Array<{
    fqn: string;
    kind: string;
    weight: number;
    edgeKinds: string;
    ownerId: number;
  }>;

  const examples = db.prepare(
    /* sql */ `
      WITH RECURSIVE
        subtree(id) AS (
            SELECT @nodeId
          UNION
            SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
        ),
        target(id) AS (
            SELECT @ownerId
          UNION
            SELECT n.id FROM node n JOIN target t ON n.parent_id = t.id
        )
      SELECT e.kind AS kind, src.fqn AS "from", dst.fqn AS "to",
             f.path AS file, e.line AS line
        FROM edge e
        JOIN node src ON src.id = e.src_id
        JOIN node dst ON dst.id = e.dst_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE e.run_id = @runId
         AND e.kind IN (${kinds})
         AND e.confidence = 'fact'
         AND e.${near} IN (SELECT id FROM subtree)
         AND e.${far} IN (SELECT id FROM target)
       ORDER BY f.path, e.line
       LIMIT ${EXAMPLES_PER_ROW}`,
  );

  return rows.map((row) => ({
    fqn: row.fqn,
    kind: row.kind,
    weight: row.weight,
    edgeKinds: (row.edgeKinds ?? '').split(',').filter(Boolean).sort(),
    examples: examples.all({ runId, nodeId, ownerId: row.ownerId }) as EdgeSummary[],
  }));
}

/** Endpoints served by methods declared anywhere under a package. */
function packageEndpoints(
  db: Db,
  runId: number,
  packageId: number,
  limit: number,
): EndpointRow[] {
  return (
    db
      .prepare(
        /* sql */ `
        WITH RECURSIVE subtree(id) AS (
            SELECT @packageId
          UNION
            SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
        )
        SELECT ep.fqn AS fqn, ep.attrs AS attrs, src.fqn AS handler,
               f.path AS file, e.line AS line
          FROM edge e
          JOIN subtree t ON t.id = e.src_id
          JOIN node src  ON src.id = e.src_id
          JOIN node ep   ON ep.id = e.dst_id
          LEFT JOIN source_file f ON f.id = e.file_id
         WHERE e.run_id = @runId AND e.kind = 'handles'
         ORDER BY ep.fqn
         LIMIT @limit`,
      )
      .all({ runId, packageId, limit }) as Array<{
      fqn: string;
      attrs: string | null;
      handler: string;
      file: string | null;
      line: number | null;
    }>
  ).map((row) => {
    const space = row.fqn.indexOf(' ');
    return {
      fqn: row.fqn,
      httpMethod: space === -1 ? null : row.fqn.slice(0, space),
      path: space === -1 ? null : row.fqn.slice(space + 1),
      framework: attr(row.attrs, 'framework'),
      handler: row.handler,
      file: row.file,
      line: row.line,
    };
  });
}

/** Tables mapped by types declared anywhere under a package. */
function packageTables(
  db: Db,
  runId: number,
  packageId: number,
  limit: number,
): Array<{ table: string; mappedBy: string; file: string | null; line: number | null }> {
  return db
    .prepare(
      /* sql */ `
      WITH RECURSIVE subtree(id) AS (
          SELECT @packageId
        UNION
          SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT tbl.fqn AS "table", src.fqn AS mappedBy, f.path AS file, e.line AS line
        FROM edge e
        JOIN subtree t ON t.id = e.src_id
        JOIN node src  ON src.id = e.src_id
        JOIN node tbl  ON tbl.id = e.dst_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE e.run_id = @runId AND e.kind = 'maps_to'
       ORDER BY tbl.fqn
       LIMIT @limit`,
    )
    .all({ runId, packageId, limit }) as Array<{
    table: string;
    mappedBy: string;
    file: string | null;
    line: number | null;
  }>;
}

/**
 * History for a package's files, aggregated from `file_metric`.
 *
 * Joined through `source_file`, so a package with no parsed files — or a run
 * with no history — returns null rather than a row of zeroes. Zeroes would say
 * "never changed", which is a different claim from "not measured".
 */
function packageHistory(
  db: Db,
  runId: number,
  packageId: number,
): ModuleResult['history'] {
  const row = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE subtree(id) AS (
          SELECT @packageId
        UNION
          SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT COUNT(*) AS files, SUM(m.commits) AS commits, SUM(m.churn) AS churn,
             MAX(m.authors) AS authors, MAX(m.last_change_at) AS lastChangeAt
        FROM file_metric m
       WHERE m.run_id = @runId
         AND m.path IN (
           SELECT DISTINCT f.path
             FROM node n JOIN source_file f ON f.id = n.file_id
            WHERE n.id IN (SELECT id FROM subtree)
         )`,
    )
    .get({ runId, packageId }) as {
    files: number;
    commits: number | null;
    churn: number | null;
    authors: number | null;
    lastChangeAt: string | null;
  };

  if (row.files === 0) return null;
  return {
    files: row.files,
    commits: row.commits ?? 0,
    churn: row.churn ?? 0,
    authors: row.authors ?? 0,
    lastChangeAt: row.lastChangeAt,
  };
}

/** The cluster a package landed in, with model-authored text kept separate. */
function packageCluster(
  db: Db,
  runId: number,
  packageId: number,
): ModuleResult['cluster'] {
  const row = db
    .prepare(
      /* sql */ `
      SELECT c.id AS clusterId, c.label AS label, c.name AS name,
             c.description AS description, c.authored_by AS authoredBy, c.model AS model
        FROM cluster_member m
        JOIN cluster c ON c.id = m.cluster_id
       WHERE c.run_id = @runId AND m.node_id = @packageId
       LIMIT 1`,
    )
    .get({ runId, packageId }) as
    | {
        clusterId: number;
        label: number;
        name: string | null;
        description: string | null;
        authoredBy: string;
        model: string | null;
      }
    | undefined;

  if (row === undefined) return null;

  const siblings = (
    db
      .prepare(
        `SELECT n.fqn FROM cluster_member m JOIN node n ON n.id = m.node_id
          WHERE m.cluster_id = ? AND m.node_id <> ? ORDER BY n.fqn`,
      )
      .all(row.clusterId, packageId) as Array<{ fqn: string }>
  ).map((sibling) => sibling.fqn);

  return {
    clusterId: row.clusterId,
    label: row.label,
    memberCount: siblings.length + 1,
    siblings,
    interpretation:
      row.authoredBy === 'model' && (row.name !== null || row.description !== null)
        ? {
            name: row.name,
            description: row.description,
            authoredBy: 'model',
            model: row.model,
          }
        : null,
  };
}

/** Shortest dependency path between two packages, with the edges for each hop. */
function shortestPath(
  db: Db,
  runId: number,
  graph: PackageGraph,
  fromId: number,
  toId: number,
): CyclePath | null {
  const previous = new Map<number, number>();
  const seen = new Set<number>([fromId]);
  const queue: number[] = [fromId];
  let reached = false;

  while (queue.length > 0 && !reached) {
    const node = queue.shift() as number;
    for (const next of graph.adjacency.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      if (next === toId) {
        reached = true;
        break;
      }
      queue.push(next);
    }
  }

  if (!reached && fromId !== toId) return null;

  const ids: number[] = [toId];
  for (let at = toId; previous.has(at); ) {
    at = previous.get(at) as number;
    ids.push(at);
  }
  ids.reverse();

  const hops = ids.slice(0, -1).map((id, index) => {
    const next = ids[index + 1] as number;
    return {
      from: graph.packages.get(id)?.fqn ?? '<unknown>',
      to: graph.packages.get(next)?.fqn ?? '<unknown>',
      evidence: supportingEdges(db, runId, id, next, EXAMPLES_PER_ROW),
    };
  });

  return { path: ids.map((id) => graph.packages.get(id)?.fqn ?? '<unknown>'), hops };
}

function toNodeSummary(row: Omit<NodeSummary, 'declared'> & { isStub: number }): NodeSummary {
  return {
    fqn: row.fqn,
    kind: row.kind,
    name: row.name,
    file: row.file,
    line: row.line,
    declared: row.isStub === 0,
  };
}

function toEdgeSummary(edge: SupportingEdge): EdgeSummary {
  return {
    kind: edge.kind,
    from: edge.srcFqn,
    to: edge.dstFqn,
    file: edge.path,
    line: edge.line,
  };
}

/** `attrs` is a JSON blob the extractor wrote; a malformed one is not fatal. */
function attr(attrs: string | null, key: string): string | null {
  if (attrs === null) return null;
  try {
    const parsed: unknown = JSON.parse(attrs);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** `%` and `_` in a user's search string are literals, not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function dependencyEdgeCount(db: Db, runId: number): number {
  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  return count(
    db,
    `SELECT COUNT(*) AS n FROM edge
      WHERE run_id = ? AND confidence = 'fact' AND kind IN (${kinds})`,
    runId,
  );
}

function countKind(db: Db, runId: number, kind: NodeKind): number {
  return count(
    db,
    'SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND kind = ? AND is_stub = 0',
    runId,
    kind,
  );
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...(params as never[])) as { n: number }).n;
}
