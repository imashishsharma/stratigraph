/**
 * Deterministic repairs for failures the gap map saw — ADR-0047.
 *
 * Each fix is exact: it makes one change a better recipe could have made, and
 * nothing that could alter behaviour. A fix that cannot be made exactly
 * returns null and the failure goes on to the AI fixer or the handoff. The
 * loop still rebuilds after every fix and keeps it only if the failures
 * shrank without any baseline-green test turning red.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { BuildFailure } from './build-log.js';
import type { Category } from './categories.js';
import {
  addDependency,
  addDependencyVersion,
  parsePom,
  removeProperty,
  renameArtifact,
  setProperty,
} from './pom.js';
import type { TestResult } from './test-reports.js';

export interface Classified {
  category: Category;
  build?: BuildFailure | undefined;
  test?: TestResult | undefined;
  /** Everything the failure said, for matching and for the report. */
  text: string;
}

export interface FixContext {
  repoPath: string;
  failures: Classified[];
  /** Runs Maven in the repository with the target JDK; resolves to the exit code. */
  maven: (args: string[]) => Promise<number>;
}

export interface FixResult {
  /** One line, used as the commit subject after "known-fix: ". */
  description: string;
  changed: string[];
}

export interface KnownFix {
  id: string;
  /** Categories whose failures this fix addresses. */
  categories: string[];
  attempt: (context: FixContext) => Promise<FixResult | null>;
}

const POM = 'pom.xml';

function readText(repoPath: string, file: string): string | null {
  try {
    return readFileSync(join(repoPath, file), 'utf8');
  } catch {
    return null;
  }
}

function editPom(repoPath: string, edit: (xml: string) => string | null): boolean {
  const xml = readText(repoPath, POM);
  if (xml === null) return false;
  const next = edit(xml);
  if (next === null || next === xml) return false;
  writeFileSync(join(repoPath, POM), next);
  return true;
}

/** Repo-relative paths of Java/Kotlin sources under src/, sorted. */
export function sourceFiles(repoPath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['target', 'node_modules', '.git', 'build'].includes(entry.name)) walk(path);
      } else if (/\.(java|kt)$/.test(entry.name)) {
        found.push(relative(repoPath, path).split('\\').join('/'));
      }
    }
  };
  walk(join(repoPath, 'src'));
  return found.sort();
}

function failuresOf(context: FixContext, category: string): Classified[] {
  return context.failures.filter((failure) => failure.category.id === category);
}

/** The formatter the build runs, applied to the recipe's output. */
const formatter: KnownFix = {
  id: 'apply-formatter',
  categories: ['formatting-check'],
  attempt: async (context) => {
    if (failuresOf(context, 'formatting-check').length === 0) return null;
    const pom = parsePom(readText(context.repoPath, POM) ?? '');
    const goal = pom.plugins.has('spring-javaformat-maven-plugin')
      ? 'io.spring.javaformat:spring-javaformat-maven-plugin:apply'
      : pom.plugins.has('spotless-maven-plugin')
        ? 'com.diffplug.spotless:spotless-maven-plugin:apply'
        : null;
    if (goal === null) return null;
    const code = await context.maven([goal]);
    if (code !== 0) return null;
    return { description: `apply ${goal.split(':')[1]} to the recipe output`, changed: [] };
  },
};

/**
 * Spring 6.1 reads parameter names only from -parameters. Passed as an
 * explicit compiler argument: on an old pinned maven-compiler-plugin (WebGoat:
 * 3.8.0 with the recipe's <release>) the `parameters` setting never reaches
 * javac, and the agent benchmark showed the explicit <arg> does.
 */
const parameters: KnownFix = {
  id: 'compiler-parameters',
  categories: ['compiler-parameters'],
  attempt: async (context) => {
    if (failuresOf(context, 'compiler-parameters').length === 0) return null;
    const changed = editPom(context.repoPath, (xml) => addCompilerArg(xml, '-parameters') ?? setProperty(xml, 'maven.compiler.parameters', 'true'));
    return changed ? { description: 'compile with -parameters (Spring 6.1 no longer reads debug info)', changed: [POM] } : null;
  },
};

