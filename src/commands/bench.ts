/**
 * `stratigraph bench` — quality measured, not asserted (ADR-0035).
 *
 * Runs the whole pipeline (`extract`, `history`, `analyze --no-llm`, `report`)
 * over every repository in the pinned corpus and scores the stored output
 * against ground truth labelled without stratigraph. The scorecard it writes is
 * the only evidence the README is allowed to cite.
 *
 * Cloning is the one network step in this project outside the model call, so
 * it happens only with `--fetch`, into a cache the tool owns. Extraction and
 * history mining stay offline either way.
 *
 * `--private` scores a local repository with no corpus entry and prints only
 * aggregate numbers — never a path, a name or a fqn — so a private codebase can
 * be checked without anything identifying leaving the machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCoverage, VIEWS, type ViewId } from '../analysis/coverage.js';
import { scoreRun, type Metrics, type Ratio } from '../bench/score.js';
import { loadCorpus, loadTruth, type CorpusEntry, type Truth } from '../bench/truth.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { latestRun } from '../db/run.js';
import { print, setQuiet } from '../log.js';
import { runAnalyze } from './analyze.js';
import { runExtract } from './extract.js';
import { runHistory } from './history.js';
import { runInit } from './init.js';
import { runReport } from './report.js';

export class BenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchError';
  }
}

export interface BenchOptions {
  cwd?: string | undefined;
  corpus?: string | undefined;
  truth?: string | undefined;
  /** Where clones live. Default `~/.cache/stratigraph/corpus`. */
  cache?: string | undefined;
  /** Where each repository's store and report, and the scorecard, go. */
  out?: string | undefined;
  /** Only these corpus names. */
  only?: string[] | undefined;
  /** Clone missing repositories. Off by default: the only network step. */
  fetch?: boolean | undefined;
  /** Score this local repository instead of the corpus, aggregates only. */
  privateRepo?: string | undefined;
  javaHome?: string | undefined;
  extractorJar?: string | undefined;
  /** Keep the pipeline's own progress output. */
  verbose?: boolean | undefined;
  /** Score the stores a previous run left in `out`, without running the pipeline. */
  rescore?: boolean | undefined;
}

export interface RepoResult {
  name: string;
  sha: string;
  seconds: number;
  error: string | null;
  runId: number | null;
  extractors: Array<{ language: string; status: string; parsed: number; found: number }>;
  coverage: Partial<Record<ViewId, { ratio: number | null; withheld: boolean }>>;
  counts: { sourceFiles: number; packages: number; endpoints: number; tables: number };
  metrics: Metrics | null;
}

export interface Target {
  metric: string;
  target: string;
  value: string;
  pass: boolean | null;
}

export interface Scorecard {
  generatedAt: string;
  repos: RepoResult[];
  targets: Target[];
}

export async function runBench(options: BenchOptions): Promise<Scorecard> {
  const cwd = options.cwd ?? process.cwd();
  const out = resolve(cwd, options.out ?? join('.stratigraph', 'bench'));
  mkdirSync(out, { recursive: true });

  if (options.privateRepo !== undefined) {
    const repo = resolve(cwd, options.privateRepo);
    const result = await runOne(
      { name: 'private', url: '', sha: '', why: '', stacks: [], config: {}, javaOpts: [] },
      repo,
      null,
      join(out, 'private'),
      options,
    );
    const card = { generatedAt: new Date().toISOString(), repos: [result], targets: targets([result]) };
    printPrivate(result, card.targets);
    return card;
  }

  const corpusPath = resolve(cwd, options.corpus ?? join('bench', 'corpus.yaml'));
  const truthDir = resolve(cwd, options.truth ?? join('bench', 'truth'));
  const cache = resolve(options.cache ?? join(homedir(), '.cache', 'stratigraph', 'corpus'));
  let corpus = loadCorpus(corpusPath);
  if (options.only !== undefined && options.only.length > 0) {
    const unknown = options.only.filter((name) => !corpus.some((entry) => entry.name === name));
    if (unknown.length > 0) throw new BenchError(`not in ${corpusPath}: ${unknown.join(', ')}`);
    corpus = corpus.filter((entry) => options.only!.includes(entry.name));
  }

  const repos: RepoResult[] = [];
  for (const entry of corpus) {
    const truthPath = join(truthDir, `${entry.name}.yaml`);
    const truth = existsSync(truthPath) ? loadTruth(truthPath) : null;
    if (truth !== null && truth.sha !== entry.sha) {
      throw new BenchError(
        `${truthPath} was labelled at ${truth.sha.slice(0, 10)}, but the corpus pins ` +
          `${entry.sha.slice(0, 10)} — relabel it or move the pin back`,
      );
    }
    process.stderr.write(`bench: ${entry.name} … `);
    let result: RepoResult;
    try {
      if (options.rescore === true) {
        result = score(entry, truth, join(out, entry.name), Date.now(), process.env);
      } else {
        const repo = checkout(entry, cache, options.fetch === true);
        result = await runOne(entry, repo, truth, join(out, entry.name), options);
      }
    } catch (err) {
      result = failed(entry, (err as Error).message, 0);
    }
    process.stderr.write(result.error === null ? `${result.seconds.toFixed(0)}s\n` : `FAILED: ${result.error.split('\n')[0]}\n`);
    repos.push(result);
  }

  const card: Scorecard = { generatedAt: new Date().toISOString(), repos, targets: targets(repos) };
  writeFileSync(join(out, 'scorecard.json'), `${JSON.stringify(card, null, 2)}\n`);
  writeFileSync(join(out, 'scorecard.md'), toMarkdown(card));
  print(toMarkdown(card));
  return card;
}

