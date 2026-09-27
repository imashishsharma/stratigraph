/**
 * One repository's scorecard: stratigraph's stored output against ground truth
 * labelled without it (ADR-0035).
 *
 * Reads the store and the written report, nothing else. Every metric is a
 * `{ hit, of }` count plus what was missed, so a failing number can be chased
 * to the rows behind it rather than argued about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ViewId } from '../analysis/coverage.js';
import { topHotspots } from '../analysis/hotspots.js';
import type { Db } from '../db/database.js';
import { buildC4Model } from '../present/c4.js';
import { buildErModel } from '../present/erd.js';
import { buildHttpSurface } from '../present/surface.js';
import type { Truth } from './truth.js';

export interface Ratio {
  hit: number;
  of: number;
  /** What the truth has and the output lacks — or, for precision-style metrics, the reverse. */
  missed: string[];
}

export interface Metrics {
  /** Top-20 hotspots that are not source code, by truth label or by an independent name test. */
  nonSourceInHotspotTop20: { count: number; paths: string[] };
  hotspotOverlapTop10: Ratio | null;
  entityRecall: Ratio | null;
  tableRecall: Ratio | null;
  endpointRecall: Ratio | null;
  injectionRecall: Ratio | null;
  /** Truth containers matched by an output container. */
  containerRecall: Ratio | null;
  /** Output containers that are a labelled deployable; `missed` lists the ones that are not. */
  containerPrecision: Ratio | null;
  roleAccuracy: Ratio | null;
  /** Rendered report views with no coverage statement. The target is zero. */
  viewsWithoutCoverage: string[];
}

export function scoreRun(
  db: Db,
  runId: number,
  truth: Truth | null,
  reportDir: string | null,
): Metrics {
  const hotspots20 = topHotspots(db, runId, 20);
  const roleOf = new Map((truth?.roles ?? []).map((row) => [row.path, row.role]));
  const nonSource = hotspots20
    .map((hotspot) => hotspot.path)
    .filter((path) => {
      const labelled = roleOf.get(path);
      return labelled !== undefined ? labelled !== 'source' : looksNonSource(path);
    });

  return {
    nonSourceInHotspotTop20: { count: nonSource.length, paths: nonSource },
    hotspotOverlapTop10:
      truth?.riskyFiles === undefined
        ? null
        : overlap(
            truth.riskyFiles.slice(0, 10),
            new Set(hotspots20.slice(0, 10).map((hotspot) => hotspot.path)),
          ),
    entityRecall: truth?.entities === undefined ? null : entityRecall(db, runId, truth.entities),
    tableRecall: truth?.tables === undefined ? null : tableRecall(db, runId, truth.tables),
    endpointRecall:
      truth?.endpoints === undefined
        ? null
        : overlap(
            truth.endpoints.map(normaliseEndpoint),
            new Set(
              buildHttpSurface(db, runId).endpoints.map((row) =>
                normaliseEndpoint(`${row.method} ${row.path}`),
              ),
            ),
          ),
    injectionRecall:
      truth?.injections === undefined ? null : injectionRecall(db, runId, truth.injections),
    ...containerScores(db, runId, truth),
    roleAccuracy: truth?.roles === undefined ? null : roleAccuracy(db, runId, truth.roles),
    viewsWithoutCoverage:
      reportDir === null ? [] : viewsWithoutCoverage(reportDir),
  };
}

/**
 * Independent of `src/files/roles.ts` on purpose: the hotspot list is already
 * filtered by that classifier, so checking it with the same rules would pass
 * by construction. These are the plainest names a reviewer would object to.
 */
