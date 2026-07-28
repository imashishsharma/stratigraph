/**
 * Finding a JVM to run the Java extractor in.
 *
 * The core is a Node package and never links against a parser, so the JVM is a
 * runtime detail of one extractor rather than a dependency of the tool. Nothing
 * here assumes the user's `java` on PATH is the one we want, and nothing here
 * fails the whole pipeline when there is no JVM at all — a repo with no Java in
 * it does not need one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OpenRewrite's LST parsers for modern Java need a JDK 17 toolchain. Older JDKs
 * can still be the *target* of analysis — this is the version we run *in*, not
 * the version of the code we read.
 */
export const MIN_JAVA_MAJOR = 17;

export interface JavaRuntime {
  /** Path to the `java` executable. */
  javaBin: string;
  /** Where we found it, for `arch doctor` to explain itself. */
  source: 'config' | 'JAVA_HOME' | 'PATH';
  version: string;
  major: number;
  meetsMinimum: boolean;
}

export interface FindJavaOptions {
  /** Explicit JDK home from config, highest precedence. */
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Resolution order: config `java.home` → `JAVA_HOME` → `java` on PATH. */
export function findJava(options: FindJavaOptions = {}): JavaRuntime | null {
  const env = options.env ?? process.env;

  const candidates: Array<{ bin: string; source: JavaRuntime['source'] }> = [];
  if (options.home) candidates.push({ bin: javaBinIn(options.home), source: 'config' });
  if (env['JAVA_HOME']) candidates.push({ bin: javaBinIn(env['JAVA_HOME']), source: 'JAVA_HOME' });
  candidates.push({ bin: 'java', source: 'PATH' });

  for (const candidate of candidates) {
    if (candidate.source !== 'PATH' && !existsSync(candidate.bin)) continue;
    const version = probeVersion(candidate.bin);
    if (!version) continue;
    const major = parseMajor(version);
    return {
      javaBin: candidate.bin,
      source: candidate.source,
      version,
      major,
      meetsMinimum: major >= MIN_JAVA_MAJOR,
    };
  }
  return null;
}

function javaBinIn(home: string): string {
  return join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function probeVersion(javaBin: string): string | null {
  try {
    // `java -version` writes to stderr on every JDK ever shipped.
    const out = execFileSync(javaBin, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return extractVersion(out);
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    if (stderr) return extractVersion(stderr.toString());
    return null;
  }
}

export function extractVersion(output: string): string | null {
  const match = /version "([^"]+)"/.exec(output);
  return match?.[1] ?? null;
}

/**
 * `1.8.0_432` → 8, `17.0.9` → 17, `21` → 21. The 1.x prefix was dropped in 9.
 */
export function parseMajor(version: string): number {
  const legacy = /^1\.(\d+)/.exec(version);
  if (legacy?.[1]) return Number(legacy[1]);
  const modern = /^(\d+)/.exec(version);
  return modern?.[1] ? Number(modern[1]) : 0;
}
