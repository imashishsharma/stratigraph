/**
 * An offline classpath for the Java extractor, when the build's dependencies
 * are already on this machine (ADR-0039).
 *
 * Maven and Gradle, and only offline. For Maven, `mvn -o dependency:build-classpath` resolves
 * from the local repository and fails rather than download. Anything that
 * fails — no pom, no Maven, a cold cache, a timeout — leaves the extraction
 * source-only, and the run records which it was and why, so coverage can say
 * "typed" or "source-only" rather than leave the reader to guess.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { discoverJavaRuntimes, type JavaRuntime } from './java.js';

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
  /** Installed JDKs, for choosing one the project's Gradle can run on. Injectable for tests. */
  runtimes?: JavaRuntime[];
  /** Injectable for tests. */
  run?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => number | null;
}

export function resolveClasspath(options: ClasspathOptions): ClasspathResult {
  const { repoPath } = options;
  if (!existsSync(join(repoPath, 'pom.xml'))) {
    if (existsSync(join(repoPath, 'build.gradle')) || existsSync(join(repoPath, 'build.gradle.kts'))) {
      return resolveGradleClasspath(options);
    }
    return sourceOnly('source-only: no Maven or Gradle build at the repository root');
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

/**
 * Gradle, offline (ADR-0039, amended): an init script adds a task to every
 * project that writes its resolved compile classpath to a file. `--offline`
 * means only what the local Gradle cache already holds; the wrapper is used
 * only when its distribution is cached, since running it otherwise downloads
 * Gradle. Each Gradle version runs on a range of JDKs, so the JDK is chosen
 * for the project's Gradle, not for the extractor.
 */
function resolveGradleClasspath(options: ClasspathOptions): ClasspathResult {
  const { repoPath, env } = options;
  const wrapper = join(repoPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const distribution = gradleWrapperDistribution(repoPath);
  const gradleHome = env['GRADLE_USER_HOME'] ?? join(env['HOME'] ?? homedir(), '.gradle');
  let command: string;
  let version: string | null = null;
  if (existsSync(wrapper) && distribution !== null && gradleDistributionCached(gradleHome, distribution.name)) {
    command = wrapper;
    version = distribution.version;
  } else if (onPath('gradle', env)) {
    command = 'gradle';
  } else {
    return sourceOnly(
      distribution !== null
        ? `source-only: the Gradle ${distribution.version} distribution is not in the local Gradle cache, and no gradle is installed`
        : 'source-only: no Gradle wrapper or installed gradle to resolve the classpath with',
    );
  }

  // The JDK: the newest installed one this Gradle version runs on.
  let javaHome = options.javaHome;
  let javaMajor: number | null = null;
  if (version !== null) {
    const range = gradleJdkRange(version);
    const runtimes = options.runtimes ?? discoverJavaRuntimes({ env });
    const fit = runtimes
      .filter((jdk) => jdk.major >= range.min && jdk.major <= range.max && jdk.home !== undefined)
      .sort((a, b) => b.major - a.major)[0];
    if (fit === undefined) {
      return sourceOnly(`source-only: Gradle ${version} needs a JDK from ${range.min} to ${range.max}, and none is installed`);
    }
    javaHome = fit.home ?? null;
    javaMajor = fit.major;
  }

  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-cp-'));
  const output = join(dir, 'classpath.txt');
  const init = join(dir, 'stratigraph-classpath.gradle');
  writeFileSync(output, '');
  writeFileSync(init, GRADLE_INIT_SCRIPT);
  const run = options.run ?? runProcess;
  const status = run(
    command,
    // --no-daemon: nothing is left running, and no daemon from an earlier
    // build answers with that build's environment (the output path was once
    // read from an env var a reused daemon still held). -D reaches the build.
    ['--offline', '--no-daemon', '-q', '--console=plain', '-I', init, `-Dstratigraph.classpathOut=${output}`, 'stratigraphClasspath'],
    repoPath,
    { ...env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
    options.timeoutMs ?? 300_000,
  );
  if (status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return sourceOnly(
      status === null
        ? 'source-only: offline Gradle classpath resolution did not finish in time'
        : 'source-only: the dependencies are not all in the local Gradle cache (offline resolution failed)',
    );
  }
  const jars = [
    ...new Set(
      readFileSync(output, 'utf8')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.endsWith('.jar') && existsSync(entry)),
    ),
  ];
  if (jars.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return sourceOnly('source-only: offline Gradle resolution produced no jars');
  }
  const list = join(dir, 'jars.txt');
  writeFileSync(list, `${jars.join('\n')}\n`);
  const how = version !== null ? ` (Gradle ${version}${javaMajor !== null ? ` on JDK ${javaMajor}` : ''})` : '';
  return {
    file: list,
    jars: jars.length,
    statement: `typed: ${jars.length} dependency jar(s) resolved offline from the local Gradle cache${how}`,
  };
}

/**
 * Prints every project's resolvable compile classpath to the file named by
 * the stratigraph.classpathOut system property. Lenient: an artifact missing from the offline
 * cache is skipped rather than failing the whole resolution. Written for
 * Gradle 5 through 9 (tasks.register, artifactView).
 */
const GRADLE_INIT_SCRIPT = `allprojects {
    tasks.register('stratigraphClasspath') {
        doLast {
            def out = new File(System.getProperty('stratigraph.classpathOut'))
            ['compileClasspath', 'testCompileClasspath'].each { name ->
                def configuration = project.configurations.findByName(name)
                if (configuration != null && configuration.canBeResolved) {
                    configuration.incoming.artifactView { lenient(true) }.files.each { file ->
                        out << file.absolutePath << System.lineSeparator()
                    }
                }
            }
        }
    }
}
`;

/** The Gradle distribution the wrapper would download, e.g. gradle-6.0.1-all. */
function gradleWrapperDistribution(repoPath: string): { name: string; version: string } | null {
  try {
    const properties = readFileSync(join(repoPath, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    const url = /distributionUrl\s*=\s*(\S+)/.exec(properties)?.[1]?.replace(/\\:/g, ':');
    const name = url?.split('/').pop()?.replace(/\.zip$/, '');
    const version = name ? /^gradle-([\d.]+(?:-rc-\d+)?)/.exec(name)?.[1] : undefined;
    return name && version ? { name, version } : null;
  } catch {
    return null;
  }
}

/** Unpacked and complete: Gradle writes a `.ok` marker beside the zip once it has. */
function gradleDistributionCached(gradleHome: string, name: string): boolean {
  const root = join(gradleHome, 'wrapper', 'dists', name);
  try {
    return readdirSync(root).some((hash) => {
      try {
        return readdirSync(join(root, hash)).some((entry) => entry.endsWith('.ok'));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** The JDKs a Gradle version runs on (docs.gradle.org compatibility matrix). */
export function gradleJdkRange(version: string): { min: number; max: number } {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  const at = (a: number, b: number) => major > a || (major === a && minor >= b);
  const max = at(9, 1) ? 25 : at(8, 14) ? 24 : at(8, 10) ? 23 : at(8, 8) ? 22 : at(8, 5) ? 21 : at(8, 3) ? 20
    : at(7, 6) ? 19 : at(7, 5) ? 18 : at(7, 3) ? 17 : at(7, 0) ? 16 : at(6, 7) ? 15 : at(6, 3) ? 14
    : at(6, 0) ? 13 : at(5, 4) ? 12 : at(5, 0) ? 11 : 10;
  return { min: major >= 9 ? 17 : 8, max };
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env['PATH'] ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && (existsSync(join(dir, command)) || existsSync(join(dir, `${command}.bat`))));
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
