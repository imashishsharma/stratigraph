import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { loadConfig, type ConfigOverrides, type StratigraphConfig } from '../config.js';
import { assertSchemaCurrent, openDatabase, requireStore, type Db } from '../db/database.js';
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
import { detectLanguages, LANGUAGES, type Language } from '../toolchain/languages.js';
import { findTsExtractor, missingTsExtractorMessage } from '../toolchain/ts-extractor.js';
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
  /** Which extractors to run. Omitted means "detect from what is on disk". */
  languages?: Set<Language> | 'all' | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Overridable so tests can drive a fake extractor without a JVM or a build. */
  spawnExtractor?: SpawnExtractor | undefined;
}

export interface ExtractResult extends FactWriterStats {
  runId: number;
  jar: ExtractorJar | null;
  /** Which extractors actually ran, in the order they ran. */
  languages: Language[];
  /** Extractors that were selected but could not run, with the reason. */
  skipped: Array<{ language: Language; reason: string }>;
}

/** How an extractor subprocess is started. Injectable for tests. */
export type SpawnExtractor = (
  language: Language,
  repoPath: string,
  args: string[],
) => ReturnType<typeof spawn>;

/**
 * Run every applicable extractor over the repository and write what they emit
 * into **one** run.
 *
 * One run, not one per extractor, and that is the whole reason this command
 * grew a loop. Nodes are scoped by `run_id`, so an Angular service and the
 * Spring endpoint it calls are only joinable — by `src/analysis/http-links.ts`,
 * or by any later analysis — if they were written under the same id.
 *
 * Each extractor is a separate process in a language the core knows nothing
 * about (ADR-0001); all that crosses the boundary is NDJSON on stdout and
 * human-readable progress on stderr, which is relayed to ours. The writer
 * re-points its `extractor` attribution on every `meta` line, so a
 * concatenated stream attributes each fact to whichever extractor produced it
 * with no coordination between them.
 */
export async function runExtract(options: ExtractOptions): Promise<ExtractResult> {
  const config = loadConfig(options);
  const env = options.env ?? process.env;

  // The store first, the toolchains second: a person who has not run `init`
  // needs to hear that, not that a jar is missing — the jar complaint sends
  // them building a toolchain the real error does not need. `--emit` writes
  // to stdout and is exempt.
  if (!options.emit) {
    requireStore(config.dbPath, 'run `stratigraph init` first, then this command again.');
  }

  const selected = selectLanguages(config, options);
  if (selected.length === 0) {
    throw new ExtractError(
      `no Java, Kotlin or TypeScript sources found under ${config.repoPath}. Use --lang to run an ` +
        `extractor anyway, or --include to point at a subdirectory.`,
    );
  }

  // Resolve every toolchain before opening the database, so a missing JDK is
  // reported before a run row exists rather than halfway through one.
  const runnable: Array<{ language: Language; spawn: SpawnExtractor }> = [];
  const skipped: ExtractResult['skipped'] = [];
  for (const language of selected) {
    if (options.spawnExtractor) {
      runnable.push({ language, spawn: options.spawnExtractor });
      continue;
    }
    try {
      runnable.push({ language, spawn: spawnerFor(language, options, config, env) });
    } catch (err) {
      // ADR-0004: a missing JDK disables the Java extractor and nothing else.
      // A repository that is half Angular still gets its Angular half — the
      // alternative is that one absent toolchain costs the whole analysis.
      if (selected.length === 1) throw err;
      skipped.push({ language, reason: (err as Error).message });
    }
  }

  if (runnable.length === 0) {
    throw new ExtractError(
      skipped.map((entry) => `${entry.language}: ${entry.reason}`).join('\n\n'),
    );
  }
  for (const entry of skipped) {
    warn(`skipping the ${entry.language} extractor — ${entry.reason.split('\n')[0]}`);
  }

  const args = [
    '--repo',
    config.repoPath,
    ...config.exclude.flatMap((dir) => ['--exclude', dir]),
    ...config.include.flatMap((prefix) => ['--include', prefix]),
  ];

  if (options.emit) {
    // NDJSON is the product here, so it goes to stdout untouched. This is how a
    // golden gets captured and how a run is replayed through `ingest --from`.
    // Each extractor's `meta` line keeps the concatenation self-describing.
    for (const { language, spawn: spawner } of runnable) {
      const child = start(spawner, language, config.repoPath, args);
      child.stdout.pipe(process.stdout, { end: false });
      const code = await exitCode(child);
      if (code !== 0) {
        throw new ExtractError(`the ${language} extractor exited with status ${code}`);
      }
    }
    return {
      runId: 0,
      jar: null,
      languages: runnable.map((entry) => entry.language),
      skipped,
      files: 0,
      nodes: 0,
      stubs: 0,
      edges: 0,
      diagnostics: 0,
    };
  }

  requireStore(config.dbPath, 'run `stratigraph init` first, then this command again.');
  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);
    const run = createRun(db, config.repoPath);
    const total: FactWriterStats = { files: 0, nodes: 0, stubs: 0, edges: 0, diagnostics: 0 };
    const ran: Language[] = [];

    for (const { language, spawn: spawner } of runnable) {
      const child = start(spawner, language, config.repoPath, args);

      let stats: FactWriterStats;
      try {
        stats = await ingestInto(db, run.id, child.stdout);
      } catch (err) {
        finishRun(db, run.id, 'failed');
        throw err;
      }

      // Only now can this extractor be called successful: a clean fact stream
      // that ends because the process crashed halfway is not a complete
      // analysis, and recording it as one would silently under-report.
      const code = await exitCode(child);
      if (code !== 0) {
        finishRun(db, run.id, 'failed');
        throw new ExtractError(
          `the ${language} extractor exited with status ${code}; run ${run.id} is marked ` +
            `failed and its facts are incomplete`,
        );
      }

      ran.push(language);
      accumulate(total, stats);
      info(`${language.padEnd(10)}  ${summarise(run.id, stats)}`);
    }

    finishRun(db, run.id, 'ok');
    if (ran.length > 1) info(summarise(run.id, total));
    if (total.diagnostics > 0) {
      warn(
        `${total.diagnostics} diagnostic(s) recorded — parts of this repository could not be ` +
          `resolved and are absent from the graph; query the diagnostic table for detail`,
      );
    }
    return { runId: run.id, jar: null, languages: ran, skipped, ...total };
  } finally {
    db.close();
  }
}