/** Clone if asked, then pin the work tree to the corpus sha. */
function checkout(entry: CorpusEntry, cache: string, fetch: boolean): string {
  const dir = join(cache, entry.name);
  if (!existsSync(join(dir, '.git'))) {
    if (!fetch) {
      throw new Error(`not cloned at ${dir}; run with --fetch to clone ${entry.url}`);
    }
    mkdirSync(cache, { recursive: true });
    git(cache, ['clone', '--quiet', entry.url, dir]);
  }
  try {
    git(dir, ['cat-file', '-e', `${entry.sha}^{commit}`]);
  } catch {
    if (!fetch) throw new Error(`${entry.sha.slice(0, 10)} is not in ${dir}; run with --fetch`);
    git(dir, ['fetch', '--quiet', 'origin']);
  }
  git(dir, ['checkout', '--quiet', '--force', '--detach', entry.sha]);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function runOne(
  entry: CorpusEntry,
  repo: string,
  truth: Truth | null,
  work: string,
  options: BenchOptions,
): Promise<RepoResult> {
  const started = Date.now();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, 'stratigraph.config.json'),
    JSON.stringify({ ...entry.config, repo, db: 'store.db', llm: { enabled: false } }, null, 2),
  );
  // No user config and no .env from the machine running the bench: the
  // scorecard must not depend on who ran it.
  const env = { ...process.env, STRATIGRAPH_CONFIG_HOME: join(work, 'no-user-config') };
  const common = {
    cwd: work,
    env,
    llm: false,
    javaHome: options.javaHome,
    extractorJar: options.extractorJar,
  };

  setQuiet(options.verbose !== true);
  try {
    runInit(common);
    await runExtract({ ...common, javaOpts: entry.javaOpts.length > 0 ? entry.javaOpts : undefined });
    await runHistory(common);
    await runAnalyze(common);
    runReport({ ...common, out: 'report' });
  } catch (err) {
    return failed(entry, (err as Error).message, (Date.now() - started) / 1000);
  } finally {
    setQuiet(false);
  }

  return score(entry, truth, work, started, env);
}

/** Score the store a pipeline run left in `work`. */
function score(
  entry: CorpusEntry,
  truth: Truth | null,
  work: string,
  started: number,
  processEnv: NodeJS.ProcessEnv,
): RepoResult {
  const env = { ...processEnv, STRATIGRAPH_CONFIG_HOME: join(work, 'no-user-config') };
  const config = loadConfig({ cwd: work, env });
  const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
  try {
    const run = latestRun(db);
    if (run === null) return failed(entry, 'no completed run', (Date.now() - started) / 1000);
    const coverage = runCoverage(db, run.id, config.coverage);
    const count = (sql: string) => (db.prepare(sql).get(run.id) as { n: number }).n;
    return {
      name: entry.name,
      sha: entry.sha,
      seconds: (Date.now() - started) / 1000,
      error: null,
      runId: run.id,
      extractors: coverage.extractors.map((row) => ({
        language: row.language,
        status: row.status,
        parsed: row.parsed,
        found: row.found,
      })),
      coverage: Object.fromEntries(
        VIEWS.map((view) => [view, { ratio: coverage.views[view].ratio, withheld: coverage.views[view].withheld }]),
      ),
      counts: {
        sourceFiles: count(`SELECT COUNT(*) AS n FROM file_role WHERE run_id = ? AND role = 'source'`),
        packages: count(`SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND kind = 'package' AND is_stub = 0`),
        endpoints: count(`SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND kind = 'endpoint'`),
        tables: count(`SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND kind = 'table' AND is_stub = 0`),
      },
      metrics: scoreRun(db, run.id, truth, join(work, 'report')),
    };
  } finally {
    db.close();
  }
}

