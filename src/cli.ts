#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, Option } from 'commander';

import { AnalysisError, DEFAULT_TOP, runAnalyze } from './commands/analyze.js';
import { runDoctor } from './commands/doctor.js';
import { ExtractError, runExtract } from './commands/extract.js';
import { HistoryError, runHistory } from './commands/history.js';
import { runIngest } from './commands/ingest.js';
import { runInit } from './commands/init.js';
import { ConfigError } from './config.js';
import { FactProtocolError } from './facts/ndjson.js';
import { error, print, setQuiet } from './log.js';
import { TOOL_VERSION } from './version.js';

interface GlobalOptions {
  repo?: string;
  db?: string;
  config?: string;
  llm?: boolean;
  model?: string;
  sendSource?: boolean;
  javaHome?: string;
  extractorJar?: string;
  quiet?: boolean;
}

export function buildProgram(): Command {
  const program = new Command();

  // Throw instead of calling process.exit, so `main` owns every exit path and
  // tests can drive the CLI in-process.
  program.exitOverride();

  program
    .name('stratigraph')
    .description(
      'Read a codebase and its git history; produce a grounded map of its structure.',
    )
    .version(TOOL_VERSION, '-v, --version')
    .option('--repo <path>', 'repository to analyse (default: current directory)')
    .option('--db <path>', 'fact store location (default: .stratigraph/<repo-name>.db)')
    .option('--config <path>', `config file (default: ./stratigraph.config.json)`)
    .option('--model <id>', 'model used by the interpretation layer')
    .option('--java-home <path>', 'JDK used to run the Java extractor')
    .option('--extractor-jar <path>', 'Java extractor jar (default: discovered)')
    .addOption(
      new Option('--no-llm', 'skip the interpretation layer; structural output only'),
    )
    .addOption(
      new Option(
        '--send-source',
        'send raw source bodies to the model API (off by default)',
      ),
    )
    .option('-q, --quiet', 'suppress progress output on stderr')
    .hook('preAction', (thisCommand) => {
      setQuiet(Boolean((thisCommand.opts() as GlobalOptions).quiet));
    });

  program
    .command('init')
    .description('create or migrate the fact store for a repository')
    .action(() => {
      runInit(overrides(program));
    });

  program
    .command('ingest')
    .description('read NDJSON facts from an extractor and write them to the fact store')
    .option('--from <file>', 'read facts from a file instead of stdin')
    .action(async (options: { from?: string }) => {
      await runIngest({ ...overrides(program), from: options.from });
    });

  program
    .command('extract')
    .description('run an extractor over the repository and store the facts it emits')
    .option('--extractor-jar <path>', 'Java extractor jar to run')
    .option('--emit', 'write raw NDJSON to stdout instead of storing it')
    .option('--java-opts <opts>', 'extra JVM arguments, e.g. "-Xmx8g"')
    .action(async (options: { extractorJar?: string; emit?: boolean; javaOpts?: string }) => {
      await runExtract({
        ...overrides(program),
        extractorJar: options.extractorJar,
        emit: options.emit,
        javaOpts: options.javaOpts ? options.javaOpts.split(/\s+/).filter(Boolean) : undefined,
      });
    });

  program
    .command('history')
    .description("mine the repository's git history: commits, churn, complexity, authorship")
    .option('--since <when>', 'only commits after this date; anything `git log --since` accepts')
    .option('--run <id>', 'attach to a specific run instead of the most recent')
    .action(async (options: { since?: string; run?: string }) => {
      await runHistory({
        ...overrides(program),
        since: options.since,
        run: parsePositiveInt('--run', options.run),
      });
    });

  program
    .command('analyze')
    .description(
      'derive structure from stored facts: package cycles, coupling, hotspots, ownership',
    )
    .option('--run <id>', 'analyse a specific run instead of the most recent')
    .option('--top <n>', `rows per report section (default ${DEFAULT_TOP})`)
    .option(
      '--max-files-per-commit <n>',
      'commits touching more than this take no part in coupling',
    )
    .option(
      '--coupling-weight <n>',
      'how much co-change weighs against dependency when clustering (0 disables it)',
    )
    .action(
      (options: {
        run?: string;
        top?: string;
        maxFilesPerCommit?: string;
        couplingWeight?: string;
      }) => {
        runAnalyze({
          ...overrides(program),
          run: parsePositiveInt('--run', options.run),
          top: parsePositiveInt('--top', options.top),
          maxFilesPerCommit: parsePositiveInt(
            '--max-files-per-commit',
            options.maxFilesPerCommit,
          ),
          couplingWeight: parseNonNegativeNumber(
            '--coupling-weight',
            options.couplingWeight,
          ),
        });
      },
    );

  program
    .command('doctor')
    .description('report what this machine can run')
    .action(() => {
      const checks = runDoctor(overrides(program));
      const width = Math.max(...checks.map((c) => c.name.length));
      for (const check of checks) {
        const mark = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : '--  ';
        // The report is what the user asked for, so it goes to stdout.
        print(`${mark} ${check.name.padEnd(width)}  ${check.detail}`);
      }
    });

  return program;
}

function overrides(program: Command) {
  const opts = program.opts<GlobalOptions>();
  return {
    repo: opts.repo,
    db: opts.db,
    config: opts.config,
    // commander sets `llm: false` for --no-llm and leaves it true otherwise;
    // only pass it through when the user actually opted out.
    llm: opts.llm === false ? false : undefined,
    model: opts.model,
    sendSource: opts.sendSource === true ? true : undefined,
    javaHome: opts.javaHome,
    extractorJar: opts.extractorJar,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof FactProtocolError ||
      err instanceof AnalysisError ||
      err instanceof ExtractError ||
      err instanceof HistoryError
    ) {
      error(err.message);
      return 2;
    }
    if (isCommanderExit(err)) {
      return err.exitCode;
    }
    error((err as Error).stack ?? String(err));
    return 1;
  }
}

function parsePositiveInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/** Zero is meaningful for `--coupling-weight`: it turns the history term off. */
function parseNonNegativeNumber(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${flag} must be a number of at least 0, got "${value}"`);
  }
  return parsed;
}

function isCommanderExit(err: unknown): err is { exitCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code?.startsWith('commander.') === true
  );
}

/**
 * True when this module is the process entry point.
 *
 * `argv[1]` must be resolved through symlinks first: npm installs the bin as
 * `node_modules/.bin/stratigraph`, a symlink to this file, so `argv[1]` is the
 * link path while `import.meta.url` is always the real path. Comparing them
 * unresolved makes this false for every installed user — the CLI exits 0 having
 * done nothing, which is exactly how 1.0.0 shipped broken.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/* c8 ignore start */
if (isEntryPoint()) {
  process.exitCode = await main(process.argv);
}
/* c8 ignore stop */
