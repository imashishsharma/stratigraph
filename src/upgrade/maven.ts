/**
 * Running Maven for an upgrade, and choosing the JDKs it runs on — ADR-0047.
 *
 * The baseline builds on the JDK the project declares (a Boot 2 project on
 * Java 8 may not build on 17), the upgrade on the lowest installed JDK that
 * the target Boot line supports. Every build's full log is kept under the
 * repository's .git directory: evidence for the report, never committed.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
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
  javaHome: string;
  logDir: string;
  /** Appended to every invocation, e.g. -Dskip.npm. */
  extraArgs: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
}

export type Maven = (args: string[], label: string) => Promise<MavenResult>;

export function createMaven(options: MavenOptions): Maven {
  const wrapper = join(options.repoPath, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  const hasWrapper = existsSync(wrapper) && existsSync(join(options.repoPath, '.mvn', 'wrapper'));
  const command = hasWrapper ? wrapper : 'mvn';
  const env = {
    ...(options.env ?? process.env),
    JAVA_HOME: options.javaHome,
    PATH: `${join(options.javaHome, 'bin')}${delimiter}${(options.env ?? process.env)['PATH'] ?? ''}`,
  };

  return (args, label) =>
    new Promise((resolvePromise, rejectPromise) => {
      const logPath = join(options.logDir, `${label}.log`);
      const out = createWriteStream(logPath);
      const started = Date.now();
      const child = spawn(command, ['-B', '-e', ...args, ...options.extraArgs], {
        cwd: options.repoPath,
        env,
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
        rejectPromise(err);
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
export function chooseJdks(declared: number | null, targetMinimum: number, runtimes: JavaRuntime[]): JdkChoice {
  const ascending = [...runtimes].sort((a, b) => a.major - b.major);
  const notes: string[] = [];
  const want = declared ?? targetMinimum;
  const baseline = ascending.find((jdk) => jdk.major === want) ?? ascending.find((jdk) => jdk.major > want) ?? null;
  if (baseline === null) notes.push(`no JDK ${want}+ is installed for the baseline build`);
  else if (baseline.major !== want) notes.push(`baseline builds on JDK ${baseline.major}: no JDK ${want} is installed`);
  const floor = Math.max(targetMinimum, declared ?? 0);
  const target = ascending.find((jdk) => jdk.major >= floor) ?? null;
  if (target === null) notes.push(`no JDK ${floor}+ is installed; the upgraded build needs one`);
  return { baseline, target, notes };
}