function failed(entry: CorpusEntry, error: string, seconds: number): RepoResult {
  return {
    name: entry.name,
    sha: entry.sha,
    seconds,
    error,
    runId: null,
    extractors: [],
    coverage: {},
    counts: { sourceFiles: 0, packages: 0, endpoints: 0, tables: 0 },
    metrics: null,
  };
}

/** Micro-averaged over every repository that has the section labelled. */
function pooled(repos: RepoResult[], pick: (m: Metrics) => Ratio | null): Ratio | null {
  const ratios = repos.flatMap((repo) => {
    const ratio = repo.metrics === null ? null : pick(repo.metrics);
    return ratio === null ? [] : [ratio];
  });
  if (ratios.length === 0) return null;
  return {
    hit: ratios.reduce((sum, r) => sum + r.hit, 0),
    of: ratios.reduce((sum, r) => sum + r.of, 0),
    missed: [],
  };
}

export function targets(repos: RepoResult[]): Target[] {
  const scored = repos.filter((repo) => repo.metrics !== null);
  const rows: Target[] = [];
  const atLeast = (metric: string, ratio: Ratio | null, min: number) => {
    const value = ratio === null || ratio.of === 0 ? null : ratio.hit / ratio.of;
    rows.push({
      metric,
      target: `≥ ${Math.round(min * 100)}%`,
      value: value === null ? 'not labelled' : `${ratio!.hit}/${ratio!.of} (${Math.floor(value * 100)}%)`,
      pass: value === null ? null : value >= min,
    });
  };
  const nonSource = scored.reduce((sum, repo) => sum + repo.metrics!.nonSourceInHotspotTop20.count, 0);
  rows.push({
    metric: 'Non-source files in the hotspot top 20',
    target: '0',
    value: String(nonSource),
    pass: scored.length === 0 ? null : nonSource === 0,
  });
  atLeast('Hotspot top-10 overlap with the labelled list', pooled(scored, (m) => m.hotspotOverlapTop10), 0.6);
  atLeast('Entity recall', pooled(scored, (m) => m.entityRecall), 0.9);
  atLeast('Table recall', pooled(scored, (m) => m.tableRecall), 0.9);
  atLeast('Endpoint recall', pooled(scored, (m) => m.endpointRecall), 0.95);
  atLeast('Injection edges resolved', pooled(scored, (m) => m.injectionRecall), 0.85);
  atLeast('Labelled deployables found as containers', pooled(scored, (m) => m.containerRecall), 1);
  atLeast('Containers that are deployables', pooled(scored, (m) => m.containerPrecision), 1);
  atLeast('File roles matching the labels', pooled(scored, (m) => m.roleAccuracy), 0.95);
  const uncovered = scored.reduce((sum, repo) => sum + repo.metrics!.viewsWithoutCoverage.length, 0);
  rows.push({
    metric: 'Views rendered without a coverage statement',
    target: '0',
    value: String(uncovered),
    pass: scored.length === 0 ? null : uncovered === 0,
  });
  const errors = repos.length - scored.length;
  rows.push({
    metric: 'Repositories the pipeline completed on',
    target: `${repos.length}/${repos.length}`,
    value: `${scored.length}/${repos.length}`,
    pass: errors === 0,
  });
  return rows;
}

function fmtRatio(ratio: Ratio | null): string {
  if (ratio === null) return '–';
  if (ratio.of === 0) return '0/0';
  return `${ratio.hit}/${ratio.of}`;
}

