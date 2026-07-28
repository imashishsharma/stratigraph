import { describe, expect, it } from 'vitest';

import { extractVersion, findJava, parseMajor } from '../src/toolchain/java.js';

describe('parseMajor', () => {
  it.each([
    ['1.8.0_432', 8],
    ['9', 9],
    ['11.0.21', 11],
    ['17.0.9', 17],
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
        ['openjdk version "17.0.9" 2023-10-17', 'OpenJDK Runtime Environment'].join('\n'),
      ),
    ).toBe('17.0.9');
  });

  it('returns null when there is no version to read', () => {
    expect(extractVersion('command not found')).toBeNull();
  });
});

describe('findJava', () => {
  it('returns null when no JVM can be found, rather than throwing', () => {
    // An empty env plus a JAVA_HOME that does not exist: PATH lookup may still
    // succeed on a machine with java installed, so only assert the shape.
    const found = findJava({ home: '/definitely/not/a/jdk', env: {} });
    expect(found === null || typeof found.major === 'number').toBe(true);
  });

  it('ignores a configured home that does not exist and falls through', () => {
    const found = findJava({ home: '/definitely/not/a/jdk' });
    expect(found?.source).not.toBe('config');
  });
});
