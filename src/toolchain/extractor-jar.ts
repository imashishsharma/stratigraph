/**
 * Finding the Java extractor jar.
 *
 * ADR-0004 describes the end state: the jar is downloaded from the GitHub
 * release matching the installed package version, checksum-verified, and cached
 * under the platform cache directory. That path lands when there is a release
 * with a jar attached to fetch — it cannot be built or tested against nothing.
 *
 * Until then the jar is supplied locally, and the failure mode when it is
 * absent has to be a sentence that tells the user what to do rather than a
 * stack trace naming a path they have never heard of.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JAR_NAME = 'stratigraph-java-extractor.jar';
export const JAR_ENV_VAR = 'STRATIGRAPH_JAVA_JAR';

export type JarSource = 'flag' | 'config' | 'env' | 'build';

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
  ].filter((entry): entry is string => entry !== null);

  return [
    'the Java extractor jar was not found. Looked at:',
    ...looked.map((entry) => `  ${entry}`),
    '',
    'Build it from a checkout:',
    '  cd extractors/java && ./mvnw package',
    `or point at one with --extractor-jar <path>, java.jar in the config, or ${JAR_ENV_VAR}.`,
  ].join('\n');
}