/** Add `<arg>` to maven-compiler-plugin's <compilerArgs>, creating it in <configuration> if needed. */
export function addCompilerArg(xml: string, arg: string): string | null {
  const plugin = /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]*?<\/plugin>/.exec(xml);
  if (!plugin) return null;
  const block = plugin[0];
  if (block.includes(`<arg>${arg}</arg>`)) return null;
  let next: string | null = null;
  if (/<compilerArgs>/.test(block)) {
    next = block.replace(/(\n([ \t]*)<compilerArgs>)/, (open, _all, indent: string) => `${open}\n${indent}  <arg>${arg}</arg>`);
  } else if (/<configuration>/.test(block)) {
    next = block.replace(
      /(\n([ \t]*)<configuration>)/,
      (open, _all, indent: string) => `${open}\n${indent}  <compilerArgs>\n${indent}    <arg>${arg}</arg>\n${indent}  </compilerArgs>`,
    );
  }
  return next === null ? null : xml.replace(block, next);
}

/** An artifact the new Boot BOM stopped managing gets the Boot version explicitly. */
const managedVersion: KnownFix = {
  id: 'boot-artifact-version',
  categories: ['pom-missing-version'],
  attempt: async (context) => {
    const xml = readText(context.repoPath, POM);
    if (xml === null) return null;
    const boot = parsePom(xml).bootVersion;
    if (boot === null) return null;
    const artifacts: string[] = [];
    let next = xml;
    for (const failure of failuresOf(context, 'pom-missing-version')) {
      const match = /for (org\.springframework\.boot):([\w.-]+):\w+ is missing/.exec(failure.text);
      if (!match) continue;
      const edited = addDependencyVersion(next, match[1] as string, match[2] as string, boot);
      if (edited !== null) {
        next = edited;
        artifacts.push(match[2] as string);
      }
    }
    if (artifacts.length === 0) return null;
    writeFileSync(join(context.repoPath, POM), next);
    return { description: `give ${artifacts.join(', ')} the Boot version explicitly (${boot})`, changed: [POM] };
  },
};

/** --add-exports of a package no source uses, which javac rejects with --release. */
const unusedAddExports: KnownFix = {
  id: 'drop-unused-add-exports',
  categories: ['compiler-release-conflict'],
  attempt: async (context) => {
    if (failuresOf(context, 'compiler-release-conflict').length === 0) return null;
    const xml = readText(context.repoPath, POM);
    if (xml === null) return null;
    const sources = sourceFiles(context.repoPath).map((file) => readText(context.repoPath, file) ?? '');
    let next = xml;
    const dropped: string[] = [];
    // <arg>--add-exports</arg><arg>module/package=ALL-UNNAMED</arg>, or the joined form.
    const forms = [
      /\n[ \t]*<arg>--add-exports<\/arg>\s*\n[ \t]*<arg>([\w.]+)\/([\w.]+)=[^<]*<\/arg>/g,
      /\n[ \t]*<arg>--add-exports[ =]([\w.]+)\/([\w.]+)=[^<]*<\/arg>/g,
    ];
    for (const form of forms) {
      next = next.replace(form, (whole, _module: string, pkg: string) => {
        if (sources.some((text) => text.includes(pkg))) return whole;
        dropped.push(pkg);
        return '';
      });
    }
    if (dropped.length === 0) return null;
    writeFileSync(join(context.repoPath, POM), next);
    return { description: `drop --add-exports of ${dropped.join(', ')}, which no source uses`, changed: [POM] };
  },
};

const FLYWAY_MODULES: Array<[RegExp, string]> = [
  [/HSQL/i, 'flyway-database-hsqldb'],
  [/PostgreSQL/i, 'flyway-database-postgresql'],
  [/MySQL|MariaDB/i, 'flyway-mysql'],
  [/SQL Server/i, 'flyway-sqlserver'],
  [/Oracle/i, 'flyway-database-oracle'],
];

/** Flyway 10+ ships each database as its own module. */
const flywayModule: KnownFix = {
  id: 'flyway-database-module',
  categories: ['flyway-database-module'],
  attempt: async (context) => {
    for (const failure of failuresOf(context, 'flyway-database-module')) {
      const database = /Unsupported Database: ([^\n]+)/.exec(failure.text)?.[1] ?? '';
      const module = FLYWAY_MODULES.find(([pattern]) => pattern.test(database))?.[1];
      if (!module) continue;
      if (editPom(context.repoPath, (xml) => addDependency(xml, 'org.flywaydb', module))) {
        return { description: `add ${module} (Flyway 10 split its database support)`, changed: [POM] };
      }
    }
    return null;
  },
};

