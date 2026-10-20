import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NETWORK_FAILURE, categoriseBuildFailure, categoriseTest } from '../src/upgrade/categories.js';
import {
  addCompilerParametersArg,
  addGradleDependency,
  dropManagedPins,
  parseGradleLog,
  readBootManaged,
  raiseJavaLevel,
  rewriteRemovedDsl,
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

describe('jakarta APIs missing after the recipe', () => {
  it('names the stale BOM or pin as the likely cause (jhipster-sample-app-gradle 7.9)', () => {
    for (const message of ['package jakarta.servlet.http does not exist', 'package org.thymeleaf.spring6 does not exist']) {
      const failure = { kind: 'compile' as const, message, file: 'src/main/java/A.java', line: 3, symbol: null, excerpt: [] };
      expect(categoriseBuildFailure(failure).id).toBe('jakarta-api-missing');
    }
  });
});

describe('the Boot BOM, read from the local cache', () => {
  function cacheWith(bootVersion: string, xml: string): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), 'stratigraph-gradle-home-'));
    const dir = join(home, 'caches', 'modules-2', 'files-2.1', 'org.springframework.boot', 'spring-boot-dependencies', bootVersion, 'abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `spring-boot-dependencies-${bootVersion}.pom`), xml);
    return { GRADLE_USER_HOME: home, HOME: join(home, 'no-home') };
  }
  const BOM = `<project><dependencyManagement><dependencies>
    <dependency><groupId>io.rest-assured</groupId><artifactId>rest-assured-bom</artifactId><version>5.5.7</version><type>pom</type><scope>import</scope></dependency>
    <dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId><version>11.7.2</version></dependency>
  </dependencies></dependencyManagement></project>`;

  it('reads managed artifacts, and groups whose BOM it imports', () => {
    const managed = readBootManaged('3.5.16', cacheWith('3.5.16', BOM))!;
    expect([...managed.groups]).toEqual(['io.rest-assured']);
    expect([...managed.artifacts]).toEqual(['org.flywaydb:flyway-core']);
    expect(readBootManaged('3.4.0', cacheWith('3.5.16', BOM))).toBeNull();
  });

  it('drops only the pins the BOM manages and the failure names (realworld-example-app)', () => {
    const managed = readBootManaged('3.5.16', cacheWith('3.5.16', BOM))!;
    const script = "dependencies {\n    implementation 'joda-time:joda-time:2.10.13'\n    testImplementation 'io.rest-assured:rest-assured:5.1.1'\n    testImplementation 'io.rest-assured:spring-mock-mvc:5.1.1'\n    implementation 'org.flywaydb:flyway-core:9.0.0'\n}\n";
    const failure = "java.lang.NoSuchMethodError: 'io.restassured.config.ParamConfig$UpdateStrategy io.restassured.config.ParamConfig.pathParamsUpdateStrategy()'";
    const { script: next, dropped } = dropManagedPins(script, managed, failure);
    expect(dropped).toEqual(['io.rest-assured:rest-assured', 'io.rest-assured:spring-mock-mvc']);
    expect(next).toContain("testImplementation 'io.rest-assured:rest-assured'\n");
    expect(next).toContain("'joda-time:joda-time:2.10.13'");
    expect(next).toContain("'org.flywaydb:flyway-core:9.0.0'");
  });
});

describe('static checks', () => {
  it('reads a Checkstyle failure as a static check, not a broken project', () => {
    const log = "> Task :checkstyleMain FAILED\n\n* What went wrong:\nExecution failed for task ':checkstyleMain'.\n> Checkstyle rule violations were found. See the report at: file:///r/build/reports/checkstyle/main.html\n\nBUILD FAILED in 9s";
    const [failure] = parseGradleLog(log, '/r').failures;
    expect(failure?.message).toMatch(/^:checkstyleMain: /);
    expect(categoriseBuildFailure(failure!).id).toBe('static-check');
  });
});

