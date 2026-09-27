/**
 * The MCP surface: nine read-only tools over one pinned run (ADR-0015).
 *
 * Everything here is presentation. The queries live in `queries.ts` and are
 * tested without a protocol; this module decides what each tool is called, what
 * it accepts, and how an answer reads when a model receives it.
 *
 * Two rules shape the rendering:
 *
 * - **The text is the answer.** `structuredContent` carries the same data for
 *   clients that use it, but a client that shows only the text must still get
 *   every citation. So every line that makes a claim carries the file and line,
 *   the fqn, or the sha that supports it.
 * - **A caveat outranks a result.** When a run could not answer a question, the
 *   reason is the first line, not a footnote after an empty list.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_THRESHOLDS,
  runCoverage,
  VIEW_TITLES,
  VIEWS,
  type CoverageThresholds,
  type ViewId,
} from '../analysis/coverage.js';
import type { Db } from '../db/database.js';
import { NODE_KINDS } from '../facts/types.js';
import { TOOL_VERSION } from '../version.js';
import {
  explainHotspot,
  whatBreaksIf,
  whereIsTableWritten,
  whoKnows,
  type Impact,
  type TableAccess,
} from './questions.js';
import {
  checkCycle,
  DEFAULT_LIMIT,
  describeModule,
  describeRun,
  findCallers,
  findHotspots,
  findNode,
  listEndpoints,
  queryDependencies,
  traceToTable,
  type CyclePath,
  type DependencyRow,
  type EdgeSummary,
  type EndpointRow,
  type NodeSummary,
} from './queries.js';

export interface McpContext {
  db: Db;
  /** Pinned at startup. Every answer for the life of the process comes from it. */
  runId: number;
  /** For the bus-factor floor, from `history.minCommits`. */
  minCommits: number;
  /** When a view counts as below coverage (ADR-0033). Defaults to 50% for all. */
  thresholds?: CoverageThresholds | undefined;
}

/** Names the tools by the question they answer, for the tool list a client shows. */
export const SERVER_NAME = 'stratigraph';

const limitArg = z
  .number()
  .int()
  .positive()
  .max(500)
  .optional()
  .describe(`rows to return (default ${DEFAULT_LIMIT})`);

/**
 * Build the server. The caller owns the database and the transport, so tests
 * can drive this over an in-memory pair and the CLI over stdio.
 */
