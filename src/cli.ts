#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, Option } from 'commander';

import { runDoctor } from './commands/doctor.js';
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
  sendSource?: boolean;
  javaHome?: string;
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
    .option('--java-home <path>', 'JDK used to run the Java extractor')
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
    sendSource: opts.sendSource === true ? true : undefined,
    javaHome: opts.javaHome,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof FactProtocolError) {
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
