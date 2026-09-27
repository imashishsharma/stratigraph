/**
 * How much of the repository each view was built from — ADR-0033.
 *
 * Every number here is a count of stored rows: `file_role` is the denominator
 * (what the repository holds), `source_file` and `file_metric` the numerator
 * (what was read), and `extractor_run` the reason when the two differ. Nothing
 * is estimated, so a coverage statement is as checkable as an edge.
 *
 * A view whose ratio is below its threshold is withheld: the report prints the
 * statement and the reasons in its place. A drawing of 40% of a system is not
 * 40% of the truth — it is a different system, drawn confidently.
 */

import type { Db } from '../db/database.js';
import { extractorFor, LANGUAGES, type Language } from '../toolchain/languages.js';

/** Every view that states a coverage. Ordered as the report shows them. */
export const VIEWS = [
  'architecture',
  'code',
  'cycles',
  'matrix',
  'api',
  'data',
  'hotspots',
  'coupling',
] as const;
export type ViewId = (typeof VIEWS)[number];

export const VIEW_TITLES: Record<ViewId, string> = {
  architecture: 'architecture (C4)',
  code: 'class diagrams',
  cycles: 'package cycles',
  matrix: 'dependency matrix',
  api: 'HTTP surface',
  data: 'data model',
  hotspots: 'hotspots',
  coupling: 'co-change coupling',
};

export const DEFAULT_MIN_RATIO = 0.5;

export interface CoverageThresholds {
  /** Below this ratio a view is withheld. */
  minRatio: number;
  /** Per-view overrides of `minRatio`. */
  views: Partial<Record<ViewId, number>>;
}

export const DEFAULT_THRESHOLDS: CoverageThresholds = { minRatio: DEFAULT_MIN_RATIO, views: {} };

export interface ExtractorCoverage {
  language: Language;
  /** From `extractor_run`; `unrecorded` when the run holds no row for it. */
  status: 'ok' | 'skipped' | 'failed' | 'unrecorded';
  reason: string | null;
  /** Main source files this extractor would parse (role `source`). */
  found: number;
  /** Of those, how many the run holds facts for. */
  parsed: number;
  /** Test files it parsed. Counted, never in the ratio (ADR-0034). */
  testsParsed: number;
}

export interface ViewCoverage {
  view: ViewId;
  /** What is being counted, e.g. "main source files parsed". */
  unit: string;
  numerator: number;
  denominator: number;
  /** Null when there is nothing to take a ratio over, or no inventory to count. */
  ratio: number | null;
  threshold: number;
  withheld: boolean;
  /** One sentence: the ratio, or why there is none. */
  statement: string;
  /** Why the numerator falls short, one line each. */
  reasons: string[];
}

export interface RunCoverage {
  /** Files in the run's inventory (`file_role` rows). Zero means coverage is unknown. */
  inventory: number;
  extractors: ExtractorCoverage[];
  views: Record<ViewId, ViewCoverage>;
}

interface Basis {
  unit: string;
  numerator: number;
  denominator: number;
  reasons: string[];
  /** Said instead of a ratio when the denominator is zero. */
  empty: string;
}

export function runCoverage(
  db: Db,
  runId: number,
  thresholds: CoverageThresholds = DEFAULT_THRESHOLDS,
): RunCoverage {
  const roles = db
    .prepare('SELECT path, role FROM file_role WHERE run_id = ?')
    .all(runId) as Array<{ path: string; role: string }>;
  const parsed = new Set(
    (
      db.prepare('SELECT path FROM source_file WHERE run_id = ?').all(runId) as Array<{
        path: string;
      }>
    ).map((row) => row.path),
  );
  const recorded = new Map(
    (
      db
        .prepare('SELECT language, status, reason FROM extractor_run WHERE run_id = ?')
        .all(runId) as Array<{ language: string; status: ExtractorCoverage['status']; reason: string | null }>
    ).map((row) => [row.language, row]),
  );

  const extractors: ExtractorCoverage[] = [];
  for (const language of LANGUAGES) {
    let found = 0;
    let read = 0;
    let testsParsed = 0;
    // The migrations extractor reads migration-role files; the others, source.
    const counted = language === 'migrations' ? 'migration' : 'source';
    for (const { path, role } of roles) {
      if (extractorFor(path) !== language) continue;
      if (role === counted) {
        found += 1;
        if (parsed.has(path)) read += 1;
      } else if (role === 'test' && parsed.has(path)) {
        testsParsed += 1;
      }
    }
    const row = recorded.get(language);
    if (found === 0 && row === undefined) continue;
    extractors.push({
      language,
      status: row?.status ?? 'unrecorded',
      reason: row?.reason ?? null,
      found,
      parsed: read,
      testsParsed,
    });
  }

  // The structural views leave test code out (ADR-0034), and say how much.
  const code: readonly Language[] = ['java', 'typescript'];
  const structural = codeBasis(extractors, code);
  const tests = extractors.reduce((sum, entry) => sum + entry.testsParsed, 0);
  if (tests > 0) {
    structural.reasons = [
      ...structural.reasons,
      `${fmt(tests)} test file(s) were parsed and are left out of this view (ADR-0034).`,
    ];
  }
  // Injection points seen against injection points resolved (ADR-0039).
  const resolved = count(db, `SELECT COUNT(*) AS n FROM edge WHERE run_id = ? AND kind = 'injects'`, runId);
  const unresolved = count(
    db,
    `SELECT COUNT(*) AS n FROM diagnostic WHERE run_id = ? AND message LIKE 'injection point %'`,
    runId,
  );
  if (resolved + unresolved > 0) {
    structural.reasons = [
      ...structural.reasons,
      `${fmt(resolved)} of ${fmt(resolved + unresolved)} injection points resolved to a type` +
        (unresolved > 0 ? '; the rest are counted in the diagnostics, not drawn.' : '.'),
    ];
  }
  const views = {} as Record<ViewId, ViewCoverage>;
  const bases: Record<ViewId, Basis> = {
    architecture: structural,
    code: structural,
    cycles: structural,
    matrix: structural,
    api: codeBasis(extractors, code),
    data: dataBasis(extractors),
    hotspots: historyBasis(db, runId, 'complexity'),
    coupling: historyBasis(db, runId, 'history'),
  };
  for (const view of VIEWS) {
    views[view] = judge(view, bases[view], roles.length, thresholds.views[view] ?? thresholds.minRatio);
  }
  return { inventory: roles.length, extractors, views };
}

