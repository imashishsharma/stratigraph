#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discover, isDirectory } from './discovery.js';
import { TypeScriptExtractor } from './extractor.js';
import { FactEmitter, type LineSink } from './protocol.js';

/**
 * Entry point for the TypeScript/Angular extractor.
 *
 * A separate process that emits NDJSON facts on stdout and human-readable
 * progress on stderr (ADR-0001, ADR-0003), with the same command line as
 * `Main.java`. The core never imports anything under this directory — the build
 * compiles it with its own `rootDir`, so a stray import from `src/` fails to
 * compile rather than quietly linking a parser into the core.
 */

export const EXTRACTOR = 'typescript';
export const VERSION = '1.0.0';

/** Mirrors the core's default excludes, so both sides skip the same trees. */
const DEFAULT_EXCLUDES = ['node_modules', 'target', 'build', 'dist', '.git', '.idea', '.gradle'];

export interface Streams {
  stdout: LineSink;
  stderr: LineSink;
}

export function run(argv: string[], streams: Streams): number {
  let repo: string | null = null;
  const excludes = new Set(DEFAULT_EXCLUDES);
  const includes: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--repo':
        repo = requireValue(argv, ++i, '--repo');
        break;
      case '--exclude':
        excludes.add(requireValue(argv, ++i, '--exclude'));
        break;
      case '--include':
        includes.push(requireValue(argv, ++i, '--include'));
        break;
      case '--no-default-excludes':
        for (const dir of DEFAULT_EXCLUDES) excludes.delete(dir);
        break;
      case '--version':
        streams.stderr.write(`${EXTRACTOR} extractor ${VERSION}`);
        return 0;
      case '--help':
        usage(streams.stderr);
        return 0;
      default:
        streams.stderr.write(`error: unknown argument ${arg}`);
        usage(streams.stderr);
        return 2;
    }
  }

  if (repo === null) {
    streams.stderr.write('error: --repo is required');
    usage(streams.stderr);
    return 2;
  }
  const repoRoot = resolve(repo);
  if (!isDirectory(repoRoot)) {
    streams.stderr.write(`error: not a directory: ${repoRoot}`);
    return 2;
  }

  const emitter = new FactEmitter(streams.stdout);
  emitter.meta(EXTRACTOR, VERSION, repoRoot);

  const discovery = discover({
    repoRoot,
    excludedDirectories: excludes,
    includePrefixes: includes,
  });
  streams.stderr.write(
    `discovered ${discovery.sources.length} typescript source(s) and ` +
      `${discovery.templates.length} template(s) in ${discovery.modules.length} module(s)`,
  );

  new TypeScriptExtractor(repoRoot, emitter, discovery).run();
  streams.stderr.write(emitter.summary());
  return 0;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(stderr: LineSink): void {
  stderr.write(
    'usage: node main.js --repo <path> [--include <prefix>]... [--exclude <dir>]... ' +
      '[--no-default-excludes]',
  );
  stderr.write('emits NDJSON facts on stdout; progress and diagnostics on stderr');
}

/**
 * True when this module is the process entry point.
 *
 * `argv[1]` is resolved through symlinks first, for the reason `src/cli.ts`
 * documents at length: an unresolved comparison is false for every installed
 * user, and the process then exits zero having emitted nothing — which reads
 * downstream as a repository containing no TypeScript.
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
  const streams: Streams = {
    stdout: { write: (line) => process.stdout.write(`${line}\n`) },
    stderr: { write: (line) => process.stderr.write(`${line}\n`) },
  };
  try {
    process.exitCode = run(process.argv.slice(2), streams);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
