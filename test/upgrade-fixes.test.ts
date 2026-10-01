import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { categoriseText } from '../src/upgrade/categories.js';
import { KNOWN_FIXES, older, type Classified, type FixContext } from '../src/upgrade/known-fixes.js';
import { addDependency, addDependencyVersion, javaMajor, parsePom } from '../src/upgrade/pom.js';

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.8</version>
    </parent>
    <artifactId>demo</artifactId>
    <properties>
        <java.version>17</java.version>
        <selenium.version>4.3.0</selenium.version>
        <maven-compiler-plugin.version>3.8.0</maven-compiler-plugin.version>
    </properties>
    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.example</groupId>
                <artifactId>managed</artifactId>
                <version>1.0</version>
            </dependency>
        </dependencies>
    </dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-loader-tools</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <configuration>
                    <compilerArgs>
                        <arg>--add-exports</arg>
                        <arg>jdk.management.agent/jdk.internal.agent=ALL-UNNAMED</arg>
                    </compilerArgs>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;

function project(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'stratigraph-fix-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

function failing(...texts: string[]): Classified[] {
  return texts.map((text) => ({ category: categoriseText(text), text }));
}

async function run(id: string, repo: string, failures: Classified[], maven: FixContext['maven'] = async () => 0) {
  const fix = KNOWN_FIXES.find((candidate) => candidate.id === id);
  if (!fix) throw new Error(`no fix ${id}`);
  return fix.attempt({ repoPath: repo, failures, maven });
}

const read = (repo: string, path = 'pom.xml') => readFileSync(join(repo, path), 'utf8');

describe('POM facts', () => {
  it('reads the Boot version from the parent, a BOM import, or a property', () => {
    expect(parsePom(POM)).toMatchObject({ bootVersion: '4.0.8', bootVersionFrom: 'parent spring-boot-starter-parent', javaVersion: '17' });
    const bom = `<project><properties><boot.v>2.7.5</boot.v></properties><dependencyManagement><dependencies><dependency>
      <groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>\${boot.v}</version>
      <type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement></project>`;
    expect(parsePom(bom).bootVersion).toBe('2.7.5');
    expect(parsePom('<project><properties><spring-boot.version>3.1.0</spring-boot.version></properties></project>').bootVersion).toBe('3.1.0');
    expect(parsePom('<project></project>').bootVersion).toBeNull();
  });

  it('reads Java levels', () => {
    expect([javaMajor('1.8'), javaMajor('11'), javaMajor('17'), javaMajor(null)]).toEqual([8, 11, 17, null]);
  });

  it('adds a dependency to the project list, not to dependencyManagement', () => {
    const next = addDependency(POM, 'org.flywaydb', 'flyway-database-hsqldb') as string;
    const management = /<dependencyManagement>[\s\S]*<\/dependencyManagement>/.exec(next)?.[0] ?? '';
    expect(management).not.toContain('flyway');
    expect(next).toMatch(/<artifactId>spring-boot-loader-tools<\/artifactId>\s*<\/dependency>\s*<dependency>\s*<groupId>org\.flywaydb<\/groupId>/);
    expect(addDependency(next, 'org.flywaydb', 'flyway-database-hsqldb')).toBeNull();
  });

  it('versions only a dependency that has no version', () => {
    expect(addDependencyVersion(POM, 'org.example', 'managed', '2')).toBeNull();
    expect(addDependencyVersion(POM, 'org.springframework.boot', 'spring-boot-loader-tools', '4.0.8')).toContain(
      '<artifactId>spring-boot-loader-tools</artifactId>\n            <version>4.0.8</version>',
    );
  });

  it('compares versions numerically', () => {
    expect(older('3.8.0', '3.6.2')).toBe(false);
    expect(older('3.6.1', '3.6.2')).toBe(true);
    expect(older('6.0.1', '6.3.0')).toBe(true);
  });
});

describe('known fixes (from the gap map)', () => {
  it('versions an artifact the Boot 4 BOM stopped managing (jhipster)', async () => {
    const repo = project({ 'pom.xml': POM });
    const result = await run(
      'boot-artifact-version',
      repo,
      failing("'dependencies.dependency.version' for org.springframework.boot:spring-boot-loader-tools:jar is missing."),
    );
    expect(result?.description).toBe('give spring-boot-loader-tools the Boot version explicitly (4.0.8)');
    expect(read(repo)).toContain('<artifactId>spring-boot-loader-tools</artifactId>\n            <version>4.0.8</version>');
  });

  it('drops a stale version override feeding a BOM that does not exist (blog-app)', async () => {
    const repo = project({ 'pom.xml': POM });
    const result = await run(
      'stale-bom-override',
      repo,
      failing('Non-resolvable import POM: The following artifacts could not be resolved: org.seleniumhq.selenium:selenium-bom:pom:4.3.0 (absent)'),
    );
    expect(result?.description).toMatch(/selenium\.version=4\.3\.0/);
    expect(read(repo)).not.toContain('selenium.version');
  });

  it('drops --add-exports of a package no source uses, and keeps one that is used (kafdrop)', async () => {
    const text = 'exporting a package from system module jdk.management.agent is not allowed with --release';
    const unused = project({ 'pom.xml': POM, 'src/main/java/A.java': 'class A {}' });
    expect((await run('drop-unused-add-exports', unused, failing(text)))?.description).toContain('jdk.internal.agent');
    expect(read(unused)).not.toContain('--add-exports');

    const used = project({ 'pom.xml': POM, 'src/main/java/A.java': 'import jdk.internal.agent.Agent; class A {}' });
    expect(await run('drop-unused-add-exports', used, failing(text))).toBeNull();
    expect(read(used)).toContain('--add-exports');
  });

  it('compiles with -parameters, lifting a compiler plugin too old to honour it (WebGoat)', async () => {
    const repo = project({ 'pom.xml': POM });
    const result = await run(
      'compiler-parameters',
      repo,
      failing("Name for argument of type [java.lang.String] not specified, and parameter name information not available via reflection. Ensure that the compiler uses the '-parameters' flag."),
    );
    expect(result).not.toBeNull();
    expect(read(repo)).toContain('<maven.compiler.parameters>true</maven.compiler.parameters>');
    expect(read(repo)).toContain('<maven-compiler-plugin.version>3.14.1</maven-compiler-plugin.version>');
  });

  it('adds the Flyway database module (WebGoat)', async () => {
    const repo = project({ 'pom.xml': POM });
    const result = await run('flyway-database-module', repo, failing('FlywayException: Unsupported Database: HSQL Database Engine 2.7'));
    expect(result?.description).toContain('flyway-database-hsqldb');
    expect(read(repo)).toContain('<artifactId>flyway-database-hsqldb</artifactId>');
  });

  it('follows classes Boot 4 moved, and adds the module that now carries them (jhipster)', async () => {
    const repo = project({
      'pom.xml': POM,
      'src/main/java/c/H2.java':
        'package c;\nimport org.springframework.boot.autoconfigure.h2.H2ConsoleProperties;\nimport org.springframework.boot.web.servlet.server.ConfigurableServletWebServerFactory;\nclass H2 {}\n',
      'src/main/java/c/Other.java': 'package c;\nclass Other {}\n',
    });
    const result = await run(
      'relocated-classes',
      repo,
      failing('src/main/java/c/H2.java:[2,1] package org.springframework.boot.autoconfigure.h2 does not exist', 'package org.springframework.boot.web.servlet.server does not exist'),
    );
    expect(result?.changed).toEqual(['pom.xml', 'src/main/java/c/H2.java']);
    expect(read(repo, 'src/main/java/c/H2.java')).toContain('import org.springframework.boot.h2console.autoconfigure.H2ConsoleProperties;');
    expect(read(repo, 'src/main/java/c/H2.java')).toContain('import org.springframework.boot.web.server.servlet.ConfigurableServletWebServerFactory;');
    expect(read(repo)).toContain('<artifactId>spring-boot-h2console</artifactId>');
  });

  it('makes a private @Bean method package-private (jhipster)', async () => {
    const repo = project({
      'pom.xml': POM,
      'src/test/java/c/Utils.java': 'class Utils {\n    @Bean\n    private MvcIntrospector mvcHandlerMappingIntrospector() { return null; }\n}\n',
    });
    const result = await run('private-bean-method', repo, failing("@Bean method 'mvcHandlerMappingIntrospector' must not be private or final; change the method's modifiers to continue"));
    expect(result?.changed).toEqual(['src/test/java/c/Utils.java']);
    expect(read(repo, 'src/test/java/c/Utils.java')).toContain('@Bean\n    MvcIntrospector mvcHandlerMappingIntrospector()');
  });

  it('runs the formatter the build uses (petclinic)', async () => {
    const pom = POM.replace('<artifactId>maven-compiler-plugin</artifactId>', '<artifactId>spring-javaformat-maven-plugin</artifactId>');
    const repo = project({ 'pom.xml': pom });
    const goals: string[][] = [];
    const result = await run(
      'apply-formatter',
      repo,
      failing('io.spring.javaformat:spring-javaformat-maven-plugin:validate: Formatting violations found in the following files:'),
      async (args) => {
        goals.push(args);
        return 0;
      },
    );
    expect(goals).toEqual([['io.spring.javaformat:spring-javaformat-maven-plugin:apply']]);
    expect(result?.description).toBe('apply spring-javaformat-maven-plugin to the recipe output');
  });

  it('does nothing when its failure is absent', async () => {
    const repo = project({ 'pom.xml': POM });
    for (const fix of KNOWN_FIXES) {
      expect(await fix.attempt({ repoPath: repo, failures: [], maven: async () => 0 })).toBeNull();
    }
    expect(read(repo)).toBe(POM);
  });
});

describe('Maven too old for the new plugins (kafdrop, found by the agent benchmark)', () => {
  const error =
    'org.apache.maven.plugins:maven-clean-plugin:clean: The plugin org.apache.maven.plugins:maven-clean-plugin:3.4.1 requires Maven version 3.6.3 -> [Help 1]';

  it('is mechanical', () => {
    expect(categoriseText(error)).toMatchObject({ id: 'maven-too-old', disposition: 'mechanical' });
  });

  it('points the wrapper at a current Maven, and leaves a machine without one alone', async () => {
    const wrapper =
      'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.6.1/apache-maven-3.6.1-bin.zip\nwrapperUrl=https://repo.maven.apache.org/maven2/io/takari/maven-wrapper/0.5.5/maven-wrapper-0.5.5.jar\n';
    const repo = project({ 'pom.xml': POM, '.mvn/wrapper/maven-wrapper.properties': wrapper });
    const result = await run('maven-wrapper-version', repo, failing(error));
    expect(result?.description).toBe('run the build on Maven 3.9.11 (the wrapper pinned 3.6.1)');
    expect(read(repo, '.mvn/wrapper/maven-wrapper.properties')).toContain('/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip');
    expect(read(repo, '.mvn/wrapper/maven-wrapper.properties')).toContain('maven-wrapper-0.5.5.jar');

    const bare = project({ 'pom.xml': POM });
    expect(await run('maven-wrapper-version', bare, failing(error))).toBeNull();
  });
});
