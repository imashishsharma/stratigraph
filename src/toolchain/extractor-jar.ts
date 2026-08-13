/**
 * Finding the Java extractor jar.
 *
 * Four places someone can put one and one the tool fills in itself: the cache
 * written by `stratigraph fetch-extractor`, which is the path a user who did
 * not build this from a checkout takes (ADR-0004). A locally built jar still
 * wins over a downloaded one, because a developer who just ran maven means the
 * jar they just built.
 *
 * When there is none, the failure has to be a sentence that says what to do
 * rather than a stack trace naming a path the reader has never heard of.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_VERSION } from '../version.js';
import { cachedJarPath, JAR_NAME } from './jar-cache.js';

export { JAR_NAME };
export const JAR_ENV_VAR = 'STRATIGRAPH_JAVA_JAR';

export type JarSource = 'flag' | 'config' | 'env' | 'build' | 'cache';

export interface ExtractorJar {
  path: string;
  source: JarSource;
}

export interface FindJarOptions {
  /** `--extractor-jar`, highest precedence. */
  jar?: string | undefined;
  /** `java.jar` from the config file. */
  configJar?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  /** Overridable so a test can point at a fixture instead of a real build. */
  buildOutput?: string | undefined;
  /** The version whose cached jar to look for. Defaults to this package's. */
  version?: string | undefined;
}

/**
 * The jar built by `extractors/java`, relative to this module.
 *
 * Resolves to the package root from both `src/toolchain/` (running from source)
 * and `dist/toolchain/` (running the built CLI), so a developer who has built
 * the extractor never has to pass a path.
 */
export function defaultBuildOutput(): string {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  return join(packageRoot, 'extractors', 'java', 'target', JAR_NAME);
}

export function findExtractorJar(options: FindJarOptions = {}): ExtractorJar | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const candidates: Array<[string | undefined, JarSource]> = [
    [options.jar, 'flag'],
    [options.configJar, 'config'],
    [env[JAR_ENV_VAR], 'env'],
    [options.buildOutput ?? defaultBuildOutput(), 'build'],
    [cachedJarPath(options.version ?? TOOL_VERSION, { env }), 'cache'],
  ];

  for (const [path, source] of candidates) {
    if (!path) continue;
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      return { path: absolute, source };
    }
  }
  return null;
}

/**
 * What to tell someone who has no jar. Names every place that was looked at,
 * because "extractor not found" without a list is a dead end.
 */
export function missingJarMessage(options: FindJarOptions = {}): string {
  const env = options.env ?? process.env;
  const looked = [
    options.jar ? `--extractor-jar ${options.jar}` : null,
    options.configJar ? `java.jar in the config file (${options.configJar})` : null,
    env[JAR_ENV_VAR] ? `${JAR_ENV_VAR}=${env[JAR_ENV_VAR]}` : null,
    options.buildOutput ?? defaultBuildOutput(),
    cachedJarPath(options.version ?? TOOL_VERSION, { env }),
  ].filter((entry): entry is string => entry !== null);

  return [
    'the Java extractor jar was not found. Looked at:',
    ...looked.map((entry) => `  ${entry}`),
    '',
    'Download it, verified against the checksum pinned in this package:',
    '  stratigraph fetch-extractor',
    '',
    'Or build it from a checkout:',
    '  cd extractors/java && ./mvnw package',
    `or point at one with --extractor-jar <path>, java.jar in the config, or ${JAR_ENV_VAR}.`,
  ].join('\n');
}