export function looksNonSource(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (/(^|[-.])lock(file)?(\.|$)|^package(-lock)?\.json$|^pom\.xml$|^build\.gradle(\.kts)?$/.test(name)) {
    return true;
  }
  if (/(^|\/)(src\/test|test|tests|__tests__|e2e|spec)\//.test(path)) return true;
  if (/\.(spec|test)\.[jt]sx?$|Tests?\.(java|kt)$|IT\.(java|kt)$/.test(name)) return true;
  if (/\.(json|ya?ml|xml|properties|md|txt|csv|sql|html|css|scss|svg|png|lock)$/.test(name)) return true;
  if (/\.min\.(js|css)$/.test(name)) return true;
  return false;
}

/** `GET /owners/{ownerId}` and `get /owners/:id/` score as the same endpoint. */
export function normaliseEndpoint(text: string): string {
  const [method = '', ...rest] = text.trim().split(/\s+/);
  let path = rest.join('') || '/';
  path = path
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}')
    .replace(/\/+/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return `${method.toUpperCase()} ${path}`;
}

function overlap(expected: string[], actual: ReadonlySet<string>): Ratio {
  const unique = [...new Set(expected)];
  const missed = unique.filter((item) => !actual.has(item));
  return { hit: unique.length - missed.length, of: unique.length, missed };
}

function bareTable(name: string): string {
  return (name.split('.').pop() ?? name).replace(/[`"[\]]/g, '').toLowerCase();
}

function outputTables(db: Db, runId: number): Map<string, string> {
  // Output table name → the class mapped to it, or '' for a table with no class.
  const tables = new Map<string, string>();
  for (const entity of buildErModel(db, runId).entities) {
    tables.set(bareTable(entity.table), entity.className);
  }
  for (const row of db
    .prepare(`SELECT fqn FROM node WHERE run_id = ? AND kind = 'table' AND is_stub = 0`)
    .all(runId) as Array<{ fqn: string }>) {
    if (!tables.has(bareTable(row.fqn))) tables.set(bareTable(row.fqn), '');
  }
  return tables;
}

function tableRecall(db: Db, runId: number, expected: string[]): Ratio {
  return overlap(expected.map(bareTable), new Set(outputTables(db, runId).keys()));
}

function entityRecall(db: Db, runId: number, expected: Truth['entities'] & object): Ratio {
  const byClass = new Map(
    buildErModel(db, runId).entities.flatMap((entity) =>
      entity.classes.map((className) => [className, bareTable(entity.table)] as const),
    ),
  );
  const missed: string[] = [];
  for (const { class: className, table } of expected) {
    const got = byClass.get(className);
    if (got !== bareTable(table)) missed.push(`${className} → ${table} (got ${got ?? 'nothing'})`);
  }
  return { hit: expected.length - missed.length, of: expected.length, missed };
}

function injectionRecall(db: Db, runId: number, expected: Truth['injections'] & object): Ratio {
  const edges = new Set(
    (
      db
        .prepare(
          `SELECT s.fqn AS src, d.fqn AS dst FROM edge e
             JOIN node s ON s.id = e.src_id JOIN node d ON d.id = e.dst_id
            WHERE e.run_id = ? AND e.kind = 'injects'`,
        )
        .all(runId) as Array<{ src: string; dst: string }>
    ).map((row) => `${ownerType(row.src)} -> ${row.dst}`),
  );
  return overlap(
    expected.map((row) => `${row.from} -> ${row.to}`),
    edges,
  );
}

/** `a.B#field` or `a.B#m(x)` → `a.B`. An injection is scored by the receiving type. */
function ownerType(fqn: string): string {
  return fqn.split('#')[0] as string;
}

function containerScores(
  db: Db,
  runId: number,
  truth: Truth | null,
): Pick<Metrics, 'containerRecall' | 'containerPrecision'> {
  if (truth?.containers === undefined) return { containerRecall: null, containerPrecision: null };
  const output = buildC4Model(db, runId, { top: 20 }).container.elements.filter(
    (element) => element.kind === 'container',
  );
  const keysOf = (element: (typeof output)[number]) =>
    new Set(
      [element.name, ...element.evidence.map((evidence) => evidence.label)].flatMap((label) => [
        norm(label),
        norm(label.split(/[/:]/).filter(Boolean).pop() ?? label),
      ]),
    );
  const outputKeys = output.map(keysOf);
  const truthKeys = truth.containers.map((container) => [
    norm(container.name),
    norm(container.path.split('/').filter((part) => part !== '.' && part !== '').pop() ?? container.name),
  ]);

  const recallMissed = truth.containers
    .filter((_, n) => !outputKeys.some((keys) => truthKeys[n]!.some((key) => keys.has(key))))
    .map((container) => `${container.name} (${container.path})`);
  const precisionMissed = output
    .filter((_, n) => !truthKeys.some((keys) => keys.some((key) => outputKeys[n]!.has(key))))
    .map((element) => element.name);
  return {
    containerRecall: {
      hit: truth.containers.length - recallMissed.length,
      of: truth.containers.length,
      missed: recallMissed,
    },
    containerPrecision: {
      hit: output.length - precisionMissed.length,
      of: output.length,
      missed: precisionMissed,
    },
  };
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roleAccuracy(db: Db, runId: number, expected: Truth['roles'] & object): Ratio {
  const assigned = new Map(
    (
      db.prepare('SELECT path, role FROM file_role WHERE run_id = ?').all(runId) as Array<{
        path: string;
        role: string;
      }>
    ).map((row) => [row.path, row.role]),
  );
  const missed = expected
    .filter((row) => assigned.get(row.path) !== row.role)
    .map((row) => `${row.path}: labelled ${row.role}, got ${assigned.get(row.path) ?? 'no role'}`);
  return { hit: expected.length - missed.length, of: expected.length, missed };
}

/** Panels whose view is rendered must open with a coverage block (ADR-0033). */
const PANEL_VIEWS: Array<[string, ViewId[]]> = [
  ['architecture', ['architecture']],
  ['code', ['code']],
  ['data', ['data']],
  ['api', ['api']],
  ['coupling', ['matrix', 'hotspots']],
];

function viewsWithoutCoverage(reportDir: string): string[] {
  const path = join(reportDir, 'index.html');
  if (!existsSync(path)) return ['index.html missing'];
  const html = readFileSync(path, 'utf8');
  const missing: string[] = [];
  for (const [panel, ids] of PANEL_VIEWS) {
    const start = html.indexOf(`id="panel-${panel}"`);
    if (start < 0) continue; // not rendered: nothing to qualify
    const end = html.indexOf('id="panel-', start + 10);
    const body = html.slice(start, end < 0 ? undefined : end);
    if (!ids.some((id) => body.includes(`data-view="${id}"`))) missing.push(panel);
  }
  if (!html.includes('data-view="findings"')) missing.push('findings');
  return missing;
}