/**
 * Classes that moved without changing: an import rewrite, and the module that
 * now carries them. From the gap map's jhipster, WebGoat and reactjs fixes.
 */
const RELOCATIONS: Array<{ from: string; to: string; dependency?: [string, string] }> = [
  {
    from: 'org.springframework.boot.autoconfigure.h2.',
    to: 'org.springframework.boot.h2console.autoconfigure.',
    dependency: ['org.springframework.boot', 'spring-boot-h2console'],
  },
  {
    from: 'org.springframework.boot.web.servlet.server.ConfigurableServletWebServerFactory',
    to: 'org.springframework.boot.web.server.servlet.ConfigurableServletWebServerFactory',
  },
  {
    from: 'org.hibernate.validator.internal.constraintvalidators.hv.EmailValidator',
    to: 'org.hibernate.validator.internal.constraintvalidators.bv.EmailValidator',
  },
  { from: 'org.thymeleaf.extras.springsecurity5.', to: 'org.thymeleaf.extras.springsecurity6.' },
];

const relocations: KnownFix = {
  id: 'relocated-classes',
  categories: ['removed-boot-api', 'javax-leftover', 'uncategorised', 'removed-spring-api'],
  attempt: async (context) => {
    const text = context.failures.map((failure) => failure.text).join('\n');
    // The compiler names the missing package, not the class.
    const wanted = RELOCATIONS.filter((relocation) => text.includes(packageOf(relocation.from)));
    if (wanted.length === 0) return null;
    const changed = new Set<string>();
    for (const file of sourceFiles(context.repoPath)) {
      const source = readText(context.repoPath, file);
      if (source === null) continue;
      let next = source;
      for (const relocation of wanted) {
        next = next.split(`import ${relocation.from}`).join(`import ${relocation.to}`);
        next = next.split(`import static ${relocation.from}`).join(`import static ${relocation.to}`);
      }
      if (next !== source) {
        writeFileSync(join(context.repoPath, file), next);
        changed.add(file);
      }
    }
    for (const relocation of wanted) {
      if (relocation.dependency && editPom(context.repoPath, (xml) => addDependency(xml, ...relocation.dependency!))) {
        changed.add(POM);
      }
    }
    if (wanted.some((relocation) => relocation.from.includes('springsecurity5'))) {
      if (editPom(context.repoPath, (xml) => renameArtifact(xml, 'org.thymeleaf.extras', 'thymeleaf-extras-springsecurity5', 'thymeleaf-extras-springsecurity6'))) {
        changed.add(POM);
      }
    }
    if (changed.size === 0) return null;
    return {
      description: `follow moved classes: ${wanted.map((relocation) => relocation.from.replace(/\.$/, '').split('.').slice(-2).join('.')).join(', ')}`,
      changed: [...changed].sort(),
    };
  },
};

/** Spring 7 rejects private @Bean methods; the method is named in the error. */
const privateBean: KnownFix = {
  id: 'private-bean-method',
  categories: ['removed-spring-api'],
  attempt: async (context) => {
    const names = new Set<string>();
    for (const failure of context.failures) {
      for (const match of failure.text.matchAll(/@Bean method '(\w+)' must not be private or final/g)) names.add(match[1] as string);
    }
    if (names.size === 0) return null;
    const changed: string[] = [];
    for (const file of sourceFiles(context.repoPath)) {
      const source = readText(context.repoPath, file);
      if (source === null) continue;
      let next = source;
      for (const name of names) {
        next = next.replace(
          new RegExp(`(@Bean(?:\\([^)]*\\))?\\s+(?:@\\w+(?:\\([^)]*\\))?\\s+)*)private\\s+((?:static\\s+)?[\\w<>,.?\\[\\] ]+\\s+${name}\\s*\\()`, 'g'),
          '$1$2',
        );
      }
      if (next !== source) {
        writeFileSync(join(context.repoPath, file), next);
        changed.push(file);
      }
    }
    return changed.length > 0 ? { description: `make @Bean ${[...names].join(', ')} non-private (Spring 7)`, changed } : null;
  },
};