/**
 * Which extractors to run: what `--lang` asked for, or what is on disk.
 *
 * `--lang` is honoured even when detection disagrees, because detection is a
 * bounded walk and a user pointing at a subdirectory knows better than it does.
 */
function selectLanguages(config: StratigraphConfig, options: ExtractOptions): Language[] {
  const requested = options.languages;
  if (requested === 'all') return [...LANGUAGES];
  if (requested !== undefined) return LANGUAGES.filter((language) => requested.has(language));
  const detected = detectLanguages(config.repoPath, config.exclude);
  return LANGUAGES.filter((language) => detected.has(language));
}

function start(
  spawner: SpawnExtractor,
  language: Language,
  repoPath: string,
  args: string[],
): ReturnType<typeof spawn> & { stdout: NonNullable<ReturnType<typeof spawn>['stdout']> } {
  const child = spawner(language, repoPath, args);
  if (!child.stdout) {
    throw new ExtractError(`the ${language} extractor produced no stdout stream`);
  }

  // Relay the child's stderr line by line as it arrives, so a long run over a
  // large repository shows progress instead of appearing to hang.
  if (child.stderr) {
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      if (line.trim().length > 0) info(`${language}: ${line}`);
    });
  }

  return child as ReturnType<typeof spawn> & {
    stdout: NonNullable<ReturnType<typeof spawn>['stdout']>;
  };
}

function spawnerFor(
  language: Language,
  options: ExtractOptions,
  config: StratigraphConfig,
  env: NodeJS.ProcessEnv,
): SpawnExtractor {
  return language === 'java'
    ? javaSpawner(options, config.java.home, config.java.jar, env)
    : typescriptSpawner();
}

function typescriptSpawner(): SpawnExtractor {
  const extractor = findTsExtractor();
  if (!extractor) throw new ExtractError(missingTsExtractorMessage());

  info(`extractor   ${extractor.entry} (${extractor.source})`);
  return (_language, _repoPath, args) =>
    spawn(process.execPath, [...extractor.nodeArgs, extractor.entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function javaSpawner(
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

  const jarOptions = {
    jar: options.extractorJar,
    configJar: configJar ?? undefined,
    env,
    cwd: options.cwd,
  };
  const jar = findExtractorJar(jarOptions);
  if (!jar) {
    throw new ExtractError(missingJarMessage(jarOptions));
  }

  info(`java        ${java.version} from ${java.source}`);
  info(`extractor   ${jar.path} (${jar.source})`);

  return (_language, _repoPath, args) =>
    spawn(java.javaBin, [...(options.javaOpts ?? []), '-jar', jar.path, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function accumulate(total: FactWriterStats, stats: FactWriterStats): void {
  total.files += stats.files;
  total.nodes += stats.nodes;
  total.stubs += stats.stubs;
  total.edges += stats.edges;
  total.diagnostics += stats.diagnostics;
}

function exitCode(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}
