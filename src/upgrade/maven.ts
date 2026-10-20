/**
 * Running Maven for an upgrade, and choosing the JDKs it runs on — ADR-0047.
 *
 * The baseline builds on the JDK the project declares (a Boot 2 project on
 * Java 8 may not build on 17), the upgrade on the lowest installed JDK that
 * the target Boot line supports. Every build's full log is kept under the
 * repository's .git directory: evidence for the report, never committed.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { JavaRuntime } from '../toolchain/java.js';

export interface MavenResult {
  exitCode: number;
  timedOut: boolean;
  logPath: string;
  log: string;
  seconds: number;
}

export interface MavenOptions {
  repoPath: string;
  /** Fixed, or chosen per build (Gradle: the recipe moves the wrapper, and the JDK must follow it). */
  javaHome: string | (() => string);
  /** Default maven. */
  tool?: 'maven' | 'gradle' | undefined;
  logDir: string;
  /** Appended to every invocation, e.g. -Dskip.npm. */
  extraArgs: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
}

export type Maven = (args: string[], label: string) => Promise<MavenResult>;

export function createMaven(options: MavenOptions): Maven {
  const gradle = options.tool === 'gradle';
  const wrapper = join(options.repoPath, gradle ? (process.platform === 'win32' ? 'gradlew.bat' : 'gradlew') : process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  const hasWrapper = existsSync(wrapper) && existsSync(join(options.repoPath, gradle ? join('gradle', 'wrapper') : join('.mvn', 'wrapper')));
  // A wrapper committed without its executable bit (common from Windows) is
  // still a shell script: run it through sh rather than fail with EACCES.
  const [command, prefix] = !hasWrapper
    ? [gradle ? 'gradle' : 'mvn', [] as string[]]
    : process.platform !== 'win32' && !isExecutable(wrapper)
      ? ['sh', [wrapper]]
      : [wrapper, [] as string[]];
  const envFor = (javaHome: string) => ({
    ...(options.env ?? process.env),
    JAVA_HOME: javaHome,
    PATH: `${join(javaHome, 'bin')}${delimiter}${(options.env ?? process.env)['PATH'] ?? ''}`,
  });
  // Maven's batch flags; Gradle takes --console=plain from the tool's own args.
  const toolFlags = gradle ? ['--no-daemon'] : ['-B', '-e'];

  return (args, label) =>
    new Promise((resolvePromise, rejectPromise) => {
      const logPath = join(options.logDir, `${label}.log`);
      const out = createWriteStream(logPath);
      const started = Date.now();
      const javaHome = typeof options.javaHome === 'function' ? options.javaHome() : options.javaHome;
      const child = spawn(command, [...prefix, ...toolFlags, ...args, ...options.extraArgs], {
        cwd: options.repoPath,
        env: envFor(javaHome),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, options.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        out.end();
        rejectPromise(new Error(`could not run ${command === 'sh' ? `sh ${wrapper}` : command}: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        out.end(() => {
          resolvePromise({
            exitCode: code ?? 1,
            timedOut,
            logPath,
            log: readFileSync(logPath, 'utf8'),
            seconds: Math.round((Date.now() - started) / 1000),
          });
        });
      });
    });
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `clean verify`, carrying on past failing tests so every test's outcome is reported. */
export const VERIFY = ['clean', 'verify', '-Dmaven.test.failure.ignore=true'];

export interface JdkChoice {
  baseline: JavaRuntime | null;
  target: JavaRuntime | null;
  /** Why each was chosen, or why none could be. */
  notes: string[];
}

/**
 * The baseline JDK: the declared major if installed, else the lowest newer
 * one. The target JDK: the lowest installed at or above both the declared
 * level and the target Boot line's minimum (17 for Boot 3 and 4).
 */
export function chooseJdks(
  declared: number | null,
  targetMinimum: number,
  runtimes: JavaRuntime[],
  /** Gradle only: the JDKs the wrapper's Gradle version runs on, for the baseline. */
  gradleRange: { min: number; max: number } | null = null,
): JdkChoice {
  const ascending = [...runtimes].sort((a, b) => a.major - b.major);
  const notes: string[] = [];
  const want = declared ?? targetMinimum;
  const runs = (jdk: JavaRuntime) => gradleRange === null || (jdk.major >= gradleRange.min && jdk.major <= gradleRange.max);
  const baseline =
    ascending.find((jdk) => jdk.major === want && runs(jdk)) ??
    ascending.find((jdk) => jdk.major > want && runs(jdk)) ??
    (gradleRange !== null ? [...ascending].reverse().find(runs) ?? null : null);
  if (baseline === null) {
    notes.push(
      gradleRange !== null
        ? `no installed JDK runs this project's Gradle (it needs JDK ${gradleRange.min}–${gradleRange.max}) for the baseline build`
        : `no JDK ${want}+ is installed for the baseline build`,
    );
  } else if (baseline.major !== want) {
    notes.push(`baseline builds on JDK ${baseline.major}: no JDK ${want}${gradleRange !== null ? " that this project's Gradle runs on" : ''} is installed`);
  }
  const floor = Math.max(targetMinimum, declared ?? 0);
  const target = ascending.find((jdk) => jdk.major >= floor) ?? null;
  if (target === null) notes.push(`no JDK ${floor}+ is installed; the upgraded build needs one`);
  return { baseline, target, notes };
}
