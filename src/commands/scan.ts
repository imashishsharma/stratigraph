/**
 * `stratigraph scan [repo]` — the whole pipeline in one command, ending with
 * what it could and could not see (product plan, Phase C: "one command").
 *
 * It is the commands a person would type, in order: `init`, `extract`,
 * `history`, `analyze`, `report`. Nothing new is derived here. A step that
 * cannot run on this machine becomes a stated gap rather than a failure — no
 * JDK leaves the Java half unread and says so (ADR-0032), no git leaves history
 * unmined and says so — and the summary at the end is the run's coverage,
 * view by view, so the first thing read is how much of the report to trust.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { VIEW_TITLES, VIEWS } from '../analysis/coverage.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { openDatabase } from '../db/database.js';
import { latestRun } from '../db/run.js';
import { gitToplevel } from '../history/git-log.js';
import { info, print, warn } from '../log.js';
import { describeRun, type RunSummary } from '../mcp/queries.js';
import { runAnalyze } from './analyze.js';
import { runExtract, type ExtractOptions } from './extract.js';
import { runHistory } from './history.js';
import { runInit } from './init.js';
import { runReport } from './report.js';

export interface ScanOptions extends ConfigOverrides {
  /** Where the report goes. Default: `stratigraph-report` in the cwd. */
  out?: string | undefined;
  /** Passed to `extract`; tests use it to make a toolchain missing. */
  resolveSpawner?: ExtractOptions['resolveSpawner'];
  /** Passed to `extract` (ADR-0046). */
  reuse?: boolean | undefined;
}

export interface ScanResult {
  runId: number;
  outDir: string;
  summary: RunSummary;
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const cwd = options.cwd ?? process.cwd();
  runInit(options);

  info('scan: extracting');
  await runExtract(options);

  const config = loadConfig(options);
  if (gitToplevel(config.repoPath) !== null) {
    info('scan: mining history');
    await runHistory(options);
  } else {
    warn(`${config.repoPath} is not a git repository — hotspots, co-change and ownership are unavailable`);
  }

  info('scan: analysing');
  try {
    await runAnalyze(options);
  } catch (err) {
    // A run with no code facts and no history has nothing to analyse; the
    // report still says why, which is the point of running it.
    warn(`analysis skipped — ${(err as Error).message.split('\n')[0]}`);
  }

  const out = resolve(cwd, options.out ?? 'stratigraph-report');
  const report = runReport({ ...options, out });

  const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
  let summary: RunSummary;
  try {
    const run = latestRun(db);
    summary = describeRun(db, run?.id ?? report.runId, config.coverage) as RunSummary;
  } finally {
    db.close();
  }

  print('');
  print('What this report could see:');
  for (const entry of summary.coverage.extractors) {
    const status = entry.status === 'ok' ? 'read' : entry.status === 'skipped' ? 'NOT RUN' : entry.status.toUpperCase();
    print(
      `  ${entry.language.padEnd(11)} ${status.padEnd(8)} ${entry.parsed} of ${entry.found} ${
        entry.language === 'migrations' ? 'migration' : 'source'
      } files${entry.reason ? ` — ${entry.reason.split('\n')[0]}` : ''}`,
    );
  }
  for (const view of VIEWS) {
    const coverage = summary.coverage.views[view];
    print(`  ${VIEW_TITLES[view].padEnd(20)} ${coverage.withheld ? 'WITHHELD ' : ''}${coverage.statement}`);
  }
  if (!existsSync(out)) warn(`the report directory ${out} was not written`);
  return { runId: report.runId, outDir: report.outDir, summary };
}
