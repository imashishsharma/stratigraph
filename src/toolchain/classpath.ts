/**
 * An offline classpath for the Java extractor, when the build's dependencies
 * are already on this machine (ADR-0039).
 *
 * Maven only, and only offline: `mvn -o dependency:build-classpath` resolves
 * from the local repository and fails rather than download. Anything that
 * fails — no pom, no Maven, a cold cache, a timeout — leaves the extraction
 * source-only, and the run records which it was and why, so coverage can say
 * "typed" or "source-only" rather than leave the reader to guess.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface ClasspathResult {
  /** A file listing one jar per line, for `--classpath-file`; null when source-only. */
  file: string | null;
  jars: number;
  /** One sentence for the run record: what was resolved, or why nothing was. */
  statement: string;
}

export interface ClasspathOptions {
  repoPath: string;
  javaHome: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests. */
  run?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => number | null;
}

export function resolveClasspath(options: ClasspathOptions): ClasspathResult {
  const { repoPath } = options;
  if (!existsSync(join(repoPath, 'pom.xml'))) {
    return sourceOnly(
      existsSync(join(repoPath, 'build.gradle')) || existsSync(join(repoPath, 'build.gradle.kts'))
        ? 'source-only: Gradle classpaths are not resolved yet'
        : 'source-only: no Maven build at the repository root',
    );
  }
  const wrapper = join(repoPath, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  // The wrapper downloads Maven itself when its distribution is not cached —
  // a network step this project does not take. Use it only when it is.
  const command = existsSync(wrapper) && wrapperIsCached(repoPath, options.env) ? wrapper : 'mvn';

  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-cp-'));
  const output = join(dir, 'classpath.txt');
  writeFileSync(output, '');
  const env = { ...options.env, ...(options.javaHome ? { JAVA_HOME: options.javaHome } : {}) };
  const run = options.run ?? runProcess;
  const status = run(
    command,
    [
      '-o',
      '-q',
      '-B',
      'dependency:build-classpath',
      `-Dmdep.outputFile=${output}`,
      '-Dmdep.appendOutput=true',
      '-Dmdep.includeScope=compile',
    ],
    repoPath,
    env,
    options.timeoutMs ?? 180_000,
  );
  if (status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return sourceOnly(
      status === null
        ? 'source-only: offline Maven classpath resolution did not finish in time'
        : 'source-only: the dependencies are not all in the local Maven repository (offline resolution failed)',
    );
  }

  const jars = [
    ...new Set(
      readFileSync(output, 'utf8')
        .split(/\r?\n/)
        .flatMap((line) => line.split(delimiter))
        .map((entry) => entry.trim())
        .filter((entry) => entry.endsWith('.jar') && existsSync(entry)),
    ),
  ];
  if (jars.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return sourceOnly('source-only: offline Maven resolution produced no jars');
  }
  const list = join(dir, 'jars.txt');
  writeFileSync(list, `${jars.join('\n')}\n`);
  return {
    file: list,
    jars: jars.length,
    statement: `typed: ${jars.length} dependency jar(s) resolved offline from the local Maven repository`,
  };
}

function wrapperIsCached(repoPath: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const properties = readFileSync(join(repoPath, '.mvn', 'wrapper', 'maven-wrapper.properties'), 'utf8');
    const url = /distributionUrl\s*=\s*(\S+)/.exec(properties)?.[1];
    if (url === undefined) return false;
    const name = url.split('/').pop()?.replace(/\.zip$/, '') ?? '';
    const home = env['MAVEN_USER_HOME'] ?? join(env['HOME'] ?? homedir(), '.m2');
    return existsSync(join(home, 'wrapper', 'dists', name));
  } catch {
    return false;
  }
}

function sourceOnly(statement: string): ClasspathResult {
  return { file: null, jars: 0, statement };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): number | null {
  const result = spawnSync(command, args, { cwd, env, timeout: timeoutMs, stdio: 'ignore' });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return null;
  if (result.signal !== null) return null;
  return result.status ?? 1;
}