export function toMarkdown(card: Scorecard): string {
  const lines = [
    '# stratigraph benchmark scorecard',
    '',
    `Generated ${card.generatedAt}. Ground truth is labelled without stratigraph (ADR-0035).`,
    '',
    '## Targets',
    '',
    '| Metric | Target | Value | |',
    '| --- | --- | --- | --- |',
    ...card.targets.map(
      (row) => `| ${row.metric} | ${row.target} | ${row.value} | ${row.pass === null ? '–' : row.pass ? 'pass' : '**FAIL**'} |`,
    ),
    '',
    '## Per repository',
    '',
    '| Repo | s | Extractors | Arch cov. | Non-src top20 | Hotspot top10 | Entities | Tables | Endpoints | Injections | Containers (R/P) | Roles | No coverage |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const repo of card.repos) {
    if (repo.metrics === null) {
      lines.push(`| ${repo.name} | ${repo.seconds.toFixed(0)} | **failed**: ${oneLine(repo.error)} | | | | | | | | | | |`);
      continue;
    }
    const m = repo.metrics;
    const arch = repo.coverage.architecture;
    lines.push(
      `| ${repo.name} | ${repo.seconds.toFixed(0)} | ${repo.extractors
        .map((row) => `${row.language} ${row.status} ${row.parsed}/${row.found}`)
        .join('; ')} | ${arch?.ratio == null ? '?' : `${Math.floor(arch.ratio * 100)}%`}${arch?.withheld ? ' withheld' : ''} | ${m.nonSourceInHotspotTop20.count} | ${fmtRatio(m.hotspotOverlapTop10)} | ${fmtRatio(m.entityRecall)} | ${fmtRatio(m.tableRecall)} | ${fmtRatio(m.endpointRecall)} | ${fmtRatio(m.injectionRecall)} | ${fmtRatio(m.containerRecall)} / ${fmtRatio(m.containerPrecision)} | ${fmtRatio(m.roleAccuracy)} | ${m.viewsWithoutCoverage.length} |`,
    );
  }
  lines.push('', '## What was missed', '');
  for (const repo of card.repos) {
    if (repo.metrics === null) continue;
    const m = repo.metrics;
    const sections: Array<[string, string[]]> = [
      ['non-source hotspots', m.nonSourceInHotspotTop20.paths],
      ['risky files not in the top 10', m.hotspotOverlapTop10?.missed ?? []],
      ['entities', m.entityRecall?.missed ?? []],
      ['tables', m.tableRecall?.missed ?? []],
      ['endpoints', m.endpointRecall?.missed ?? []],
      ['injections', m.injectionRecall?.missed ?? []],
      ['deployables not found', m.containerRecall?.missed ?? []],
      ['containers that are not deployables', m.containerPrecision?.missed ?? []],
      ['roles', m.roleAccuracy?.missed ?? []],
      ['views without coverage', m.viewsWithoutCoverage],
    ];
    const present = sections.filter(([, items]) => items.length > 0);
    if (present.length === 0) continue;
    lines.push(`### ${repo.name}`, '');
    for (const [title, items] of present) {
      lines.push(`- **${title}** (${items.length}): ${items.slice(0, 15).map((item) => `\`${item}\``).join(', ')}${items.length > 15 ? ', …' : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function oneLine(text: string | null): string {
  return (text ?? '').split('\n')[0]!.replace(/\|/g, '\\|').slice(0, 160);
}

/** Aggregates only: nothing that names a file, a type or the repository. */
function printPrivate(repo: RepoResult, rows: Target[]): void {
  if (repo.metrics === null) {
    print('private bench: the pipeline did not complete (the error is not printed, it may name files)');
    return;
  }
  print('# private bench (aggregates only)');
  print('');
  for (const row of repo.extractors) {
    print(`extractor ${row.language}: ${row.status}, ${row.parsed} of ${row.found} main source files parsed`);
  }
  for (const view of VIEWS) {
    const cov = repo.coverage[view];
    print(`coverage ${view}: ${cov?.ratio == null ? 'unknown' : `${Math.floor(cov.ratio * 100)}%`}${cov?.withheld ? ' (withheld)' : ''}`);
  }
  print(`non-source files in hotspot top 20: ${repo.metrics.nonSourceInHotspotTop20.count}`);
  print(`views without a coverage statement: ${repo.metrics.viewsWithoutCoverage.length}`);
  for (const row of rows.filter((r) => r.pass !== null && !r.metric.startsWith('Repositories'))) {
    print(`${row.metric}: ${row.value}`);
  }
}
