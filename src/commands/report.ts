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
import { assertSchemaCurrent, openDatabase, type Db } from '../db/database.js';
import { findRun, latestRun } from '../db/run.js';
import { info, print } from '../log.js';
import { describeRun } from '../mcp/queries.js';
import { buildC4Model, type C4Model } from '../present/c4.js';
import { rankFindings } from '../present/findings.js';
import { toHtml, type ReportContext } from '../present/html.js';
import { toMarkdown } from '../present/markdown.js';
import { toMermaid } from '../present/mermaid.js';
import { toStructurizr } from '../present/structurizr.js';

/** Rows per section, and elements per component diagram. */
export const DEFAULT_TOP = 20;

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
}

export interface ReportResult {
  runId: number;
  outDir: string;
  /** Absolute paths, in the order written. */
  files: string[];
}

export function runReport(options: ReportOptions): ReportResult {
  const config = loadConfig(options);
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

    const model = buildC4Model(db, runId, { top });
    const ranked = rankFindings(db, runId, { top });
    const context: ReportContext = {
      run: summary,
      diagnostics: loadDiagnostics(db, runId),
      rejectedByCitationCheck: countRejections(db, runId),
    };

    const outDir = resolve(options.cwd ?? process.cwd(), options.out);
    mkdirSync(outDir, { recursive: true });

    const files = write(outDir, model, () => toHtml(model, ranked, context), () =>
      toMarkdown(ranked, {
        repoName: basename(summary.repoPath) || summary.repoPath,
        repoHead: summary.repoHead,
        runId: summary.runId,
        toolVersion: summary.toolVersion,
        startedAt: summary.startedAt,
      }),
    );

    const containers = model.container.elements.filter(
      (element) => element.kind === 'container',
    ).length;
    info(
      `run ${runId}: ${containers} container(s), ` +
        `${model.components.length} component diagram(s), ` +
        `${ranked.total - ranked.uncited} publishable finding(s)`,
    );
    // The paths are what the user asked for, so they go to stdout.
    print(`Report written to ${outDir}`);
    for (const file of files) print(`  ${basename(file)}`);
    print('');
    print(`Open ${join(outDir, 'index.html')} in a browser. It needs no network and no scripting.`);

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
  model: C4Model,
  html: () => string,
  markdown: () => string,
): string[] {
  const outputs: Array<[string, string]> = [
    ['index.html', html()],
    ['workspace.dsl', toStructurizr(model)],
    ['c4-context.mmd', toMermaid(model.context)],
    ['c4-container.mmd', toMermaid(model.container)],
    ...model.components.map(
      (diagram): [string, string] => [
        `c4-component-${slug(diagram.scope)}.mmd`,
        toMermaid(diagram),
      ],
    ),
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