export function createServer(context: McpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: TOOL_VERSION },
    {
      instructions:
        'Structural facts about a codebase, extracted from its source and git history. ' +
        'Every answer describes one analysis run of one commit — call describe_run first ' +
        'to see what that run contains and, just as importantly, what it does not. ' +
        'Results carry file paths, line numbers and commit shas: cite them rather than ' +
        'restating them, and treat anything marked authoredBy "model" as inference.',
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const { db, runId } = context;

  // Computed once: the run is pinned and the store read-only, so no answer in
  // this process can see different coverage from another (ADR-0033).
  const coverage = runCoverage(db, runId, context.thresholds ?? DEFAULT_THRESHOLDS);

  /**
   * Every answer carries the coverage of the view it is drawn from — in the
   * text an agent reads, and in the structured result it can test. Answers are
   * never withheld: an agent told an answer is partial can reason about it.
   */
  const answer = (view: ViewId, body: string, structured: object): ToolText => {
    const stated = coverage.views[view];
    const footer = [
      '',
      `Coverage (${VIEW_TITLES[view]}): ${stated.statement}`,
      ...(stated.withheld || (stated.ratio !== null && stated.ratio < 1)
        ? [
            ...stated.reasons.map((reason) => `  - ${reason}`),
            'Anything absent from this answer may be in what was not read: treat absence as ' +
              'unknown, not as none.',
          ]
        : []),
    ];
    return text(`${body}\n${footer.join('\n')}`, { ...structured, coverage: stated });
  };

  server.registerTool(
    'describe_run',
    {
      title: 'Describe the analysed run',
      description:
        'What this fact store contains: the repository and commit it was built from, how ' +
        'much was extracted, whether git history was mined, whether clustering has run. ' +
        'Read the gaps before concluding anything from an empty result elsewhere.',
      inputSchema: {},
      annotations: readOnly,
    },
    () => {
      const summary = describeRun(db, runId, context.thresholds ?? DEFAULT_THRESHOLDS);
      if (summary === null) return text(`Run ${runId} is not in this database.`);

      const lines = [
        `run ${summary.runId} of ${summary.repoPath}`,
        `commit ${summary.repoHead ?? 'unknown'} — answers describe this commit, not your working tree`,
        `analysed by stratigraph ${summary.toolVersion} at ${summary.startedAt} (${summary.status})`,
        '',
        `${summary.counts.files} files, ${summary.counts.nodes} nodes, ${summary.counts.edges} edges`,
        `${summary.counts.packages} packages, ${summary.counts.types} types, ` +
          `${summary.counts.endpoints} endpoints, ${summary.counts.tables} tables`,
        `${summary.counts.commits} commits mined, ${summary.counts.clusters} clusters`,
        `extractors: ${summary.extractors.join(', ') || 'none'}` +
          `${summary.languages.length > 0 ? ` — languages: ${summary.languages.join(', ')}` : ''}`,
      ];
      lines.push('', 'Coverage by view:');
      for (const view of VIEWS) {
        lines.push(`  ${VIEW_TITLES[view]}: ${summary.coverage.views[view].statement}`);
      }
      if (summary.gaps.length > 0) {
        lines.push('', 'What this run cannot answer:');
        for (const gap of summary.gaps) lines.push(`  - ${gap}`);
      }
      return text(lines.join('\n'), summary);
    },
  );

  server.registerTool(
    'find_node',
    {
      title: 'Find a package, type or method by name',
      description:
        'Resolve a name, or part of one, to the nodes the extractor recorded. Use this to ' +
        'turn a class name from a file you are reading into the exact fqn the other tools ' +
        'take. Matches anywhere in the fully-qualified name.',
      inputSchema: {
        query: z.string().min(1).describe('a name or fragment, e.g. "OrderService" or "shop.web"'),
        kind: z
          .enum(NODE_KINDS)
          .optional()
          .describe('restrict to one kind of node, e.g. "package" or "method"'),
        includeUndeclared: z
          .boolean()
          .optional()
          .describe('include nodes only ever referenced, never declared — e.g. classes in a jar'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = findNode(db, runId, args);
      if (!result.covered) {
        return answer('architecture', 'No code has been extracted into this run, so there is nothing to match.', result);
      }
      if (result.nodes.length === 0) {
        return answer('architecture', 
          `Nothing matches "${args.query}" in run ${runId}. The run does contain extracted ` +
            `code, so this is an absence, not a gap.`,
          result,
        );
      }
      const lines = result.nodes.map((node) => `  ${nodeLine(node)}`);
      return answer('architecture', 
        [`${result.total} match(es) for "${args.query}":`, ...lines, more(result.nodes.length, result.total)]
          .filter(Boolean)
          .join('\n'),
        result,
      );
    },
  );

  server.registerTool(
    'query_dependencies',
    {
      title: 'What depends on what',
      description:
        'Dependencies in and out of a package or type — imports, calls, injections, ' +
        'inheritance — aggregated with example edges you can open. Package in, packages ' +
        'out; type in, types out.',
      inputSchema: {
        fqn: z.string().min(1).describe('exact fqn of a package or type; use find_node to get one'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = queryDependencies(db, runId, args);
      if (!result.found) return answer('architecture', notFound(args.fqn, result.covered), result);

      const lines = [`${result.subject?.fqn} (${result.subject?.kind})`];
      if (result.note !== null) lines.push(`  note: ${result.note}`);
      lines.push('', `depends on (${result.dependsOn.length}):`, ...dependencyLines(result.dependsOn));
      lines.push('', `depended on by (${result.dependedOnBy.length}):`, ...dependencyLines(result.dependedOnBy));
      return answer('architecture', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'find_callers',
    {
      title: 'Find callers of a method or type',
      description:
        'Every observed call into a method, or into anything a type declares, with the file ' +
        'and line of each call site. Constructor and field injection count as callers.',
      inputSchema: {
        fqn: z.string().min(1).describe('exact fqn, e.g. "com.example.OrderService#findAll()"'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = findCallers(db, runId, args);
      if (!result.found) return answer('architecture', notFound(args.fqn, result.covered), result);
      if (result.callers.length === 0) {
        return answer('architecture', 
          result.covered
            ? `Nothing in this run calls or injects ${args.fqn}. The run does contain call ` +
              `edges, so this is an absence rather than a gap — but a caller outside the ` +
              `extracted source, or one that reaches it reflectively, would not appear.`
            : `${result.note}`,
          result,
        );
      }
      const lines = result.callers.map(
        (row) => `  ${row.caller} —${row.edgeKind === 'injects' ? ' injects' : ''} ${at(row.file, row.line)}`,
      );
      return answer('architecture', 
        [`${result.total} caller(s) of ${args.fqn}:`, ...lines, more(result.callers.length, result.total)]
          .filter(Boolean)
          .join('\n'),
        result,
      );
    },
  );

  server.registerTool(
    'describe_module',
    {
      title: 'Describe a package',
      description:
        'One package in full: the types it declares, the endpoints it serves, the tables it ' +
        'maps, its dependencies both ways, its churn, and the cluster it was grouped into. ' +
        'Cluster names are model-authored and labelled as such.',
      inputSchema: {
        fqn: z.string().min(1).describe('exact package fqn, e.g. "com.example.shop.web"'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = describeModule(db, runId, args);
      if (!result.found) {
        return answer('architecture', result.note ?? notFound(args.fqn, true), result);
      }

      const lines = [`${result.subject?.fqn} — ${result.memberCount} declared type(s)`];
      for (const member of result.members) lines.push(`  ${nodeLine(member)}`);
      if (result.memberCount > result.members.length) {
        lines.push(`  ${more(result.members.length, result.memberCount)}`);
      }

      if (result.endpoints.length > 0) {
        lines.push('', 'serves:');
        for (const endpoint of result.endpoints) lines.push(`  ${endpointLine(endpoint)}`);
      }
      if (result.tables.length > 0) {
        lines.push('', 'maps to tables:');
        for (const table of result.tables) {
          lines.push(`  ${table.table} — declared by ${table.mappedBy} ${at(table.file, table.line)}`);
        }
      }
      lines.push('', `depends on (${result.dependsOn.length}):`, ...dependencyLines(result.dependsOn));
      lines.push('', `depended on by (${result.dependedOnBy.length}):`, ...dependencyLines(result.dependedOnBy));

      lines.push('');
      lines.push(
        result.history === null
          ? 'history: not mined for this run — churn and ownership are unavailable, not zero.'
          : `history: ${result.history.commits} commits across ${result.history.files} file(s), ` +
            `${result.history.churn} lines changed, up to ${result.history.authors} author(s), ` +
            `last changed ${result.history.lastChangeAt}`,
      );

      if (result.cluster !== null) {
        const { cluster } = result;
        lines.push(
          '',
          `clustered with ${cluster.memberCount - 1} other package(s): ${cluster.siblings.join(', ') || 'none'}`,
        );
        if (cluster.interpretation !== null) {
          lines.push(
            `  inference (${cluster.interpretation.model ?? 'model'}-authored, not observed): ` +
              `"${cluster.interpretation.name ?? 'unnamed'}" — ${cluster.interpretation.description ?? ''}`,
          );
        }
      }
      return answer('architecture', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'list_endpoints',
    {
      title: 'List HTTP endpoints',
      description:
        'The HTTP surface the backend serves, with the method that handles each route and ' +
        'the line it is declared on. Filter by path fragment or verb.',
      inputSchema: {
        contains: z.string().optional().describe('only routes whose method+path contains this'),
        httpMethod: z.string().optional().describe('only this verb, e.g. "GET"'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = listEndpoints(db, runId, args);
      if (!result.covered) return answer('api', result.note ?? 'No endpoints in this run.', result);
      if (result.endpoints.length === 0) {
        return answer('api', 'No endpoint matches that filter, though this run does contain endpoints.', result);
      }
      return answer('api', 
        [
          `${result.total} endpoint(s):`,
          ...result.endpoints.map((endpoint) => `  ${endpointLine(endpoint)}`),
          more(result.endpoints.length, result.total),
        ]
          .filter(Boolean)
          .join('\n'),
        result,
      );
    },
  );

  server.registerTool(
    'find_hotspots',
    {
      title: 'Find hotspots and bus-factor risks',
      description:
        'Source files where recent change and complexity meet (percentile of commits in the ' +
        'hotspot window x percentile of indentation complexity), or source files whose history ' +
        'is concentrated in one author. Lockfiles, manifests, tests, generated and vendored code ' +
        'are never ranked. Both are arithmetic over git log, not judgements.',
      inputSchema: {
        ranking: z
          .enum(['change-complexity', 'bus-factor'])
          .optional()
          .describe('default "change-complexity"'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = findHotspots(db, runId, { ...args, minCommits: context.minCommits });
      if (!result.covered) return answer('hotspots', result.note ?? 'No history mined.', result);
      if (result.files.length === 0) {
        return answer('hotspots', result.note ?? 'History was mined, but no file qualifies under this ranking.', result);
      }
      const lines = result.files.map(
        (file) =>
          `  ${file.path} — ${file.recentCommits} recent commits (${file.commits} all-time), ` +
          `indentation ${file.complexity}, ${file.authors} author(s), bus factor ${file.busFactor}` +
          `${file.topAuthor === null ? '' : `, mostly ${file.topAuthor}`}`,
      );
      return answer('hotspots', 
        [`Ranked by ${result.ranking}:`, ...lines, ...(result.note === null ? [] : ['', result.note])].join('\n'),
        result,
      );
    },
  );

  server.registerTool(
    'trace_to_table',
    {
      title: 'Trace code to a database table',
      description:
        'The types that declare a mapping to a table (@Entity/@Table), and what calls or ' +
        'injects those types. This is declared mapping plus one call hop — it is not ' +
        'statement-level data flow, and it does not claim any query ran.',
      inputSchema: {
        table: z.string().min(1).describe('table name, in any case, e.g. "orders"'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = traceToTable(db, runId, args);
      if (!result.found) {
        return answer('data', 
          result.covered
            ? `No table named "${args.table}" is in this run. This run does contain table ` +
              `mappings, so the name is either spelled differently or never mapped in code.`
            : 'No table mappings were extracted in this run at all — nothing was looked at.',
          result,
        );
      }
      const lines = [`table ${result.table}`, '', 'mapped by:'];
      for (const entity of result.mappedBy) {
        lines.push(`  ${entity.fqn} ${at(entity.file, entity.line)}`);
      }
      if (result.mappedBy.length === 0) lines.push('  nothing — the table node exists but no type maps it');
      lines.push('', `reached from (${result.reachedFrom.length}):`);
      for (const caller of result.reachedFrom) {
        lines.push(`  ${caller.caller} → ${caller.callee} ${at(caller.file, caller.line)}`);
      }
      if (result.reachedFrom.length === 0) {
        lines.push('  no call or injection into the mapped type(s) was observed');
      }
      lines.push('', `limits: ${result.limits}`);
      return answer('data', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'check_cycle',
    {
      title: 'Check for a dependency cycle between two packages',
      description:
        'Is there a dependency path from A to B, from B to A, or both? Each hop comes with ' +
        'the edges that justify it, so the answer can be checked line by line.',
      inputSchema: {
        from: z.string().min(1).describe('exact package fqn'),
        to: z.string().min(1).describe('exact package fqn'),
      },
      annotations: readOnly,
    },
    (args) => {
      const result = checkCycle(db, runId, args);
      if (!result.found) {
        return answer('cycles', 
          `${result.note} Could not resolve: ${result.missing.join(', ')}.`,
          result,
        );
      }
      const lines = [
        result.cyclic
          ? `${args.from} and ${args.to} are mutually dependent.`
          : result.forward !== null
            ? `${args.from} reaches ${args.to}, but not the other way round.`
            : result.backward !== null
              ? `${args.to} reaches ${args.from}, but not the other way round.`
              : `Neither package reaches the other.`,
      ];
      if (result.forward !== null) lines.push('', ...pathLines(result.forward));
      if (result.backward !== null) lines.push('', ...pathLines(result.backward));
      return answer('cycles', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'what_breaks_if',
    {
      title: 'What breaks if this changes',
      description:
        'Everything that depends on a method or type, transitively, over observed call, ' +
        'injection and inheritance edges — each with the edge that put it there — plus the ' +
        'tests that reach it and the HTTP endpoints served by impacted code.',
      inputSchema: {
        fqn: z.string().min(1).describe('exact fqn of a type or method; use find_node to get one'),
        depth: z.number().int().min(1).max(6).optional().describe('hops to follow (default 3)'),
        limit: limitArg,
      },
      annotations: readOnly,
    },
    (args) => {
      const result = whatBreaksIf(db, runId, args);
      if (!result.found) return answer('architecture', notFound(args.fqn, true), result);
      const line = (impact: Impact) =>
        `  [${impact.depth}] ${impact.fqn} — ${impact.via.edgeKind} ${impact.via.to} ${at(impact.via.file, impact.via.line)}`;
      const lines = [
        `${result.impacted.length} element(s) depend on ${result.subject} within ${result.depth} hop(s):`,
        ...(result.impacted.length === 0 ? ['  none observed'] : result.impacted.map(line)),
        '',
        `${result.tests.length} test element(s) reach it:`,
        ...result.tests.map(line),
        '',
        `${result.endpoints.length} HTTP endpoint(s) served by impacted code:`,
        ...result.endpoints.map((e) => `  ${e.endpoint} — ${e.handler} ${at(e.file, e.line)}`),
        ...(result.truncated ? ['', 'Truncated at the limit; raise `limit` for more.'] : []),
      ];
      return answer('architecture', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'who_knows',
    {
      title: 'Who knows this file',
      description:
        'The authors who changed a file, how many commits each, their share and most recent ' +
        'change, and the latest commits with their shas — from git history.',
      inputSchema: { path: z.string().min(1).describe('repository-relative file path') },
      annotations: readOnly,
    },
    (args) => {
      const result = whoKnows(db, runId, args);
      if (!result.found) {
        return answer('coupling', `No commit in this run's history touches ${args.path}.`, result);
      }
      const lines = [
        `${result.commits} commit(s) to ${result.path}:`,
        ...result.authors.map(
          (a) => `  ${a.author} — ${a.commits} commit(s), ${Math.round(a.share * 100)}%, last ${a.last.slice(0, 10)}`,
        ),
        '',
        'most recent:',
        ...result.recent.map((c) => `  ${c.sha.slice(0, 10)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject ?? ''}`),
      ];
      return answer('coupling', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'where_is_table_written',
    {
      title: 'Where is this table written',
      description:
        'Code that writes a table — Spring Data repositories of its entity, @Query and JDBC ' +
        'statements naming it — with what reads it and which classes map to it, each cited.',
      inputSchema: { table: z.string().min(1).describe('table name, any case, e.g. "orders"') },
      annotations: readOnly,
    },
    (args) => {
      const result = whereIsTableWritten(db, runId, args);
      if (!result.found) {
        return answer('data', `No table named ${args.table} is in this run.`, result);
      }
      const list = (title: string, rows: TableAccess[]) => [
        `${title} (${rows.length}):`,
        ...(rows.length === 0 ? ['  none observed'] : rows.map((r) => `  ${r.by}${r.via ? ` [${r.via}]` : ''} ${at(r.file, r.line)}`)),
      ];
      const lines = [
        ...list(`written by`, result.writers),
        '',
        ...list('read by', result.readers),
        '',
        ...list('mapped by', result.mappedBy),
        '',
        'An ORM write through a mapped class that is not a repository or a query is not a ' +
          'statement a parser can see; the mapped classes are where such writes start.',
      ];
      return answer('data', lines.join('\n'), result);
    },
  );

  server.registerTool(
    'explain_hotspot',
    {
      title: 'Explain a hotspot',
      description:
        "A file's rank in the hotspot ranking and every number behind it — recent commits, " +
        'complexity, both percentiles, authors — or why it is not ranked.',
      inputSchema: { path: z.string().min(1).describe('repository-relative file path') },
      annotations: readOnly,
    },
    (args) => {
      const result = explainHotspot(db, runId, args);
      if (result.hotspot === null) {
        return answer('hotspots', `${args.path} is not ranked. ${result.reason ?? ''}`, result);
      }
      const h = result.hotspot;
      const lines = [
        `${result.path} is #${result.rank} of ${result.ranked} ranked source files.`,
        `  recent commits: ${h.recentCommits} (percentile ${Math.round(h.recentPercentile * 100)})`,
        `  complexity: ${h.complexity} (percentile within its file type ${Math.round(h.complexityPercentile * 100)})`,
        `  score: ${h.score.toFixed(3)} = recent percentile x complexity percentile`,
        `  all-time commits: ${h.commits}, authors: ${h.authors}, last change ${h.lastChangeAt?.slice(0, 10) ?? 'unknown'}`,
      ];
      return answer('hotspots', lines.join('\n'), result);
    },
  );

  return server;
}

/* ---------------------------------------------------------------- rendering */

interface ToolText {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  /** The SDK's result type is open; without this the handlers do not typecheck. */
  [key: string]: unknown;
}

function text(body: string, structured?: unknown): ToolText {
  return {
    content: [{ type: 'text', text: body }],
    ...(structured === undefined
      ? {}
      : { structuredContent: structured as Record<string, unknown> }),
  };
}

/**
 * The same sentence for every subject that does not resolve.
 *
 * It has to say which of the two failures happened, because "not found" in a
 * run with nothing extracted means something entirely different from "not
 * found" in a run with 47,000 nodes (ADR-0015).
 */
function notFound(fqn: string, covered: boolean): string {
  return covered
    ? `No node with the fqn "${fqn}" is in this run. Try find_node to locate the exact name — ` +
        `fqns are case-sensitive, methods carry their erased parameter types, and nested ` +
        `types use "$".`
    : `Nothing has been extracted into this run, so "${fqn}" could not be looked up. ` +
        `Run \`stratigraph extract\` first.`;
}

function dependencyLines(rows: DependencyRow[]): string[] {
  if (rows.length === 0) return ['  none'];
  return rows.flatMap((row) => [
    `  ${row.fqn} — ${row.weight} reference(s) [${row.edgeKinds.join(', ')}]`,
    ...row.examples.map((edge) => `      ${edgeLine(edge)}`),
  ]);
}

function pathLines(path: CyclePath): string[] {
  return [
    `${path.path.join(' → ')}`,
    ...path.hops.flatMap((hop) => [
      `  ${hop.from} → ${hop.to}`,
      ...(hop.evidence.length === 0
        ? ['      no citable edge — the aggregate says the dependency exists but no row carries a file']
        : hop.evidence.map(
            (edge) =>
              `      ${edge.kind} ${edge.srcFqn} → ${edge.dstFqn} ${at(edge.path, edge.line)}`,
          )),
    ]),
  ];
}

function nodeLine(node: NodeSummary): string {
  return (
    `${node.fqn} (${node.kind})${node.declared ? '' : ' [referenced only, never declared]'} ` +
    `${at(node.file, node.line)}`
  ).trimEnd();
}

function endpointLine(endpoint: EndpointRow): string {
  return (
    `${endpoint.fqn}${endpoint.framework === null ? '' : ` [${endpoint.framework}]`} — ` +
    `${endpoint.handler ?? 'no handler recorded'} ${at(endpoint.file, endpoint.line)}`
  );
}

function edgeLine(edge: EdgeSummary): string {
  return `${edge.kind} ${edge.from} → ${edge.to} ${at(edge.file, edge.line)}`;
}

/** Where to look. An answer nobody can open is the kind this project refuses. */
function at(file: string | null, line: number | null): string {
  if (file === null) return '(no file recorded)';
  return line === null ? `(${file})` : `(${file}:${line})`;
}

function more(shown: number, total: number): string {
  return total > shown ? `  showing ${shown} of ${total} — raise "limit" for more` : '';
}
