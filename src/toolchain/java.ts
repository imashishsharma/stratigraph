/**
 * Finding a JVM to run the Java extractor in.
 *
 * The core is a Node package and never links against a parser, so the JVM is a
 * runtime detail of one extractor rather than a dependency of the tool. Two
 * consequences shape this file:
 *
 * - The machine's *default* java is frequently the wrong one. Developers who
 *   manage JDKs with SDKMAN, jenv or Gradle toolchains routinely have a modern
 *   JDK installed while `java` on PATH points at 8, because some other project
 *   needs 8. Telling that user to go and switch their global JDK before they
 *   can run us is a good way to never be run — so if the obvious JVM is too
 *   old, we look for a better one rather than giving up.
 * - No JVM at all is not an error. A repo with no Java in it does not need one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OpenRewrite's LST parsers for modern Java need a JDK 17 toolchain. This is
 * the version we run *in*, not the version of the code we can read: the
 * extractor on a JDK 17 happily parses a Java 8 codebase.
 */
export const MIN_JAVA_MAJOR = 17;

export type JavaSource = 'config' | 'JAVA_HOME' | 'PATH' | 'sdkman' | 'jenv' | 'installed';

export interface JavaRuntime {
  /** Path to the `java` executable. */
  javaBin: string;
  /** JDK home, when we know it. Absent for a bare `java` found on PATH. */
  home?: string;
  /** Where we found it, so `stratigraph doctor` can explain itself. */
  source: JavaSource;
  version: string;
  major: number;
  meetsMinimum: boolean;
}

export interface JavaSearchRoot {
  dir: string;
  source: JavaSource;
}

export interface FindJavaOptions {
  /** Explicit JDK home from config, highest precedence. */
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Override the platform. Defaults to the running one. */
  platform?: NodeJS.Platform | undefined;
  /** Override the home directory. Defaults to the running user's. */
  userHome?: string | undefined;
  /**
   * Directories to scan for installed JDKs. Defaults to `installRoots()`.
   * Overridable because the defaults include absolute system paths, which a
   * test cannot otherwise redirect away from the real JDKs on the machine.
   */
  roots?: JavaSearchRoot[] | undefined;
}

/**
 * Resolution order: config `java.home`, `JAVA_HOME`, `java` on PATH, then any
 * JDK we can find installed. The first three win outright *if they meet the
 * minimum*; if they do not, a discovered JDK that does is preferred, and we
 * fall back to reporting the best of a bad set so `doctor` can name the
 * version actually required.
 */
export function findJava(options: FindJavaOptions = {}): JavaRuntime | null {
  const explicit = explicitCandidates(options);
  for (const candidate of explicit) {
    if (candidate.meetsMinimum) return candidate;
  }

  const discovered = discoverJavaRuntimes(options);

  // Of the JDKs that qualify, take the *lowest*. Counter-intuitive, but the
  // extractor is validated against the minimum, and silently running it on a
  // JDK newer than anything we have tested — a just-released major that
  // OpenRewrite may not support yet — trades a clear "needs JDK 17" for an
  // obscure parser failure. Bump MIN_JAVA_MAJOR to move the target.
  const qualifying = discovered.filter((c) => c.meetsMinimum).sort((a, b) => a.major - b.major);
  if (qualifying[0]) return qualifying[0];

  // Nothing is good enough. Return the most visible too-old JVM so the user is
  // told what they have and what is needed, rather than "java not found".
  return explicit[0] ?? discovered[0] ?? null;
}

/** Every JDK we can find, newest first. Exposed for `doctor` and tests. */
export function discoverJavaRuntimes(options: FindJavaOptions = {}): JavaRuntime[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const roots = options.roots ?? installRoots(env, platform, userHome);

  const found: JavaRuntime[] = [];
  const seen = new Set<string>();

  for (const { dir, source } of roots) {
    for (const home of childDirectories(dir)) {
      const runtime = inspectJavaHome(home, source, platform);
      if (!runtime) continue;
      const identity = canonical(runtime.javaBin);
      if (seen.has(identity)) continue; // e.g. SDKMAN's `current` symlink
      seen.add(identity);
      found.push(runtime);
    }
  }

  return found.sort((a, b) => b.major - a.major);
}

