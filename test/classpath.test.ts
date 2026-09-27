import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveClasspath } from '../src/toolchain/classpath.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-cp-test-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('resolveClasspath (ADR-0039)', () => {
  it('stays source-only without a Maven build, and says why', () => {
    expect(resolveClasspath({ repoPath: repo({ 'build.gradle': '' }), javaHome: null, env: {} }).statement).toBe(
      'source-only: Gradle classpaths are not resolved yet',
    );
    expect(resolveClasspath({ repoPath: repo({ 'README.md': '' }), javaHome: null, env: {} }).file).toBeNull();
  });

  it('runs Maven offline, and never the wrapper when its distribution would be downloaded', () => {
    const dir = repo({
      'pom.xml': '<project/>',
      mvnw: '#!/bin/sh',
      '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=https://repo/apache-maven-3.9.9-bin.zip\n',
    });
    const jar = join(dir, 'dep.jar');
    writeFileSync(jar, '');
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = resolveClasspath({
      repoPath: dir,
      javaHome: '/jdk',
      env: { HOME: join(dir, 'no-home') },
      run: (command, args) => {
        calls.push({ command, args });
        const output = args.find((arg) => arg.startsWith('-Dmdep.outputFile='))!.slice('-Dmdep.outputFile='.length);
        writeFileSync(output, `${jar}\n`);
        return 0;
      },
    });
    expect(calls[0]?.command).toBe('mvn');
    expect(calls[0]?.args).toContain('-o');
    expect(result).toMatchObject({ jars: 1 });
    expect(result.statement).toMatch(/^typed: 1 dependency jar/);
  });

  it('falls back to source-only when offline resolution fails', () => {
    const result = resolveClasspath({
      repoPath: repo({ 'pom.xml': '<project/>' }),
      javaHome: null,
      env: {},
      run: () => 1,
    });
    expect(result.file).toBeNull();
    expect(result.statement).toMatch(/^source-only: the dependencies are not all in the local Maven repository/);
  });
});
