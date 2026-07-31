/**
 * Three views the store could already answer and the report was not asking
 * for: the HTTP surface, the package dependency matrix, and the hotspots as
 * something with a shape rather than a list.
 *
 * All three read rows written by `extract`, `history` and `analyze`. None of
 * them derives anything new, and none of them is a judgement — the matrix is a
 * transposition of the package graph, and the hotspot ranking is the one
 * `analyze` already computed.
 */

import { buildPackageGraph } from '../analysis/package-graph.js';
import type { Db } from '../db/database.js';

// ------------------------------------------------------------- HTTP surface

export interface EndpointRow {
  method: string;
  path: string;
  /** The method that serves it, or null when nothing declared one. */
  handler: string | null;
  file: string | null;
  line: number | null;
  framework: string | null;
}

export interface HttpSurface {
  endpoints: EndpointRow[];
  /** Endpoints with no `handles` edge — declared, but nothing claims to serve them. */
  unhandled: number;
  notes: string[];
}

/**
 * Every declared HTTP endpoint, with the method that handles it.
 *
 * Sorted by path then method, which is how anyone reads an API surface — the
 * store's insertion order is the order the parser happened to walk the files.
 */
export function buildHttpSurface(db: Db, runId: number): HttpSurface {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT n.fqn AS fqn, n.attrs AS attrs,
             handler.fqn AS handler,
             f.path AS path, e.line AS line
        FROM node n
        LEFT JOIN edge e      ON e.dst_id = n.id AND e.kind = 'handles' AND e.run_id = @runId
        LEFT JOIN node handler ON handler.id = e.src_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE n.run_id = @runId AND n.kind = 'endpoint'
       ORDER BY n.fqn`,
    )
    .all({ runId }) as Array<{
    fqn: string;
    attrs: string | null;
    handler: string | null;
    path: string | null;
    line: number | null;
  }>;

  const endpoints: EndpointRow[] = rows.map((row) => {
    const attrs = parseAttrs(row.attrs);
    // The fqn is `GET /path` by construction (ADR-0007), and the attrs restate
    // it; prefer the attrs and fall back to splitting, so a fact written by an
    // extractor that omitted them still renders.
    const [fallbackMethod, ...rest] = row.fqn.split(' ');
    return {
      method: typeof attrs['method'] === 'string' ? attrs['method'] : (fallbackMethod ?? '?'),
      path: typeof attrs['path'] === 'string' ? attrs['path'] : rest.join(' '),
      handler: row.handler,
      file: row.path,
      line: row.line,
      framework: typeof attrs['framework'] === 'string' ? attrs['framework'] : null,
    };
  });

  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const unhandled = endpoints.filter((endpoint) => endpoint.handler === null).length;

  const notes: string[] = [];
  if (endpoints.length === 0) {
    notes.push(
      'No HTTP endpoint was read in this run. That is a statement about what the ' +
        'parser could resolve, not about whether the application serves any — an ' +
        'annotation reached through a wildcard import is refused rather than guessed ' +
        'at (ADR-0005).',
    );
  }
  if (unhandled > 0) {
    notes.push(
      `${unhandled} endpoint(s) have no method recorded as handling them. The route ` +
        'was declared somewhere the parser could read; the handler was not.',
    );
  }
  return { endpoints, unhandled, notes };
}

// ------------------------------------------------------- dependency matrix

export interface DependencyMatrix {
  /** Package fqns, in the order rows and columns appear. */
  packages: string[];
  /** `cells[row][column]` — references from `packages[row]` to `packages[column]`. */
  cells: number[][];
  /** Pairs pointing at each other, which is a two-package cycle. */
  mutual: Array<[string, string]>;
  /** Packages omitted by the cap. */
  omitted: number;
  notes: string[];
}

/**
 * The package graph as a matrix.
 *
 * At forty packages a node-link diagram is a hairball and a grid is still
 * legible, and a matrix shows something the diagram cannot: a mark on both
 * sides of the diagonal is a cycle, visible at a glance rather than found by
 * an algorithm.
 *
 * Ordered by total coupling so the dense corner is top-left. Not by a
 * clustering — that would make the reading depend on an algorithm's output,
 * and the point of this view is that it depends on nothing.
 */
export function buildDependencyMatrix(db: Db, runId: number, limit: number): DependencyMatrix {
  const graph = buildPackageGraph(db, runId);
  if (graph.packages.size === 0) {
    return { packages: [], cells: [], mutual: [], omitted: 0, notes: [] };
  }

  const weight = new Map<number, number>();
  for (const dependency of graph.dependencies) {
    weight.set(dependency.src, (weight.get(dependency.src) ?? 0) + dependency.weight);
    weight.set(dependency.dst, (weight.get(dependency.dst) ?? 0) + dependency.weight);
  }

  const ordered = [...graph.packages.values()].sort(
    (a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || a.fqn.localeCompare(b.fqn),
  );
  const shown = ordered.slice(0, limit);
  const index = new Map(shown.map((pkg, n) => [pkg.id, n]));

  const cells = shown.map(() => new Array<number>(shown.length).fill(0));
  for (const dependency of graph.dependencies) {
    const row = index.get(dependency.src);
    const column = index.get(dependency.dst);
    if (row === undefined || column === undefined) continue;
    (cells[row] as number[])[column] = dependency.weight;
  }

  const mutual: Array<[string, string]> = [];
  for (let row = 0; row < shown.length; row += 1) {
    for (let column = row + 1; column < shown.length; column += 1) {
      if ((cells[row] as number[])[column] !== 0 && (cells[column] as number[])[row] !== 0) {
        mutual.push([(shown[row] as { fqn: string }).fqn, (shown[column] as { fqn: string }).fqn]);
      }
    }
  }

  const notes: string[] = [
    'Rows depend on columns. A number is how many source-level references the ' +
      'package graph aggregated, and marks on both sides of the diagonal are a ' +
      'cycle.',
  ];
  if (ordered.length > shown.length) {
    notes.push(
      `Showing the ${shown.length} most coupled of ${ordered.length} packages. ` +
        `Raise --top for more.`,
    );
  }
  if (mutual.length > 0) {
    notes.push(`${mutual.length} pair(s) point at each other — see the findings for the paths.`);
  }

  return { packages: shown.map((pkg) => pkg.fqn), cells, mutual, omitted: ordered.length - shown.length, notes };
}

// ---------------------------------------------------------------- hotspots

export interface HotspotBar {
  path: string;
  commits: number;
  churn: number;
  complexity: number;
  /** churn x complexity, the ranking `analyze` uses. */
  score: number;
  authors: number;
  topAuthorShare: number;
  /** 0..1, this file's score against the largest. For a bar's width. */
  relative: number;
}

export interface HotspotChart {
  bars: HotspotBar[];
  total: number;
  notes: string[];
}

/**
 * The hotspot ranking with a width per row.
 *
 * Same arithmetic as `analyze`'s list; the only thing added is the ratio
 * against the top row, so a reader can see that the first file is twenty times
 * the second rather than reading two numbers and doing it themselves.
 */
export function buildHotspotChart(db: Db, runId: number, limit: number): HotspotChart {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT path, commits, churn, COALESCE(complexity, 0) AS complexity,
             authors, COALESCE(top_author_share, 0) AS topAuthorShare,
             churn * COALESCE(complexity, 0) AS score
        FROM file_metric
       WHERE run_id = @runId AND commits > 0
       ORDER BY score DESC, path
       LIMIT @limit`,
    )
    .all({ runId, limit }) as Array<Omit<HotspotBar, 'relative'>>;

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM file_metric WHERE run_id = ?`).get(runId) as { n: number }
  ).n;

  const highest = rows[0]?.score ?? 0;
  const bars = rows.map((row) => ({
    ...row,
    relative: highest === 0 ? 0 : row.score / highest,
  }));

  const notes: string[] = [];
  if (bars.length > 0) {
    notes.push(
      'Churn is lines changed across the mined history; complexity is an ' +
        'indentation proxy, not a parsed measure. The product ranks files that ' +
        'are both changed often and structurally dense.',
    );
  }
  if (total > bars.length) {
    notes.push(`Showing ${bars.length} of ${total} files with history. Raise --top for more.`);
  }
  return { bars, total, notes };
}

function parseAttrs(attrs: string | null): Record<string, unknown> {
  if (attrs === null) return {};
  try {
    const parsed: unknown = JSON.parse(attrs);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    /* c8 ignore next */
    return {};
  }
}
