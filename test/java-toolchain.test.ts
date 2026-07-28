import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverJavaRuntimes,
  extractVersion,
  findJava,
  inspectJavaHome,
  installRoots,
  parseMajor,
  readReleaseVersion,
  type JavaSearchRoot,
} from '../src/toolchain/java.js';

/**
 * Build a fake JDK: a launcher and the `release` file every JDK ships. Both
 * `java` and `java.exe` are written so the fixture is valid whichever platform
 * the test happens to run on.
 */
function fakeJdk(home: string, version: string): string {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'java'), '#!/bin/sh\n');
  writeFileSync(join(home, 'bin', 'java.exe'), '');
  writeFileSync(join(home, 'release'), `JAVA_VERSION="${version}"\nOS_ARCH="aarch64"\n`);
  return home;
}

/** A home directory laid out the way SDKMAN lays one out. */
function sdkmanHome(versions: string[], current?: string): string {
  const userHome = mkdtempSync(join(tmpdir(), 'strat-java-'));
  const candidates = join(userHome, '.sdkman', 'candidates', 'java');
  mkdirSync(candidates, { recursive: true });
  for (const version of versions) {
    fakeJdk(join(candidates, `${version}-amzn`), version);
  }
  if (current) {
    symlinkSync(join(candidates, `${current}-amzn`), join(candidates, 'current'));
  }
  return userHome;
}

/**
 * Scan only the fake SDKMAN tree. The real roots include absolute system paths
 * (`/usr/lib/jvm`, `/Library/Java/...`), so without this a test would also find
 * whatever JDKs the machine happens to have — which is precisely how these
 * tests passed locally and failed on a CI runner with five JDKs installed.
 */
function sdkmanRoots(userHome: string): JavaSearchRoot[] {
  return [{ dir: join(userHome, '.sdkman', 'candidates', 'java'), source: 'sdkman' }];
}

describe('parseMajor', () => {
  it.each([
    ['1.8.0_432', 8],
    ['9', 9],
    ['11.0.25', 11],
    ['17.0.13', 17],
    ['21.0.2', 21],
    ['24-ea', 24],
    ['nonsense', 0],
  ])('%s -> %i', (version, major) => {
    expect(parseMajor(version)).toBe(major);
  });
});

describe('extractVersion', () => {
  it('reads the version out of `java -version` output', () => {
    expect(
      extractVersion(
        ['openjdk version "17.0.13" 2024-10-15', 'OpenJDK Runtime Environment'].join('\n'),
      ),
    ).toBe('17.0.13');
  });

  it('returns null when there is no version to read', () => {
    expect(extractVersion('command not found')).toBeNull();
  });
});

describe('readReleaseVersion', () => {
  it('reads JAVA_VERSION from the release file', () => {
    const home = fakeJdk(mkdtempSync(join(tmpdir(), 'strat-jdk-')), '21.0.2');
    expect(readReleaseVersion(home)).toBe('21.0.2');
  });

  it('returns null for a directory that is not a JDK', () => {
    expect(readReleaseVersion(mkdtempSync(join(tmpdir(), 'strat-nojdk-')))).toBeNull();
  });
});

describe('inspectJavaHome', () => {
  it('reports a JDK without executing it', () => {
    const home = fakeJdk(mkdtempSync(join(tmpdir(), 'strat-jdk-')), '17.0.13');
    // The fake `java` is not even executable; reading `release` is the point.
    expect(inspectJavaHome(home, 'config', 'darwin')).toMatchObject({
      major: 17,
      version: '17.0.13',
      source: 'config',
      meetsMinimum: true,
    });
  });

  it('looks for java.exe on Windows', () => {
    const home = fakeJdk(mkdtempSync(join(tmpdir(), 'strat-jdk-')), '21.0.2');
    expect(inspectJavaHome(home, 'config', 'win32')?.javaBin).toMatch(/java\.exe$/);
  });

  it('returns null when there is no java binary', () => {
    const empty = mkdtempSync(join(tmpdir(), 'strat-empty-'));
    expect(inspectJavaHome(empty, 'config', 'darwin')).toBeNull();
  });

  it('marks an old JDK as not meeting the minimum', () => {
    const home = fakeJdk(mkdtempSync(join(tmpdir(), 'strat-jdk8-')), '1.8.0_432');
    expect(inspectJavaHome(home, 'config', 'darwin')).toMatchObject({
      major: 8,
      meetsMinimum: false,
    });
  });
});

