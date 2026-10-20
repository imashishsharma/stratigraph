import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NETWORK_FAILURE, categoriseBuildFailure, categoriseTest } from '../src/upgrade/categories.js';
import {
  addCompilerParametersArg,
  addGradleDependency,
  parseGradleLog,
  readGradleFacts,
  rewriteInitScript,
  setWrapperVersion,
} from '../src/upgrade/gradle.js';

function project(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'stratigraph-gradle-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

const WRAPPER = (version: string) =>
  `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-all.zip\nzipStoreBase=GRADLE_USER_HOME\n`;

describe('Gradle facts', () => {
  it('reads the Boot version from the plugins block', () => {
    const repo = project({
      'build.gradle': "plugins {\n    id 'java'\n    id 'org.springframework.boot' version '2.7.18'\n    id 'com.diffplug.spotless' version '6.25.0'\n}\njava {\n    sourceCompatibility = '11'\n}\n",
      'gradle/wrapper/gradle-wrapper.properties': WRAPPER('7.6.4'),
    });
    expect(readGradleFacts(repo)).toMatchObject({
      buildFile: 'build.gradle',
      kotlinDsl: false,
      bootVersion: '2.7.18',
      bootVersionFrom: 'build.gradle plugins block',
      javaVersion: '11',
      gradleVersion: '7.6.4',
    });
    expect(readGradleFacts(repo)?.plugins.has('com.diffplug.spotless')).toBe(true);
  });

  it('reads JHipster-style versions from gradle.properties, through a plugins-block variable', () => {
    const repo = project({
      'build.gradle': 'plugins {\n    id "org.springframework.boot"\n}\nsourceCompatibility = 1.8\n',
      'gradle.properties': 'spring_boot_version=2.2.5.RELEASE\n',
      'gradle/wrapper/gradle-wrapper.properties': WRAPPER('6.0.1'),
    });
    expect(readGradleFacts(repo)).toMatchObject({
      bootVersion: '2.2.5.RELEASE',
      bootVersionFrom: 'gradle.properties spring_boot_version',
      javaVersion: '1.8',
      gradleVersion: '6.0.1',
    });
  });

  it('reads the Kotlin DSL and a toolchain', () => {
    const repo = project({
      'build.gradle.kts': 'plugins {\n    id("org.springframework.boot") version "3.3.4"\n}\njava {\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(17)\n    }\n}\n',
    });
    expect(readGradleFacts(repo)).toMatchObject({ kotlinDsl: true, bootVersion: '3.3.4', javaVersion: '17', gradleVersion: null });
  });

  it('says unknown rather than guess', () => {
    const repo = project({ 'build.gradle': "plugins { id 'org.springframework.boot' version bootVersion }\n" });
    expect(readGradleFacts(repo)?.bootVersion).toBeNull();
  });
});

describe('Gradle edits', () => {
  it('moves the wrapper and drops a checksum pinned to the old distribution', () => {
    const next = setWrapperVersion(`${WRAPPER('6.0.1')}distributionSha256Sum=abc\n`, '8.14.3')!;
    expect(next).toContain('gradle-8.14.3-all.zip');
    expect(next).not.toContain('distributionSha256Sum');
  });

  it('adds -parameters to JavaCompile, in either DSL, once', () => {
    expect(addCompilerParametersArg("plugins { id 'java' }\n", false)).toContain("options.compilerArgs << '-parameters'");
    expect(addCompilerParametersArg('plugins { java }\n', true)).toContain('options.compilerArgs.add("-parameters")');
    expect(addCompilerParametersArg("options.compilerArgs << '-parameters'\n", false)).toBeNull();
  });

  it('adds a dependency to the top-level block, not the buildscript one', () => {
    const script = "buildscript {\n    dependencies {\n        classpath 'x:y:1'\n    }\n}\ndependencies {\n    implementation 'a:b'\n}\n";
    const next = addGradleDependency(script, 'org.flywaydb:flyway-database-hsqldb', false)!;
    expect(next).toContain("    implementation 'a:b'\n    implementation 'org.flywaydb:flyway-database-hsqldb'\n}");
    expect(next.indexOf('flyway')).toBeGreaterThan(next.indexOf("classpath 'x:y:1'"));
  });

  it('writes an init script that applies the rewrite plugin without touching the build', () => {
    const script = rewriteInitScript('7.39.0', 'org.openrewrite.recipe:rewrite-spring:6.37.1', 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5', ['gradle/wrapper/**']);
    expect(script).toContain('classpath("org.openrewrite:plugin:7.39.0")');
    expect(script).toContain('activeRecipe("org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5")');
    expect(script).toContain('exclusion("gradle/wrapper/**")');
  });
});

describe('parseGradleLog', () => {
  it('reads javac errors with their symbol, and drops the task summary that repeats them', () => {
    const log = `> Task :compileJava FAILED
/repo/src/main/java/com/a/Config.java:10: error: cannot find symbol
import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;
                                                                       ^
  symbol:   class WebSecurityConfigurerAdapter
  location: package org.springframework.security.config.annotation.web.configuration
/repo/src/main/java/com/a/Config.java:22: error: method does not override or implement a method from a supertype
    @Override
    ^
2 errors

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':compileJava'.
> Compilation failed; see the compiler error output for details.

* Try:
> Run with --stacktrace option to get the stack trace.

BUILD FAILED in 3s`;
    const parsed = parseGradleLog(log, '/repo');
    expect(parsed.success).toBe(false);
    expect(parsed.goals).toBe(1);
    expect(parsed.failures).toEqual([
      expect.objectContaining({ kind: 'compile', file: 'src/main/java/com/a/Config.java', line: 10, symbol: 'class WebSecurityConfigurerAdapter' }),
      expect.objectContaining({ kind: 'compile', line: 22, message: 'method does not override or implement a method from a supertype' }),
    ]);
    expect(categoriseBuildFailure(parsed.failures[0]!).id).toBe('spring-security-config');
  });

  it('counts a build that failed only on failing tests as built: the reports say which', () => {
    const log = `> Task :compileJava
> Task :test FAILED

AppTest > contextLoads() FAILED
    java.lang.IllegalStateException at DefaultCacheAwareContextLoaderDelegate.java:180

3 tests completed, 1 failed

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':test'.
> There were failing tests. See the report at: file:///repo/build/reports/tests/test/index.html

BUILD FAILED in 9s`;
    expect(parseGradleLog(log, '/repo')).toEqual({ success: true, failures: [], goals: 2 });
  });

  it('reads a Boot plugin that needs a newer Gradle as a build-script failure', () => {
    const log = `* What went wrong:
An exception occurred applying plugin request [id: 'org.springframework.boot', version: '3.5.6']
> Failed to apply plugin 'org.springframework.boot'.
   > Spring Boot plugin requires Gradle 7.6.4 or later. The current version is Gradle 6.0.1

* Try:
> Run with --stacktrace.

BUILD FAILED in 1s`;
    const [failure] = parseGradleLog(log, '/repo').failures;
    expect(failure).toMatchObject({ kind: 'pom', file: 'build.gradle' });
    expect(categoriseBuildFailure(failure!).id).toBe('gradle-too-old');
  });

  it('reads Gradle refusing the JDK as a build-script failure', () => {
    const log = `FAILURE: Build failed with an exception.

* What went wrong:
Could not open cp_init generic class cache for initialization script '/tmp/init.gradle' (/home/u/.gradle/caches/6.0.1/scripts/abc).
> BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 61

BUILD FAILED in 0s`;
    const [failure] = parseGradleLog(log, '/repo').failures;
    expect(failure?.kind).toBe('pom');
    expect(categoriseBuildFailure(failure!).id).toBe('gradle-too-old');
  });

  it('reads an unresolvable dependency, and a Kotlin compile error', () => {
    const log = `e: file:///repo/src/main/kotlin/a/App.kt:7:21 Unresolved reference: Docket
* What went wrong:
Execution failed for task ':compileKotlin'.
> Could not resolve all files for configuration ':compileClasspath'.
   > Could not find io.springfox:springfox-boot-starter:3.0.0.

BUILD FAILED in 4s`;
    const parsed = parseGradleLog(log, '/repo');
    expect(parsed.failures.map((failure) => failure.kind)).toEqual(['compile', 'dependency']);
    expect(parsed.failures[0]).toMatchObject({ file: 'src/main/kotlin/a/App.kt', line: 7 });
  });

  it('reads the wrapper failing to download Gradle as a network failure, not a broken project', () => {
    const log = `Downloading https://services.gradle.org/distributions/gradle-7.4-bin.zip

Exception in thread "main" java.io.IOException: Downloading from https://services.gradle.org/distributions/gradle-7.4-bin.zip failed: timeout
\tat org.gradle.wrapper.Download.downloadInternal(Download.java:110)
Caused by: java.net.SocketTimeoutException: connect timed out
\tat java.base/java.net.PlainSocketImpl.socketConnect(Native Method)
\tat org.gradle.wrapper.Download.downloadInternal(Download.java:87)
\t... 7 more`;
    const parsed = parseGradleLog(log, '/repo');
    expect(parsed.success).toBe(false);
    expect(NETWORK_FAILURE.test(log)).toBe(true);
    expect(categoriseBuildFailure(parsed.failures[0]!).id).toBe('network');
  });

  it('reads the recipe failing to fetch a Gradle distribution as a network failure', () => {
    const log = "* What went wrong:\nExecution failed for task ':rewriteRun'.\n> java.lang.IllegalStateException: Failed to download https://downloads.gradle.org/distributions/gradle-7.6.6-bin.zip to artifact cache\n\n* Try:\n> Run with --stacktrace.\n\nBUILD FAILED in 1m 21s";
    expect(categoriseBuildFailure(parseGradleLog(log, '/repo').failures[0]!).id).toBe('network');
  });

  it('reads a supertype that changed its abstract methods as a judgment, not unrecognised', () => {
    const log = `/repo/src/main/java/a/Handler.java:25: error: Handler is not abstract and does not override abstract method handleException(DataFetcherExceptionHandlerParameters) in DataFetcherExceptionHandler
public class Handler implements DataFetcherExceptionHandler {
       ^
BUILD FAILED in 3s`;
    const [failure] = parseGradleLog(log, '/repo').failures;
    expect(categoriseBuildFailure(failure!)).toMatchObject({ id: 'supertype-api-change', disposition: 'judgment' });
  });

  it('reads a NoSuchMethodError in a test as mismatched library versions', () => {
    const test = { id: 'a.ApiTest#works()', status: 'error' as const, message: "java.lang.NoSuchMethodError: 'io.restassured.config.ParamConfig$UpdateStrategy io.restassured.config.ParamConfig.pathParamsUpdateStrategy()'", cause: null };
    expect(categoriseTest(test as never).id).toBe('third-party-library');
  });
});
