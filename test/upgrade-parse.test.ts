import { describe, expect, it } from 'vitest';

import { parseBuildLog } from '../src/upgrade/build-log.js';
import { categoriseBuildFailure, categoriseTest, categoriseText } from '../src/upgrade/categories.js';
import { atParity, diffTests, parseReport, type TestResult } from '../src/upgrade/test-reports.js';

/** Excerpts from the gap map's post-recipe logs (bench/upgrade-gap), paths rebased on /repo. */
const LOGS = {
  jwtDemo: `[INFO] -------------------------------------------------------------
[ERROR] COMPILATION ERROR :
[INFO] -------------------------------------------------------------
[ERROR] /repo/src/main/java/org/zerhusen/config/WebSecurityConfig.java:[10,72] cannot find symbol
  symbol:   class WebSecurityConfigurerAdapter
  location: package org.springframework.security.config.annotation.web.configuration
[ERROR] /repo/src/main/java/org/zerhusen/config/WebSecurityConfig.java:[54,4] method does not override or implement a method from a supertype
[INFO] 2 errors
[INFO] BUILD FAILURE
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.1:compile (default-compile) on project jwtdemo: Compilation failure: Compilation failure:
[ERROR] /repo/src/main/java/org/zerhusen/config/WebSecurityConfig.java:[10,72] cannot find symbol
[ERROR]   symbol:   class WebSecurityConfigurerAdapter
[ERROR]   location: package org.springframework.security.config.annotation.web.configuration
`,
  jhipsterPom: `[ERROR] [ERROR] Some problems were encountered while processing the POMs:
[ERROR] 'dependencies.dependency.version' for org.springframework.boot:spring-boot-loader-tools:jar is missing. @ line 94, column 21
 @
[ERROR] The build could not read 1 project -> [Help 1]
[ERROR]
[ERROR]   The project io.github.jhipster.sample:jhipster-sample-application:0.0.1-SNAPSHOT (/repo/pom.xml) has 1 error
[ERROR]     'dependencies.dependency.version' for org.springframework.boot:spring-boot-loader-tools:jar is missing. @ line 94, column 21
`,
  blogBom: `[ERROR] [ERROR] Some problems were encountered while processing the POMs:
[ERROR] Non-resolvable import POM: The following artifacts could not be resolved: org.seleniumhq.selenium:selenium-bom:pom:4.3.0 (absent): org.seleniumhq.selenium:selenium-bom:pom:4.3.0 was not found in https://repo.maven.apache.org/maven2 @ line 267, column 25
`,
  kafdrop: `[ERROR] COMPILATION ERROR :
[ERROR] error: exporting a package from system module jdk.management.agent is not allowed with --release
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.16.0:compile (default-compile) on project kafdrop: Compilation failure
[ERROR] error: exporting a package from system module jdk.management.agent is not allowed with --release
`,
  petclinicFormat: `[ERROR] Failed to execute goal io.spring.javaformat:spring-javaformat-maven-plugin:0.0.47:validate (default) on project spring-petclinic: Formatting violations found in the following files:
[ERROR]  * /repo/src/test/java/org/springframework/samples/petclinic/system/CrashControllerIntegrationTests.java
[ERROR] Run \`spring-javaformat:apply\` to fix.
[ERROR] -> [Help 1]
`,
  petclinicRest: `[ERROR] /repo/target/generated-sources/openapi/src/main/java/org/springframework/samples/petclinic/rest/dto/SpecialtyDto.java:[9,24] package javax.validation does not exist
`,
  mallTiny: `[ERROR] /repo/src/main/java/com/macro/mall/tiny/common/config/BaseSwaggerConfig.java:[11,40] package springfox.documentation.builders does not exist
`,
  webGoat: `[ERROR] /repo/src/main/java/org/owasp/webgoat/webwolf/WebWolf.java:[26,51] package org.springframework.boot.actuate.trace.http does not exist
`,
};

describe('parseBuildLog', () => {
  it('reads compiler errors with file, line and the missing symbol, once each', () => {
    const log = parseBuildLog(LOGS.jwtDemo, '/repo');
    expect(log.success).toBe(false);
    expect(log.failures).toEqual([
      expect.objectContaining({
        kind: 'compile',
        file: 'src/main/java/org/zerhusen/config/WebSecurityConfig.java',
        line: 10,
        message: 'cannot find symbol',
        symbol: 'class WebSecurityConfigurerAdapter',
      }),
      expect.objectContaining({ kind: 'compile', line: 54, message: 'method does not override or implement a method from a supertype' }),
    ]);
  });

  it('reads POM model errors with their line', () => {
    const log = parseBuildLog(LOGS.jhipsterPom, '/repo');
    expect(log.failures).toEqual([
      expect.objectContaining({
        kind: 'pom',
        file: 'pom.xml',
        line: 94,
        message: "'dependencies.dependency.version' for org.springframework.boot:spring-boot-loader-tools:jar is missing.",
      }),
    ]);
  });

  it('reads an unresolvable import as a dependency failure', () => {
    const log = parseBuildLog(LOGS.blogBom, '/repo');
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toMatchObject({ kind: 'dependency', file: 'pom.xml', line: 267 });
  });

  it('reads compiler errors that name no file', () => {
    const log = parseBuildLog(LOGS.kafdrop, '/repo');
    expect(log.failures).toEqual([
      expect.objectContaining({
        kind: 'compile',
        file: null,
        message: 'exporting a package from system module jdk.management.agent is not allowed with --release',
      }),
    ]);
  });

  it('reads a plugin failure with the lines that explain it', () => {
    const log = parseBuildLog(LOGS.petclinicFormat, '/repo');
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]?.kind).toBe('plugin');
    expect(log.failures[0]?.message).toMatch(/^io\.spring\.javaformat:spring-javaformat-maven-plugin:validate: Formatting violations/);
    expect(log.failures[0]?.excerpt.join('\n')).toContain('CrashControllerIntegrationTests.java');
  });

  it('knows a successful build', () => {
    expect(parseBuildLog('[INFO] BUILD SUCCESS\n', '/repo')).toEqual({ success: true, failures: [] });
  });
});