/** Generated API code still on javax: the generator's Boot 3 mode, as upstream projects did. */
const openapiJakarta: KnownFix = {
  id: 'openapi-generator-jakarta',
  categories: ['openapi-generator-javax'],
  attempt: async (context) => {
    if (failuresOf(context, 'openapi-generator-javax').length === 0) return null;
    const changed = editPom(context.repoPath, (xml) => {
      const plugin = /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>openapi-generator-maven-plugin<\/artifactId>[\s\S]*?<\/plugin>/.exec(xml);
      if (!plugin) return null;
      let block = plugin[0];
      const version = /<version>([\d.]+)<\/version>/.exec(block)?.[1];
      if (version !== undefined && older(version, '6.3.0')) block = block.replace(`<version>${version}</version>`, '<version>6.3.0</version>');
      if (!/<useSpringBoot3>|<useJakartaEe>/.test(block)) {
        if (!/<configOptions>/.test(block)) return null;
        block = block.replace(/(\n([ \t]*)<configOptions>)/g, (open, _all, indent: string) => `${open}\n${indent}    <useSpringBoot3>true</useSpringBoot3>`);
      }
      return block === plugin[0] ? null : xml.replace(plugin[0], block);
    });
    return changed ? { description: 'generate Jakarta API code (openapi-generator useSpringBoot3)', changed: [POM] } : null;
  },
};

/**
 * A version property the POM overrides feeds a BOM the new Boot imports, and
 * that BOM version does not exist: drop the override so Boot's applies.
 */
const staleBomProperty: KnownFix = {
  id: 'stale-bom-override',
  categories: ['unresolvable-bom'],
  attempt: async (context) => {
    const xml = readText(context.repoPath, POM);
    if (xml === null) return null;
    const properties = parsePom(xml).properties;
    for (const failure of failuresOf(context, 'unresolvable-bom')) {
      const match = /([\w.-]+):([\w.-]+):pom:([\w.-]+)/.exec(failure.text);
      if (!match) continue;
      const [, group, artifact, version] = match as unknown as [string, string, string, string];
      const stem = artifact.replace(/-bom$/, '');
      const candidates = [...properties].filter(
        ([name, value]) => value === version && name.endsWith('.version') && (name.startsWith(stem) || group.split('.').some((part) => part.length > 3 && name.startsWith(part))),
      );
      if (candidates.length !== 1) continue;
      const [name] = candidates[0] as [string, string];
      const next = removeProperty(xml, name);
      if (next === null) continue;
      writeFileSync(join(context.repoPath, POM), next);
      return { description: `drop the stale ${name}=${version} override (${artifact} ${version} does not exist)`, changed: [POM] };
    }
    return null;
  },
};

/** The Maven the wrapper downloads; the newest 3.9 at the time of writing. */
export const WRAPPER_MAVEN = '3.9.11';

/**
 * A Maven wrapper pinned below what the new plugins require: point it at a
 * current 3.9. Without a wrapper the machine's Maven is old, which is not the
 * repository's to fix, and nothing is changed.
 */
const mavenWrapper: KnownFix = {
  id: 'maven-wrapper-version',
  categories: ['maven-too-old'],
  attempt: async (context) => {
    if (failuresOf(context, 'maven-too-old').length === 0) return null;
    const file = '.mvn/wrapper/maven-wrapper.properties';
    const text = readText(context.repoPath, file);
    if (text === null) return null;
    const pattern = /(distributionUrl=\S*?\/apache-maven\/)(\d+\.\d+\.\d+)(\/apache-maven-)(\d+\.\d+\.\d+)(-bin\.zip)/;
    const match = pattern.exec(text);
    if (!match || !older(match[2] as string, WRAPPER_MAVEN)) return null;
    writeFileSync(join(context.repoPath, file), text.replace(pattern, `$1${WRAPPER_MAVEN}$3${WRAPPER_MAVEN}$5`));
    return { description: `run the build on Maven ${WRAPPER_MAVEN} (the wrapper pinned ${match[2]})`, changed: [file] };
  },
};

export const KNOWN_FIXES: KnownFix[] = [
  mavenWrapper,
  formatter,
  managedVersion,
  staleBomProperty,
  unusedAddExports,
  parameters,
  flywayModule,
  relocations,
  privateBean,
  openapiJakarta,
];

function packageOf(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name.slice(0, name.lastIndexOf('.'));
}

/** a < b for dotted numeric versions. */
export function older(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
