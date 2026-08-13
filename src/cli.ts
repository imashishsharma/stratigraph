#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, Option } from 'commander';

import { AnalysisError, DEFAULT_TOP, GateError, runAnalyze } from './commands/analyze.js';
import { runConfigPaths, runConfigSetKey } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { DiffError, runDiff } from './commands/diff.js';
import { ExtractError, runExtract } from './commands/extract.js';
import { runFetchExtractor } from './commands/fetch-extractor.js';
import { HistoryError, runHistory } from './commands/history.js';
import { runIngest } from './commands/ingest.js';
import { runInit } from './commands/init.js';
import { McpError, runMcp } from './commands/mcp.js';
import { DEFAULT_KEEP, PruneError, runPrune } from './commands/prune.js';
import {
  DEFAULT_TOP as DEFAULT_REPORT_TOP,
  ReportError,
  runReport,
} from './commands/report.js';
import { CONFIG_FILENAME, ConfigError, userConfigPath } from './config.js';
import { MissingStoreError } from './db/database.js';
import { JarFetchError } from './toolchain/jar-cache.js';
import { FactProtocolError } from './facts/ndjson.js';
import { error, outputFormat, print, printJson, setFormat, setQuiet } from './log.js';
import { GATE_SEVERITIES, isGateSeverity, type GateSeverity } from './present/findings.js';
import {
  doctorDocument,
  extractDocument,
  fetchExtractorDocument,
  historyDocument,
  pruneDocument,
} from './present/json.js';
import { parseLanguages, type Language } from './toolchain/languages.js';
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
  format?: string;
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
    .addOption(
      new Option('--format <format>', "output as 'text' for a person or 'json' for a pipeline")
        .choices(['text', 'json'])
        .default('text'),
    )
    .option('-q, --quiet', 'suppress progress output on stderr')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as GlobalOptions;
      setQuiet(Boolean(opts.quiet));
      setFormat(opts.format === 'json' ? 'json' : 'text');
    });

  program
    .command('init')
    .description('create or migrate the fact store, and optionally a config file')
    .option('--write-config', `also write ${CONFIG_FILENAME} if it does not exist`)
    .action((options: { writeConfig?: boolean }) => {
      runInit({ ...overrides(program), writeConfig: options.writeConfig });
    });

  const config = program
    .command('config')
    .description('show where settings come from, or set the model API key');

  config
    .command('paths', { isDefault: true })
    .description('list every file that configures a run, and which credential is in use')
    .action(() => {
      runConfigPaths(overrides(program));
    });

  config
    .command('set-key <key>')
    .description(`write llm.apiKey into ${userConfigPath()}`)
    .action((key: string) => {
      runConfigSetKey(key, overrides(program));
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
    .description('run every applicable extractor over the repository and store the facts')
    .option('--extractor-jar <path>', 'Java extractor jar to run')
    .option('--emit', 'write raw NDJSON to stdout instead of storing it')
    .option('--java-opts <opts>', 'extra JVM arguments, e.g. "-Xmx8g"')
    .option(
      '--lang <names>',
      'extractors to run: java, ts, all, or a comma-separated list (default: detect)',
    )
    .action(
      async (options: {
        extractorJar?: string;
        emit?: boolean;
        javaOpts?: string;
        lang?: string;
      }) => {
        const result = await runExtract({
          ...overrides(program),
          extractorJar: options.extractorJar,
          emit: options.emit,
          javaOpts: options.javaOpts ? options.javaOpts.split(/\s+/).filter(Boolean) : undefined,
          languages: parseLanguageFlag(options.lang),
        });
        // `--emit` already owns stdout: the NDJSON is the product, and a
        // summary document after it would corrupt the stream it describes.
        if (outputFormat() === 'json' && !options.emit) {
          printJson(extractDocument(result));
        }
      },
    );

  program
    .command('history')
    .description("mine the repository's git history: commits, churn, complexity, authorship")
    .option('--since <when>', 'only commits after this date; anything `git log --since` accepts')
    .option('--run <id>', 'attach to a specific run instead of the most recent')
    .action(async (options: { since?: string; run?: string }) => {
      const result = await runHistory({
        ...overrides(program),
        since: options.since,
        run: parsePositiveInt('--run', options.run),
      });
      if (outputFormat() === 'json') printJson(historyDocument(result));
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
    .addOption(
      new Option(
        '--fail-on <severity>',
        'exit 3 when a publishable finding reaches this severity',
      ).choices([...GATE_SEVERITIES]),
    )
    .action(
      async (options: {
        run?: string;
        top?: string;
        maxFilesPerCommit?: string;
        couplingWeight?: string;
        failOn?: string;
      }) => {
        await runAnalyze({
          ...overrides(program),
          run: parsePositiveInt('--run', options.run),
          top: parsePositiveInt('--top', options.top),
          failOn: parseFailOn(options.failOn),
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
    .command('report')
    .description('write C4 diagrams, a ranked findings list and a static HTML report')
    .requiredOption('--out <dir>', 'directory to write the report into')
    .option('--run <id>', 'report a specific run instead of the most recent')
    .option('--top <n>', `rows per section (default ${DEFAULT_REPORT_TOP})`)
    .addOption(
      new Option(
        '--fail-on <severity>',
        'exit 3 when a publishable finding reaches this severity',
      ).choices([...GATE_SEVERITIES]),
    )
    .action((options: { out: string; run?: string; top?: string; failOn?: string }) => {
      runReport({
        ...overrides(program),
        out: options.out,
        run: parsePositiveInt('--run', options.run),
        top: parsePositiveInt('--top', options.top),
        failOn: parseFailOn(options.failOn),
      });
    });

  program
    .command('diff')
    .description('compare two runs: findings gained and resolved, and how the structure moved')
    .option('--from <id>', 'the earlier run (default: the analysed run before --to)')
    .option('--to <id>', 'the later run (default: the most recent analysed run)')
    .addOption(
      new Option(
        '--fail-on-new <severity>',
        'exit 3 when a finding this severe is new; pre-existing ones do not count',
      ).choices([...GATE_SEVERITIES]),
    )
    .action((options: { from?: string; to?: string; failOnNew?: string }) => {
      runDiff({
        ...overrides(program),
        from: parsePositiveInt('--from', options.from),
        to: parsePositiveInt('--to', options.to),
        failOnNew: parseFailOn(options.failOnNew),
      });
    });

  program
    .command('fetch-extractor')
    .description('download the Java extractor jar, verified against a pinned checksum')
    .option('--force', 're-download even if this version is already cached')
    .option('--dry-run', 'report the URL, target and checksum; download nothing')
    .action(async (options: { force?: boolean; dryRun?: boolean }) => {
      const result = await runFetchExtractor({ force: options.force, dryRun: options.dryRun });
      if (outputFormat() === 'json') printJson(fetchExtractorDocument(result));
    });

  program
    .command('prune')
    .description('delete all but the newest runs from the fact store, and reclaim the space')
    .option('--keep <n>', `newest runs to keep (default ${DEFAULT_KEEP})`)
    .option('--dry-run', 'list what would go; delete nothing')
    .action((options: { keep?: string; dryRun?: boolean }) => {
      const result = runPrune({
        ...overrides(program),
        keep: parsePositiveInt('--keep', options.keep),
        dryRun: options.dryRun,
      });
      if (outputFormat() === 'json') printJson(pruneDocument(result));
    });

  program
    .command('mcp')
    .description('serve the fact store over MCP on stdio, for an agent to query')
    .option('--run <id>', 'serve a specific run instead of the most recent')
    .action(async (options: { run?: string }) => {
      const serving = await runMcp({
        ...overrides(program),
        run: parsePositiveInt('--run', options.run),
      });
      // Stay up until the client closes the transport. Without this the
      // process would exit as soon as the command's action resolved.
      await serving.closed;
    });

  program
    .command('doctor')
    .description('report what this machine can run')
    .action(() => {
      const checks = runDoctor(overrides(program));
      if (outputFormat() === 'json') {
        printJson(doctorDocument(checks));
        return;
      }
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
    // A tripped `--fail-on` is not a malfunction, and a pipeline has to tell
    // the two apart: 3 means the analysis ran and the repository failed the
    // threshold, where 1 and 2 both mean no verdict was reached.
    if (err instanceof GateError) {
      error(err.message);
      return 3;
    }
    if (
      err instanceof ConfigError ||
      err instanceof FactProtocolError ||
      err instanceof AnalysisError ||
      err instanceof DiffError ||
      err instanceof ExtractError ||
      err instanceof HistoryError ||
      err instanceof McpError ||
      err instanceof JarFetchError ||
      err instanceof MissingStoreError ||
      err instanceof PruneError ||
      err instanceof ReportError
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

/** `--lang`. Undefined means "detect from what is on disk". */
function parseLanguageFlag(value: string | undefined): Set<Language> | 'all' | undefined {
  if (value === undefined) return undefined;
  try {
    return parseLanguages(value);
  } catch (err) {
    throw new ConfigError(`--lang: ${(err as Error).message}`);
  }
}

/**
 * `--fail-on`. Commander's `.choices()` already rejects anything else, so this
 * is the narrowing rather than the validation.
 */
function parseFailOn(value: string | undefined): GateSeverity | undefined {
  if (value === undefined) return undefined;
  if (!isGateSeverity(value)) {
    throw new ConfigError(
      `--fail-on must be one of ${GATE_SEVERITIES.join(', ')}, got "${value}"`,
    );
  }
  return value;
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
