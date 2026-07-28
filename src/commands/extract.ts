import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { assertSchemaCurrent, openDatabase } from '../db/database.js';
import { createRun, finishRun } from '../db/run.js';
import { ingestInto } from '../facts/ingest.js';
import type { FactWriterStats } from '../facts/writer.js';
import { info, warn } from '../log.js';
import {
  findExtractorJar,
  missingJarMessage,
  type ExtractorJar,
} from '../toolchain/extractor-jar.js';
import { findJava, MIN_JAVA_MAJOR } from '../toolchain/java.js';
import { summarise } from './ingest.js';

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractOptions extends ConfigOverrides {
  /** Explicit path to the extractor jar. */
  extractorJar?: string | undefined;
  /** Write raw NDJSON to stdout instead of ingesting it. */
  emit?: boolean | undefined;
  /** Extra JVM arguments, e.g. `-Xmx8g` for a large repository. */
  javaOpts?: string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Overridable so tests can drive a fake extractor without a JVM. */
  spawnExtractor?: SpawnExtractor | undefined;
}

export interface ExtractResult extends FactWriterStats {
  runId: number;
  jar: ExtractorJar | null;
}

/** How the extractor subprocess is started. Injectable for tests. */
export type SpawnExtractor = (repoPath: string, args: string[]) => ReturnType<typeof spawn>;

/**
 * Run an extractor and write what it emits into the fact store.
 *
 * The extractor is a separate process in a language the core knows nothing
 * about (ADR-0001); all that crosses the boundary is NDJSON on its stdout and
 * human-readable progress on its stderr, which is relayed to ours.
 */
export async function runExtract(options: ExtractOptions): Promise<ExtractResult> {
  const config = loadConfig(options);
  const env = options.env ?? process.env;

  const spawnExtractor =
    options.spawnExtractor ?? defaultSpawner(options, config.java.home, config.java.jar, env);

  const args = [
    '--repo',
    config.repoPath,
    ...config.exclude.flatMap((dir) => ['--exclude', dir]),
    ...config.include.flatMap((prefix) => ['--include', prefix]),
  ];

  const child = spawnExtractor(config.repoPath, args);
  if (!child.stdout) {
    throw new ExtractError('extractor produced no stdout stream');
  }

  // Relay the child's stderr line by line as it arrives, so a long run over a
  // large repository shows progress instead of appearing to hang.
  if (child.stderr) {
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      if (line.trim().length > 0) info(`java: ${line}`);
    });
  }

  const exited = exitCode(child);

  if (options.emit) {
    // NDJSON is the product here, so it goes to stdout untouched. This is how
    // a golden gets captured and how a run is replayed through `ingest --from`.
    child.stdout.pipe(process.stdout);
    const code = await exited;
    if (code !== 0) throw new ExtractError(`extractor exited with status ${code}`);
    return { runId: 0, jar: null, files: 0, nodes: 0, stubs: 0, edges: 0, diagnostics: 0 };
  }

  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);
    const run = createRun(db, config.repoPath);

    let stats: FactWriterStats;
    try {
      stats = await ingestInto(db, run.id, child.stdout);
    } catch (err) {
      finishRun(db, run.id, 'failed');
      throw err;
    }

    // Only now can the run be called successful: a clean fact stream that ends
    // because the extractor crashed halfway is not a complete analysis, and
    // recording it as one would silently under-report the repository.
    const code = await exited;
    if (code !== 0) {
      finishRun(db, run.id, 'failed');
      throw new ExtractError(
        `extractor exited with status ${code}; run ${run.id} is marked failed and its ` +
          `facts are incomplete`,
      );
    }

    finishRun(db, run.id, 'ok');
    info(summarise(run.id, stats));
    if (stats.diagnostics > 0) {
      warn(
        `${stats.diagnostics} diagnostic(s) recorded — parts of this repository could not be ` +
          `resolved and are absent from the graph; query the diagnostic table for detail`,
      );
    }
    return { runId: run.id, jar: null, ...stats };
  } finally {
    db.close();
  }
}

function defaultSpawner(
  options: ExtractOptions,
  configJavaHome: string | null,
  configJar: string | null,
  env: NodeJS.ProcessEnv,
): SpawnExtractor {
  const java = findJava({ home: options.javaHome ?? configJavaHome ?? undefined, env });
  if (!java) {
    throw new ExtractError(
      `no JDK found. The Java extractor needs a JDK ${MIN_JAVA_MAJOR}+; set java.home in the ` +
        `config, --java-home, or JAVA_HOME. Run \`stratigraph doctor\` for what this machine has.`,
    );
  }
  if (!java.meetsMinimum) {
    throw new ExtractError(
      `found Java ${java.version} from ${java.source}, but the Java extractor needs a JDK ` +
        `${MIN_JAVA_MAJOR}+. Run \`stratigraph doctor\` to see what else is installed.`,
    );
  }

  const jarOptions = { jar: options.extractorJar, configJar: configJar ?? undefined, env, cwd: options.cwd };
  const jar = findExtractorJar(jarOptions);
  if (!jar) {
    throw new ExtractError(missingJarMessage(jarOptions));
  }

  info(`java        ${java.version} from ${java.source}`);
  info(`extractor   ${jar.path} (${jar.source})`);

  return (_repoPath, args) =>
    spawn(java.javaBin, [...(options.javaOpts ?? []), '-jar', jar.path, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function exitCode(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}