describe('build-script errors', () => {
  const where = (file: string, line: number, message: string) =>
    `FAILURE: Build failed with an exception.\n\n* Where:\n${file} line: ${line}\n\n* What went wrong:\n${message}\n\n* Try:\n> Run with --stacktrace.\n\nBUILD FAILED in 2s`;

  it('reads where evaluation stopped, and a removed method as a script error, not a missing artifact', () => {
    const repo = project({ 'build.gradle': 'apply from: "gradle/war.gradle"\n'.padEnd(10) + '\n'.repeat(400), 'gradle/war.gradle': '' });
    const log = where(`Build file '${repo}/build.gradle'`, 370, "A problem occurred evaluating root project 'app'.\n> Could not find method compile() for arguments [{group=io.springfox, name=springfox-swagger-ui, version=2.9.2}] on object of type org.gradle.api.internal.artifacts.dsl.dependencies.DefaultDependencyHandler.");
    const parsed = parseGradleLog(log, repo);
    expect(parsed.failures[0]).toMatchObject({ kind: 'pom', file: 'build.gradle', line: 370 });
    expect(parsed.evaluatedTo).toBe(370);
    expect(categoriseBuildFailure(parsed.failures[0]!).id).toBe('gradle-removed-dsl');
  });

  it('places an error in an applied script at the line that applies it', () => {
    const repo = project({ 'build.gradle': "plugins { id 'java' }\n\napply from: 'gradle/war.gradle'\n", 'gradle/war.gradle': '' });
    const log = where(`Script '${repo}/gradle/war.gradle'`, 4, "A problem occurred evaluating script.\n> Could not set unknown property 'mainClassName' for task ':bootWar' of type org.springframework.boot.gradle.tasks.bundling.BootWar.");
    const parsed = parseGradleLog(log, repo);
    expect(parsed.failures[0]).toMatchObject({ file: 'gradle/war.gradle', line: 4 });
    expect(parsed.evaluatedTo).toBeGreaterThan(3);
    expect(parsed.evaluatedTo).toBeLessThan(4);
    expect(categoriseBuildFailure(parsed.failures[0]!).id).toBe('gradle-removed-dsl');
  });

  it('renames removed DSL, and leaves look-alikes alone', () => {
    const script = [
      'dependencies {',
      '    compile group: "io.springfox", name: "springfox-swagger-ui", version: "2.9.2"',
      "    testCompile 'junit:junit:4.13'",
      '    runtime("org.postgresql:postgresql")',
      "    compileOnly 'org.projectlombok:lombok'",
      '}',
      "bootWar { mainClassName = 'com.example.App' }",
      'jar {',
      "    classifier = 'plain'",
      '}',
      'def compileFlags = []',
    ].join('\n');
    const result = rewriteRemovedDsl(script)!;
    expect(result.script).toContain('    implementation group: "io.springfox"');
    expect(result.script).toContain("    testImplementation 'junit:junit:4.13'");
    expect(result.script).toContain('    runtimeOnly("org.postgresql:postgresql")');
    expect(result.script).toContain("    compileOnly 'org.projectlombok:lombok'");
    expect(result.script).toContain("mainClass = 'com.example.App'");
    expect(result.script).toContain("    archiveClassifier = 'plain'");
    expect(result.script).toContain('def compileFlags = []');
    expect(rewriteRemovedDsl("dependencies { implementation 'a:b' }")).toBeNull();
  });
});

describe('the Java level', () => {
  it('raises every level a script writes below the target, Ant javac included', () => {
    const script = [
      'sourceCompatibility = 1.8',
      "targetCompatibility = '11'",
      'java { sourceCompatibility = JavaVersion.VERSION_1_8 }',
      'ant.javac(destdir: classesDir, source: 1.8, target: 1.8, debug: true)',
      'sourceCompatibility = 21',
    ].join('\n');
    const result = raiseJavaLevel(script, 17)!;
    expect(result.raised).toBe(5);
    expect(result.script).toBe([
      'sourceCompatibility = 17',
      "targetCompatibility = '17'",
      'java { sourceCompatibility = JavaVersion.VERSION_17 }',
      'ant.javac(destdir: classesDir, source: 17, target: 17, debug: true)',
      'sourceCompatibility = 21',
    ].join('\n'));
    expect(raiseJavaLevel('sourceCompatibility = 17', 17)).toBeNull();
  });

  it('reads "not supported in -source 8" as a Java level the build still declares', () => {
    const failure = { kind: 'compile' as const, message: 'text blocks are not supported in -source 8', file: 'src/main/java/A.java', line: 3, symbol: null, excerpt: [] };
    expect(categoriseBuildFailure(failure).id).toBe('java-level-too-low');
  });
});

describe('Liquibase', () => {
  it('reads a Liquibase configuration that no longer compiles as a Liquibase API change', () => {
    for (const [message, symbol] of [['cannot find symbol', 'method getLabels()'], ['incompatible types: List<String> cannot be converted to String', null]] as const) {
      const failure = { kind: 'compile' as const, message, file: 'src/main/java/a/config/LiquibaseConfiguration.java', line: 40, symbol, excerpt: [] };
      expect(categoriseBuildFailure(failure).id).toBe('liquibase-api');
    }
  });
});