describe('categories from the gap map', () => {
  const first = (log: string) => categoriseBuildFailure(parseBuildLog(log, '/repo').failures[0]!);

  it.each([
    ['jwtDemo', 'spring-security-config', 'judgment'],
    ['jhipsterPom', 'pom-missing-version', 'mechanical'],
    ['blogBom', 'unresolvable-bom', 'judgment'],
    ['kafdrop', 'compiler-release-conflict', 'mechanical'],
    ['petclinicFormat', 'formatting-check', 'mechanical'],
    ['petclinicRest', 'openapi-generator-javax', 'mechanical'],
    ['mallTiny', 'springfox', 'judgment'],
    ['webGoat', 'removed-boot-api', 'mechanical'],
  ] as const)('%s → %s (%s)', (log, id, disposition) => {
    expect(first(LOGS[log])).toMatchObject({ id, disposition });
  });

  it('hands off two filter chains matching every request as a decision, with options', () => {
    const category = categoriseTest({
      id: 'org.springframework.samples.petclinic.rest.OwnerRestControllerTests#testGetOwnerSuccess',
      outcome: 'error',
      message:
        'java.lang.IllegalStateException: Failed to load ApplicationContext; UnreachableFilterChainException: A filter chain that matches any request [DefaultSecurityFilterChain ...] has already been configured',
      report: 'target/surefire-reports/TEST-x.xml',
    });
    expect(category.disposition).toBe('decision');
    expect(category.options?.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a changed HTTP status as a contract decision', () => {
    expect(categoriseText('java.lang.AssertionError: Status expected:<200> but was:<400>').id).toBe('http-contract-change');
  });

  it('reads Hibernate, Jackson 3, Flyway and javax leftovers', () => {
    expect(categoriseText('org.hibernate.StaleObjectStateException: Row was already updated').id).toBe('hibernate-6');
    expect(categoriseText('cannot find symbol class tools.jackson.databind.ext.jdk8.Jdk8Module').id).toBe('jackson-3');
    expect(categoriseText('FlywayException: Unsupported Database: HSQL Database Engine 2.7').id).toBe('flyway-database-module');
    expect(categoriseText('ClassNotFoundException: javax.xml.bind.DatatypeConverter').id).toBe('javax-leftover');
    expect(categoriseText("Name for argument of type [java.lang.String] not specified, and parameter name information not available via reflection. Ensure that the compiler uses the '-parameters' flag.").id).toBe('compiler-parameters');
  });

  it('says it does not know rather than guessing', () => {
    expect(categoriseText('something nobody has seen before').id).toBe('uncategorised');
  });
});

describe('test reports', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="shop.OrderTest" tests="4">
  <testcase name="creates" classname="shop.OrderTest" time="0.01"/>
  <testcase name="rejects" classname="shop.OrderTest" time="0.01">
    <failure message="expected: &lt;400&gt; but was: &lt;200&gt;" type="org.opentest4j.AssertionFailedError">stack</failure>
  </testcase>
  <testcase name="boots" classname="shop.OrderTest"><error type="java.lang.IllegalStateException"><![CDATA[Failed to load ApplicationContext
  at x]]></error></testcase>
  <testcase name="later" classname="shop.OrderTest"><skipped/></testcase>
</testsuite>`;

  it('reads every test case with its outcome and message', () => {
    expect(parseReport(xml, 'target/surefire-reports/TEST-shop.OrderTest.xml')).toEqual([
      { id: 'shop.OrderTest#creates', outcome: 'passed', message: null, report: 'target/surefire-reports/TEST-shop.OrderTest.xml' },
      {
        id: 'shop.OrderTest#rejects',
        outcome: 'failed',
        message: 'org.opentest4j.AssertionFailedError: expected: <400> but was: <200>',
        report: 'target/surefire-reports/TEST-shop.OrderTest.xml',
      },
      {
        id: 'shop.OrderTest#boots',
        outcome: 'error',
        message: 'java.lang.IllegalStateException: Failed to load ApplicationContext',
        report: 'target/surefire-reports/TEST-shop.OrderTest.xml',
      },
      { id: 'shop.OrderTest#later', outcome: 'skipped', message: null, report: 'target/surefire-reports/TEST-shop.OrderTest.xml' },
    ]);
  });

  it('compares against the baseline, so a test red before the upgrade is not the upgrade\'s', () => {
    const t = (id: string, outcome: TestResult['outcome']): [string, TestResult] => [
      id,
      { id, outcome, message: null, report: 'r' },
    ];
    const baseline = new Map([t('a', 'passed'), t('b', 'passed'), t('c', 'error'), t('d', 'failed'), t('e', 'passed')]);
    const now = new Map([t('a', 'passed'), t('b', 'failed'), t('c', 'error'), t('d', 'passed'), t('f', 'passed')]);
    const diff = diffTests(baseline, now);
    expect(diff.regressed.map((r) => r.id)).toEqual(['b']);
    expect(diff.stillFailing.map((r) => r.id)).toEqual(['c']);
    expect(diff.fixed.map((r) => r.id)).toEqual(['d']);
    expect(diff.missing).toEqual(['e']);
    expect(diff.added.map((r) => r.id)).toEqual(['f']);
    expect(atParity(diff)).toBe(false);
    expect(atParity(diffTests(baseline, baseline))).toBe(true);
  });
});