describe('installRoots', () => {
  // Roots are built with path.join, so expectations must be too — a literal
  // '/home/dev/.sdkman/...' does not match '\home\dev\.sdkman\...' on Windows.
  const HOME = '/home/dev';

  it('scans SDKMAN, jenv and Gradle toolchains on every platform', () => {
    const dirs = installRoots({}, 'linux', HOME).map((r) => r.dir);
    expect(dirs).toContain(join(HOME, '.sdkman', 'candidates', 'java'));
    expect(dirs).toContain(join(HOME, '.jenv', 'versions'));
    expect(dirs).toContain(join(HOME, '.gradle', 'jdks'));
  });

  it('honours SDKMAN_DIR over the default location', () => {
    const dirs = installRoots({ SDKMAN_DIR: '/opt/sdkman' }, 'linux', HOME).map((r) => r.dir);
    expect(dirs).toContain(join('/opt/sdkman', 'candidates', 'java'));
    expect(dirs).not.toContain(join(HOME, '.sdkman', 'candidates', 'java'));
  });

  it.each([
    ['darwin' as const, '/Library/Java/JavaVirtualMachines'],
    ['linux' as const, '/usr/lib/jvm'],
    ['win32' as const, 'C:\\Program Files\\Java'],
  ])('includes the %s system location', (platform, expected) => {
    expect(installRoots({}, platform, '/home/dev').map((r) => r.dir)).toContain(expected);
  });
});

describe('discoverJavaRuntimes', () => {
  it('finds every SDKMAN-managed JDK, newest first', () => {
    const userHome = sdkmanHome(['1.8.0_432', '11.0.25', '17.0.13']);
    const found = discoverJavaRuntimes({ roots: sdkmanRoots(userHome) });
    expect(found.map((r) => r.major)).toEqual([17, 11, 8]);
    expect(found.every((r) => r.source === 'sdkman')).toBe(true);
  });

  it('does not report SDKMAN’s `current` symlink as a second JDK', () => {
    const userHome = sdkmanHome(['1.8.0_432', '17.0.13'], '1.8.0_432');
    const found = discoverJavaRuntimes({ roots: sdkmanRoots(userHome) });
    expect(found.map((r) => r.major)).toEqual([17, 8]);
  });

  it('finds a JDK through SDKMAN_DIR', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-home-'));
    const sdkmanDir = mkdtempSync(join(tmpdir(), 'strat-sdkman-'));
    fakeJdk(join(sdkmanDir, 'candidates', 'java', '21.0.2-tem'), '21.0.2');
    const found = discoverJavaRuntimes({
      env: { SDKMAN_DIR: sdkmanDir },
      platform: 'linux',
      userHome,
      roots: [{ dir: join(sdkmanDir, 'candidates', 'java'), source: 'sdkman' }],
    });
    expect(found.map((r) => r.major)).toEqual([21]);
  });

  it('returns nothing, without throwing, when the roots do not exist', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-bare-'));
    expect(discoverJavaRuntimes({ roots: sdkmanRoots(userHome) })).toEqual([]);
  });
});

describe('findJava', () => {
  it('prefers a discovered JDK 17 over a JAVA_HOME pointing at 8', () => {
    // The SDKMAN case: `java` and JAVA_HOME are 8 because another project needs
    // 8, while 17 sits installed one directory over.
    const userHome = sdkmanHome(['1.8.0_432', '17.0.13'], '1.8.0_432');
    const java8 = join(userHome, '.sdkman', 'candidates', 'java', '1.8.0_432-amzn');
    const found = findJava({
      env: { JAVA_HOME: java8 },
      roots: sdkmanRoots(userHome),
    });
    expect(found).toMatchObject({ major: 17, source: 'sdkman', meetsMinimum: true });
  });

  it('uses an explicit config home when it is new enough', () => {
    const userHome = sdkmanHome(['17.0.13', '21.0.2']);
    const jdk17 = join(userHome, '.sdkman', 'candidates', 'java', '17.0.13-amzn');
    // Explicit config wins outright: we do not second-guess it upward to 21.
    expect(findJava({ home: jdk17, env: {}, roots: sdkmanRoots(userHome) })).toMatchObject({
      major: 17,
      source: 'config',
    });
  });

  it('takes the lowest qualifying JDK, not the newest available', () => {
    // The extractor is validated against the minimum. A just-released major
    // that OpenRewrite may not support yet is not an upgrade.
    const userHome = sdkmanHome(['11.0.25', '17.0.13', '21.0.2', '25.0.1']);
    expect(findJava({ env: {}, roots: sdkmanRoots(userHome) })).toMatchObject({ major: 17 });
  });

  it('reports the old JDK it did find when nothing meets the minimum', () => {
    const userHome = sdkmanHome(['1.8.0_432']);
    const java8 = join(userHome, '.sdkman', 'candidates', 'java', '1.8.0_432-amzn');
    const found = findJava({ home: java8, env: {}, roots: sdkmanRoots(userHome) });
    // Not null: "you have 8, you need 17" is a far more useful message than
    // "java not found".
    expect(found).toMatchObject({ major: 8, meetsMinimum: false });
  });

  it('returns null when there is genuinely no JVM', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-bare-'));
    const found = findJava({ env: {}, roots: sdkmanRoots(userHome) });
    // The PATH probe is the only thing left that could succeed, and it will on
    // any machine with java installed.
    expect(found === null || found.source === 'PATH').toBe(true);
  });
});
