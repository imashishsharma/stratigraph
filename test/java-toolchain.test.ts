import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverJavaRuntimes,
  extractVersion,
  findJava,
  inspectJavaHome,
  parseMajor,
  readReleaseVersion,
} from '../src/toolchain/java.js';

/** Build a fake JDK: a `bin/java` and the `release` file every JDK ships. */
function fakeJdk(home: string, version: string): string {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'java'), '#!/bin/sh\n');
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

describe('discoverJavaRuntimes', () => {
  it('finds every SDKMAN-managed JDK, newest first', () => {
    const userHome = sdkmanHome(['1.8.0_432', '11.0.25', '17.0.13']);
    const found = discoverJavaRuntimes({ env: {}, platform: 'linux', userHome });
    expect(found.map((r) => r.major)).toEqual([17, 11, 8]);
    expect(found.every((r) => r.source === 'sdkman')).toBe(true);
  });

  it('does not report SDKMAN’s `current` symlink as a second JDK', () => {
    const userHome = sdkmanHome(['1.8.0_432', '17.0.13'], '1.8.0_432');
    const found = discoverJavaRuntimes({ env: {}, platform: 'linux', userHome });
    expect(found.map((r) => r.major)).toEqual([17, 8]);
  });

  it('honours SDKMAN_DIR', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-home-'));
    const sdkmanDir = mkdtempSync(join(tmpdir(), 'strat-sdkman-'));
    fakeJdk(join(sdkmanDir, 'candidates', 'java', '21.0.2-tem'), '21.0.2');
    const found = discoverJavaRuntimes({
      env: { SDKMAN_DIR: sdkmanDir },
      platform: 'linux',
      userHome,
    });
    expect(found.map((r) => r.major)).toEqual([21]);
  });

  it('returns nothing, without throwing, when no JDK is installed anywhere', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-bare-'));
    expect(discoverJavaRuntimes({ env: {}, platform: 'win32', userHome })).toEqual([]);
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
      platform: 'linux',
      userHome,
    });
    expect(found).toMatchObject({ major: 17, source: 'sdkman', meetsMinimum: true });
  });

  it('uses an explicit config home when it is new enough', () => {
    const userHome = sdkmanHome(['17.0.13', '21.0.2']);
    const jdk17 = join(userHome, '.sdkman', 'candidates', 'java', '17.0.13-amzn');
    // Explicit config wins outright: we do not second-guess it upward to 21.
    expect(findJava({ home: jdk17, env: {}, platform: 'linux', userHome })).toMatchObject({
      major: 17,
      source: 'config',
    });
  });

  it('reports the old JDK it did find when nothing meets the minimum', () => {
    const userHome = sdkmanHome(['1.8.0_432']);
    const java8 = join(userHome, '.sdkman', 'candidates', 'java', '1.8.0_432-amzn');
    const found = findJava({ home: java8, env: {}, platform: 'linux', userHome });
    // Not null: "you have 8, you need 17" is a far more useful message than
    // "java not found".
    expect(found).toMatchObject({ major: 8, meetsMinimum: false });
  });

  it('returns null when there is genuinely no JVM', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'strat-bare-'));
    // platform win32 on a mac means none of the scanned roots exist, and the
    // PATH probe is the only thing that could succeed.
    const found = findJava({ env: {}, platform: 'win32', userHome });
    expect(found === null || found.source === 'PATH').toBe(true);
  });
});
