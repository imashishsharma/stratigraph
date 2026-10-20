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
  it('stays source-only without a build it can resolve, and says why', () => {
    expect(resolveClasspath({ repoPath: repo({ 'README.md': '' }), javaHome: null, env: {} })).toMatchObject({
      file: null,
      statement: 'source-only: no Maven or Gradle build at the repository root',
    });
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

describe('resolveClasspath for Gradle (ADR-0039, amended)', () => {
  const jdk = (major: number) => ({ javaBin: `/jdk${major}/bin/java`, home: `/jdk${major}`, source: 'sdkman' as const, version: `${major}.0.1`, major, meetsMinimum: major >= 17 });

  function gradleRepo(version: string, cached: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'stratigraph-gradle-home-'));
    const dir = repo({
      'build.gradle': "plugins { id 'java' }",
      gradlew: '#!/bin/sh',
      'gradle/wrapper/gradle-wrapper.properties': `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-all.zip\n`,
    });
    if (cached) {
      const dist = join(home, 'wrapper', 'dists', `gradle-${version}-all`, 'abc123');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, `gradle-${version}-all.zip.ok`), '');
    }
    return { dir, home };
  }

  it('runs the cached wrapper offline with an init script, on a JDK that Gradle version supports', () => {
    const { dir, home } = gradleRepo('6.0.1', true);
    const jar = join(dir, 'spring-core.jar');
    writeFileSync(jar, '');
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const result = resolveClasspath({
      repoPath: dir,
      javaHome: '/jdk17',
      env: { GRADLE_USER_HOME: home },
      runtimes: [jdk(8), jdk(11), jdk(17)],
      run: (command, args, _cwd, env) => {
        calls.push({ command, args, env });
        writeFileSync(args.find((arg) => arg.startsWith('-Dstratigraph.classpathOut='))!.split('=')[1]!, `${jar}\n${jar}\n/not/there.jar\n`);
        return 0;
      },
    });
    expect(calls[0]?.command).toBe(join(dir, 'gradlew'));
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--offline', '--no-daemon', '-q', 'stratigraphClasspath']));
    expect(calls[0]?.args[calls[0]!.args.indexOf('-I') + 1]).toMatch(/\.gradle$/);
    // Gradle 6.0 runs on JDKs up to 13: 11 is the newest that qualifies.
    expect(calls[0]?.env['JAVA_HOME']).toBe('/jdk11');
    expect(result).toMatchObject({ jars: 1 });
    expect(result.statement).toBe('typed: 1 dependency jar(s) resolved offline from the local Gradle cache (Gradle 6.0.1 on JDK 11)');
  });

  it('never runs a wrapper whose Gradle distribution is not cached: that would download it', () => {
    const { dir, home } = gradleRepo('8.10', false);
    let ran = false;
    const result = resolveClasspath({
      repoPath: dir,
      javaHome: '/jdk17',
      env: { GRADLE_USER_HOME: home, PATH: '/nowhere' },
      runtimes: [jdk(17)],
      run: () => {
        ran = true;
        return 0;
      },
    });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ file: null });
    expect(result.statement).toBe('source-only: the Gradle 8.10 distribution is not in the local Gradle cache, and no gradle is installed');
  });

  it('says so when no installed JDK can run that Gradle version', () => {
    const { dir, home } = gradleRepo('6.0.1', true);
    const result = resolveClasspath({ repoPath: dir, javaHome: '/jdk17', env: { GRADLE_USER_HOME: home }, runtimes: [jdk(17), jdk(21)], run: () => 0 });
    expect(result.statement).toBe('source-only: Gradle 6.0.1 needs a JDK from 8 to 13, and none is installed');
  });

  it('falls back to source-only when offline resolution fails', () => {
    const { dir, home } = gradleRepo('8.10', true);
    const result = resolveClasspath({ repoPath: dir, javaHome: '/jdk17', env: { GRADLE_USER_HOME: home }, runtimes: [jdk(17)], run: () => 1 });
    expect(result.statement).toBe('source-only: the dependencies are not all in the local Gradle cache (offline resolution failed)');
  });
});