/**
 * Read a JDK's version from the `release` file its installer writes, falling
 * back to running it. Every JDK since 8 ships `release`; reading it keeps
 * discovery to file I/O instead of one subprocess per candidate JDK.
 */
export function inspectJavaHome(
  home: string,
  source: JavaSource,
  platform: NodeJS.Platform = process.platform,
): JavaRuntime | null {
  const javaBin = javaBinIn(home, platform);
  if (!existsSync(javaBin)) return null;

  const version = readReleaseVersion(home) ?? probeVersion(javaBin);
  if (!version) return null;

  const major = parseMajor(version);
  return { javaBin, home, source, version, major, meetsMinimum: major >= MIN_JAVA_MAJOR };
}

function explicitCandidates(options: FindJavaOptions): JavaRuntime[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const out: JavaRuntime[] = [];

  if (options.home) {
    const runtime = inspectJavaHome(options.home, 'config', platform);
    if (runtime) out.push(runtime);
  }
  if (env['JAVA_HOME']) {
    const runtime = inspectJavaHome(env['JAVA_HOME'], 'JAVA_HOME', platform);
    if (runtime) out.push(runtime);
  }

  const onPath = probeVersion('java');
  if (onPath) {
    const major = parseMajor(onPath);
    out.push({
      javaBin: 'java',
      source: 'PATH',
      version: onPath,
      major,
      meetsMinimum: major >= MIN_JAVA_MAJOR,
    });
  }
  return out;
}

/** Where JDKs live, by convention, on each platform and version manager. */
export function installRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): JavaSearchRoot[] {
  const roots: JavaSearchRoot[] = [
    { dir: join(env['SDKMAN_DIR'] ?? join(userHome, '.sdkman'), 'candidates', 'java'), source: 'sdkman' },
    { dir: join(userHome, '.jenv', 'versions'), source: 'jenv' },
    { dir: join(userHome, '.gradle', 'jdks'), source: 'installed' },
  ];

  if (platform === 'darwin') {
    roots.push({ dir: '/Library/Java/JavaVirtualMachines', source: 'installed' });
    roots.push({ dir: join(userHome, 'Library/Java/JavaVirtualMachines'), source: 'installed' });
  } else if (platform === 'win32') {
    roots.push({ dir: 'C:\\Program Files\\Java', source: 'installed' });
    roots.push({ dir: 'C:\\Program Files\\Eclipse Adoptium', source: 'installed' });
  } else {
    roots.push({ dir: '/usr/lib/jvm', source: 'installed' });
    roots.push({ dir: '/opt/java', source: 'installed' });
  }

  return roots;
}

function childDirectories(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    homes.push(path);
    // macOS bundles put the JDK under Contents/Home.
    homes.push(join(path, 'Contents', 'Home'));
  }
  return homes;
}

function javaBinIn(home: string, platform: NodeJS.Platform): string {
  return join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java');
}

/** `JAVA_VERSION="17.0.13"` out of `$JAVA_HOME/release`. */
export function readReleaseVersion(home: string): string | null {
  try {
    const release = readFileSync(join(home, 'release'), 'utf8');
    const match = /^JAVA_VERSION="?([^"\n]+)"?/m.exec(release);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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

/** `1.8.0_432` → 8, `17.0.9` → 17, `21` → 21. The 1.x prefix was dropped in 9. */
export function parseMajor(version: string): number {
  const legacy = /^1\.(\d+)/.exec(version);
  if (legacy?.[1]) return Number(legacy[1]);
  const modern = /^(\d+)/.exec(version);
  return modern?.[1] ? Number(modern[1]) : 0;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
