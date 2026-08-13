/**
 * `stratigraph report` — write the presentation layer out to a directory.
 *
 * Layer 5, and like `mcp` it opens the database read-only and derives nothing
 * new. Every diagram is a projection of rows `extract`, `history` and `analyze`
 * already wrote (ADR-0019), and every finding is read back from the `finding`
 * table rather than recomputed (ADR-0021) — so a report cannot disagree with
 * the `analyze` run that produced it, and regenerating it from the same run
 * produces the same bytes.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { resolveBrand, type ResolvedBrand } from '../present/brand.js';
import { assertSchemaCurrent, openDatabase, type Db } from '../db/database.js';
import { findRun, latestRun } from '../db/run.js';
import { info, outputFormat, print, printJson, warn } from '../log.js';
import { describeRun } from '../mcp/queries.js';
import { GateError } from './analyze.js';
import { reportDocument } from '../present/json.js';
import { buildC4Model } from '../present/c4.js';
import { buildClassDiagrams } from '../present/classes.js';
import { buildErModel } from '../present/erd.js';
import { evaluateGate, rankFindings, type GateSeverity } from '../present/findings.js';
import { toHtml, type ReportContext, type ReportData } from '../present/html.js';
import { toMarkdown } from '../present/markdown.js';
import { toClassMermaid, toErMermaid, toMermaid } from '../present/mermaid.js';
import { toStructurizr } from '../present/structurizr.js';
import {
  buildDependencyMatrix,
  buildHotspotChart,
  buildHttpSurface,
} from '../present/surface.js';

/** Rows per section, and elements per component diagram. */
export const DEFAULT_TOP = 20;

/**
 * Class diagrams produced, at most.
 *
 * A large repository has hundreds of packages and a level-4 diagram of each is
 * not a report, it is a directory listing. The packages declaring the most
 * types come first and the rest are counted in the limits section.
 */
const MAX_CLASS_DIAGRAMS = 12;

/** Types drawn per class diagram before it says how many it left out. */
const CLASSES_PER_DIAGRAM = 12;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface ReportOptions extends ConfigOverrides {
  /** Where the files go. Created if it does not exist. */
  out: string;
  /** Report a specific run instead of the most recent one. */
  run?: number | undefined;
  top?: number | undefined;
  /** Exit non-zero when a publishable finding reaches this severity. */
  failOn?: GateSeverity | undefined;
}

export interface ReportResult {
  runId: number;
  outDir: string;
  /** Absolute paths, in the order written. */
  files: string[];
}

export function runReport(options: ReportOptions): ReportResult {
  const config = loadConfig(options);

  // Brand is config data, resolved before anything is written: an unreadable
  // logo or an uncorrectable colour must fail the command, not the page
  // (ADR-0025).
  const brand: ResolvedBrand | null = config.report.brand
    ? resolveBrand(config.report.brand)
    : null;
  const top = options.top ?? DEFAULT_TOP;

  if (!existsSync(config.dbPath)) {
    throw new ReportError(
      `no fact store at ${config.dbPath} — the report only reads, it never extracts. ` +
        `Run \`stratigraph extract\` and \`stratigraph analyze\` first.`,
    );
  }

  const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
  try {
    assertSchemaCurrent(db);

    const runId = resolveRun(db, options.run, config.dbPath);
    const summary = describeRun(db, runId);
    if (summary === null) {
      /* c8 ignore next 2 */
      throw new ReportError(`run ${runId} is not in ${config.dbPath}`);
    }

    const { diagrams: classes, skipped: classDiagramsSkipped } = buildClassDiagrams(db, runId, {
      top: CLASSES_PER_DIAGRAM,
      maxDiagrams: MAX_CLASS_DIAGRAMS,
    });
    const data: ReportData = {
      model: buildC4Model(db, runId, { top }),
      classes,
      classDiagramsSkipped,
      er: buildErModel(db, runId),
      surface: buildHttpSurface(db, runId),
      matrix: buildDependencyMatrix(db, runId, top),
      hotspots: buildHotspotChart(db, runId, top),
      ranked: rankFindings(db, runId, { top }),
    };
    const context: ReportContext = {
      run: summary,
      diagnostics: loadDiagnostics(db, runId),
      rejectedByCitationCheck: countRejections(db, runId),
      brand,
    };

    const outDir = resolve(options.cwd ?? process.cwd(), options.out);
    mkdirSync(outDir, { recursive: true });

    const files = write(outDir, data, () => toHtml(data, context), () =>
      toMarkdown(data.ranked, {
        repoName: basename(summary.repoPath) || summary.repoPath,
        repoHead: summary.repoHead,
        runId: summary.runId,
        toolVersion: summary.toolVersion,
        startedAt: summary.startedAt,
        analysisStored: summary.coverage.analysis,
        gaps: summary.gaps,
      }),
    );

    const containers = data.model.container.elements.filter(
      (element) => element.kind === 'container',
    ).length;
    info(
      `run ${runId}: ${containers} container(s), ` +
        `${data.model.components.length} component diagram(s), ` +
        `${classes.length} class diagram(s), ${data.er.entities.length} table(s), ` +
        `${data.surface.endpoints.length} endpoint(s), ` +
        `${data.ranked.total - data.ranked.uncited} publishable finding(s)`,
    );
    // `extract` opens a new run, and this command reports the latest one. Left
    // silent, "0 publishable finding(s)" on a run nobody analysed reads exactly
    // like a clean repository — the one misreading this whole project exists to
    // prevent. It is a warning rather than an error because the diagrams, the
    // HTTP surface and the data model are all real and worth having.
    if (!summary.coverage.analysis) {
      warn(
        `run ${runId} has no analysis output — no rule was evaluated against it, so the ` +
          `findings list is empty for that reason and not because the repository is clean. ` +
          `Run \`stratigraph analyze${options.run === undefined ? '' : ` --run ${runId}`}\`, ` +
          `then generate this report again.`,
      );
    }

    const gate =
      options.failOn === undefined ? null : evaluateGate(data.ranked, options.failOn);

    if (outputFormat() === 'json') {
      printJson(reportDocument({ run: summary, outDir, files, ranked: data.ranked, gate }));
    }

    // The paths are what the user asked for, so they go to stdout.
    print(`Report written to ${outDir}`);
    for (const file of files) print(`  ${basename(file)}`);
    print('');
    print(`Open ${join(outDir, 'index.html')} in a browser. It needs no network and no scripting.`);

    // After the files are on disk and the document is written: the report is
    // exactly what someone wants to look at when the gate has just failed.
    if (gate?.failed === true) {
      const breakdown = gate.bySeverity.map((row) => `${row.count} ${row.severity}`).join(', ');
      throw new GateError(
        `${gate.offending} finding(s) at or above \`${gate.threshold}\` (${breakdown}). ` +
          `The evidence for each is in ${join(outDir, 'findings.md')}.`,
      );
    }

    return { runId, outDir, files };
  } finally {
    db.close();
  }
}