function codeBasis(extractors: ExtractorCoverage[], languages: readonly Language[]): Basis {
  const relevant = extractors.filter((entry) => languages.includes(entry.language));
  return {
    unit: languages.includes('migrations') ? 'main source and migration files parsed' : 'main source files parsed',
    numerator: relevant.reduce((sum, entry) => sum + entry.parsed, 0),
    denominator: relevant.reduce((sum, entry) => sum + entry.found, 0),
    reasons: relevant.filter((entry) => entry.found > 0).map(describeExtractor),
    empty: languages.includes('migrations')
      ? 'The repository has no Java or Kotlin sources and no migrations, so there is no data model to read.'
      : 'The repository has no Java, Kotlin or TypeScript source files to parse.',
  };
}

/**
 * The data model is the JPA mapping and the schema the migrations create
 * (ADR-0037), so both count: a repository whose Java half was never read has a
 * data model only as good as its migrations.
 */
function dataBasis(extractors: ExtractorCoverage[]): Basis {
  return codeBasis(extractors, ['java', 'migrations']);
}

function historyBasis(db: Db, runId: number, what: 'complexity' | 'history'): Basis {
  const denominator = count(
    db,
    `SELECT COUNT(*) AS n FROM file_role WHERE run_id = ? AND role = 'source'`,
    runId,
  );
  const numerator = count(
    db,
    `SELECT COUNT(*) AS n FROM file_metric m
       JOIN file_role r ON r.run_id = m.run_id AND r.path = m.path AND r.role = 'source'
      WHERE m.run_id = ?${what === 'complexity' ? ' AND m.complexity IS NOT NULL' : ' AND m.commits > 0'}`,
    runId,
  );
  const reasons: string[] = [];
  const mined = count(db, 'SELECT COUNT(*) AS n FROM git_commit WHERE run_id = ?', runId);
  if (mined === 0) {
    reasons.push('No git history is stored for this run. Fix: `stratigraph history`.');
  } else if (what === 'complexity' && numerator < denominator) {
    reasons.push(
      `${fmt(denominator - numerator)} source file(s) have no complexity score (binary, too ` +
        'large or unreadable) and are left out of the ranking.',
    );
  }
  return {
    unit: what === 'complexity' ? 'source files with a complexity score' : 'source files with mined history',
    numerator,
    denominator,
    reasons,
    empty: 'The repository has no source files to rank.',
  };
}

function judge(view: ViewId, basis: Basis, inventory: number, threshold: number): ViewCoverage {
  const base = {
    view,
    unit: basis.unit,
    numerator: basis.numerator,
    denominator: basis.denominator,
    threshold,
    reasons: basis.reasons,
  };
  if (inventory === 0) {
    return {
      ...base,
      ratio: null,
      withheld: false,
      statement:
        'Coverage unknown: this run holds no inventory of the repository\'s files, so what ' +
        'was not read cannot be counted. Fix: `stratigraph extract`.',
    };
  }
  if (basis.denominator === 0) {
    return { ...base, ratio: null, withheld: false, statement: basis.empty };
  }
  const ratio = basis.numerator / basis.denominator;
  const share = `${fmt(basis.numerator)} of ${fmt(basis.denominator)} ${basis.unit} (${percent(ratio)})`;
  const withheld = ratio < threshold;
  return {
    ...base,
    ratio,
    withheld,
    statement: withheld
      ? `Withheld: built from only ${share}, below the ${percent(threshold)} this view needs.`
      : `Built from ${share}.`,
  };
}

function describeExtractor(entry: ExtractorCoverage): string {
  const kind = entry.language === 'migrations' ? 'migration files' : 'main source files';
  const head = `${label(entry.language)}: ${fmt(entry.parsed)} of ${fmt(entry.found)} ${kind} parsed`;
  switch (entry.status) {
    case 'skipped':
      return `${head} — the ${entry.language} extractor did not run: ${firstLine(entry.reason)}`;
    case 'failed':
      return `${head} — the ${entry.language} extractor failed: ${firstLine(entry.reason)}`;
    case 'unrecorded':
      return `${head} — no ${entry.language} extractor is recorded for this run`;
    default:
      // An ok extractor may still say how it ran — typed or source-only (ADR-0039).
      return entry.reason === null ? head : `${head} — ${firstLine(entry.reason)}`;
  }
}

function label(language: Language): string {
  return language === 'java' ? 'Java/Kotlin' : language === 'migrations' ? 'Migrations' : 'TypeScript';
}

function firstLine(text: string | null): string {
  return (text ?? 'no reason recorded').split('\n')[0] as string;
}

/** Floored, so 49.6% never prints as the 50% it fell short of. */
export function percent(ratio: number): string {
  return `${Math.floor(ratio * 100)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function count(db: Db, sql: string, runId: number): number {
  return (db.prepare(sql).get(runId) as { n: number }).n;
}