/**
 * Write every output.
 *
 * The HTML and Markdown are passed as thunks so the expensive rendering happens
 * inside the same walk that names the files, keeping the list of what is
 * written in one place — there is exactly one statement of what a report
 * consists of.
 */
function write(
  outDir: string,
  data: ReportData,
  html: () => string,
  markdown: () => string,
): string[] {
  const outputs: Array<[string, string]> = [
    ['index.html', html()],
    ['workspace.dsl', toStructurizr(data.model)],
    ['c4-context.mmd', toMermaid(data.model.context)],
    ['c4-container.mmd', toMermaid(data.model.container)],
    ...data.model.components.map(
      (diagram): [string, string] => [
        `c4-component-${slug(diagram.scope)}.mmd`,
        toMermaid(diagram),
      ],
    ),
    ...data.classes.map(
      (diagram): [string, string] => [
        `c4-code-${slug(diagram.packageFqn)}.mmd`,
        toClassMermaid(diagram),
      ],
    ),
    ...(data.er.entities.length > 0
      ? ([['data-model.mmd', toErMermaid(data.er)]] as Array<[string, string]>)
      : []),
    ['findings.md', markdown()],
  ];

  const written: string[] = [];
  for (const [name, content] of outputs) {
    const path = join(outDir, name);
    writeFileSync(path, content, 'utf8');
    written.push(path);
  }
  return written;
}

/** A module fqn as a filename. Paths and dots are not portable in one. */
function slug(scope: string | null): string {
  /* c8 ignore next */
  const text = scope ?? 'root';
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

function resolveRun(db: Db, requested: number | undefined, dbPath: string): number {
  if (requested !== undefined) {
    if (findRun(db, requested) === null) {
      throw new ReportError(`run ${requested} is not in ${dbPath}`);
    }
    return requested;
  }
  const latest = latestRun(db);
  if (latest === null) {
    throw new ReportError(
      `no runs in ${dbPath} — run \`stratigraph extract\` or \`stratigraph history\` first`,
    );
  }
  return latest.id;
}

/** Extractor complaints, grouped. Part of "what this report did not see". */
function loadDiagnostics(
  db: Db,
  runId: number,
): Array<{ level: string; extractor: string | null; count: number }> {
  return db
    .prepare(
      `SELECT level, extractor, COUNT(*) AS count FROM diagnostic
        WHERE run_id = ? AND (extractor IS NULL OR extractor <> 'interpret')
        GROUP BY level, extractor
        ORDER BY level, extractor`,
    )
    .all(runId) as Array<{ level: string; extractor: string | null; count: number }>;
}

/**
 * Model output the citation check threw away (ADR-0013).
 *
 * Counted separately from extractor diagnostics because it means something
 * different: not "we could not read this", but "a model said something it could
 * not support, and it was discarded".
 */
function countRejections(db: Db, runId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM diagnostic WHERE run_id = ? AND extractor = 'interpret'`,
      )
      .get(runId) as { n: number }
  ).n;
}
