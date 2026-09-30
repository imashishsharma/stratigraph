/**
 * `upgrade plan`: what the project is, and where the gap map says upgrades
 * break — ADR-0047. No build, no network.
 *
 * Every hit is a fact (this file, this line, this text). What it predicts is
 * labelled as an expectation: the gap map saw this pattern break under the
 * recipe, not that it will break here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverJavaRuntimes, type JavaRuntime } from '../toolchain/java.js';
import { categoriseText, type Category } from './categories.js';
import { chooseJdks, type JdkChoice } from './maven.js';
import { javaMajor, readPom, type PomFacts } from './pom.js';
import { needsUpgrade, type UpgradeTarget } from './targets.js';

interface Pattern {
  /** A category id from categories.ts. */
  category: string;
  pattern: RegExp;
  /** Which files to look in. */
  files: RegExp;
  why: string;
}

const PATTERNS: Pattern[] = [
  { category: 'spring-security-config', pattern: /extends\s+WebSecurityConfigurerAdapter|GlobalMethodSecurityConfiguration|@EnableGlobalMethodSecurity|\.antMatchers\(/, files: /\.(java|kt)$/, why: 'the recipe converts the DSL but often leaves the adapter class (4 of 10 gap-map repos)' },
  { category: 'springfox', pattern: /springfox/, files: /(\.(java|kt)|pom\.xml)$/, why: 'springfox has no Boot 3 release; the recipe leaves a TODO or a half-migrated class' },
  { category: 'openapi-generator-javax', pattern: /openapi-generator-maven-plugin/, files: /pom\.xml$/, why: 'generated code keeps javax unless the generator is told otherwise; a generator bump can emit uncompilable code' },
  { category: 'hibernate-6', pattern: /@Type\(\s*type\s*=|getColumnIterator|getPropertyIterator|hibernate_sequence/i, files: /\.(java|kt|sql|xml|yml|yaml|properties)$/, why: 'Hibernate 6 changed @Type, metadata iterators and sequence naming' },
  { category: 'javax-leftover', pattern: /io\.jsonwebtoken[\s\S]{0,200}<version>0\.9|javax\.xml\.bind|springsecurity5/, files: /(\.(java|kt|html)|pom\.xml)$/, why: 'libraries without a Jakarta release, or renamed artifacts, survive the recipe' },
  { category: 'compiler-release-conflict', pattern: /--add-exports/, files: /pom\.xml$/, why: 'the recipe sets <release>, which javac refuses alongside --add-exports of system modules' },
  { category: 'compiler-parameters', pattern: /<maven-compiler-plugin\.version>3\.[0-9]\.|<artifactId>maven-compiler-plugin<\/artifactId>\s*<version>3\.[0-9]\./, files: /pom\.xml$/, why: 'an old compiler plugin can drop -parameters, which Spring 6.1 needs' },
  { category: 'formatting-check', pattern: /spring-javaformat-maven-plugin|spotless-maven-plugin/, files: /pom\.xml$/, why: 'the recipe output fails the formatting check' },
  { category: 'h2-reserved-word', pattern: /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?user["`]?\s*\(|@Table\(\s*name\s*=\s*"user"/i, files: /\.(sql|java|kt)$/, why: 'H2 2.x reserves USER' },
  { category: 'test-framework', pattern: /@Captor|spock-spring/, files: /(\.(java|kt|groovy)|pom\.xml)$/, why: 'Boot 4 no longer initialises @Captor fields; Spock needs 2.4 for Spring 6' },
  { category: 'removed-boot-api', pattern: /actuate\.trace\.http|autoconfigure\.h2\.|web\.servlet\.server\.ConfigurableServletWebServerFactory/, files: /\.(java|kt)$/, why: 'classes that moved or were renamed' },
  { category: 'flyway-database-module', pattern: /<artifactId>flyway-core<\/artifactId>[\s\S]*<artifactId>(?:hsqldb|postgresql|mysql-connector|mssql-jdbc|ojdbc\w*)<\/artifactId>|<artifactId>(?:hsqldb|postgresql|mysql-connector|mssql-jdbc|ojdbc\w*)<\/artifactId>[\s\S]*<artifactId>flyway-core<\/artifactId>/, files: /pom\.xml$/, why: 'Flyway 10 moved most databases into their own modules' },
  { category: 'security-filter-chain-conflict', pattern: /SecurityFilterChain\s+\w+\s*\(/, files: /\.(java|kt)$/, why: 'two filter chains that both match every request stop Boot 3.2+ at startup' },
];

export interface SurveyHit {
  file: string;
  line: number;
  text: string;
}

export interface PlanCategory {
  category: Category;
  why: string;
  hits: SurveyHit[];
  more: number;
}

export interface Plan {
  repoPath: string;
  pom: PomFacts | null;
  target: UpgradeTarget;
  upgradeNeeded: boolean;
  jdks: JdkChoice;
  installed: JavaRuntime[];
  hasWrapper: boolean;
  expected: PlanCategory[];
  blockers: string[];
}

export function planUpgrade(repoPath: string, target: UpgradeTarget, runtimes = discoverJavaRuntimes()): Plan {
  const pom = readPom(repoPath);
  const blockers: string[] = [];
  if (pom === null) blockers.push('no pom.xml: the upgrade supports Maven projects');
  else if (pom.bootVersion === null) blockers.push('the Spring Boot version is not declared in pom.xml (parent, BOM import or spring-boot.version)');
  if (pom !== null && pom.modules.length > 0) blockers.push(`multi-module build (${pom.modules.length} modules): not yet supported; the recipe runs, but the loop reads one module's reports`);
  const upgradeNeeded = pom?.bootVersion ? needsUpgrade(pom.bootVersion, target) : false;
  if (pom?.bootVersion && !upgradeNeeded) blockers.push(`already on Spring Boot ${pom.bootVersion}`);

  const jdks = chooseJdks(javaMajor(pom?.javaVersion ?? null), target.minJava, runtimes);
  if (jdks.target === null) blockers.push(`no JDK ${target.minJava}+ installed`);

  const files = listFiles(repoPath);
  const expected: PlanCategory[] = [];
  const seenPairs = new Set<string>();
  for (const pattern of PATTERNS) {
    const hits: SurveyHit[] = [];
    for (const file of files) {
      if (!pattern.files.test(file)) continue;
      let text: string;
      try {
        text = readFileSync(join(repoPath, file), 'utf8');
      } catch {
        continue;
      }
      if (!pattern.pattern.test(text)) continue;
      const lines = text.split('\n');
      const lineIndex = lines.findIndex((line) => pattern.pattern.test(line));
      const index = lineIndex >= 0 ? lineIndex : lines.findIndex((line) => new RegExp(pattern.pattern.source.split('[\\s\\S]')[0] ?? '', 'i').test(line));
      hits.push({ file, line: index + 1, text: (lines[index] ?? '').trim().slice(0, 160) });
    }
    // Two or more SecurityFilterChain beans is the risk, not one.
    if (pattern.category === 'security-filter-chain-conflict' && hits.length < 2) continue;
    if (hits.length === 0) continue;
    const key = pattern.category;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    expected.push({
      category: categoryById(pattern.category),
      why: pattern.why,
      hits: hits.slice(0, 5),
      more: Math.max(0, hits.length - 5),
    });
  }

  return {
    repoPath,
    pom,
    target,
    upgradeNeeded,
    jdks,
    installed: runtimes,
    hasWrapper: files.includes('mvnw'),
    expected,
    blockers,
  };
}

function categoryById(id: string): Category {
  // Categories are defined by their rules; find the one a representative text maps to.
  const probe: Record<string, string> = {
    'spring-security-config': 'WebSecurityConfigurerAdapter',
    springfox: 'springfox',
    'openapi-generator-javax': 'generated-sources/openapi javax.validation',
    'hibernate-6': 'org.hibernate',
    'javax-leftover': 'javax.xml.bind',
    'compiler-release-conflict': 'not allowed with --release',
    'compiler-parameters': 'Name for argument of type [String] not specified',
    'formatting-check': 'spring-javaformat validate: Formatting violations',
    'h2-reserved-word': 'NON_KEYWORDS',
    'test-framework': '@Captor',
    'removed-boot-api': 'package org.springframework.boot.x does not exist',
    'security-filter-chain-conflict': 'UnreachableFilterChainException',
    'flyway-database-module': 'FlywayException: Unsupported Database: x',
  };
  return categoriseText(probe[id] ?? id);
}

function listFiles(repoPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (['.git', 'target', 'node_modules', 'build', 'dist', '.idea', '.gradle'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) {
        try {
          if (statSync(path).size > 2_000_000) continue;
        } catch {
          continue;
        }
        out.push(relative(repoPath, path).split('\\').join('/'));
      }
    }
  };
  walk(repoPath, 0);
  return out.sort();
}

export function renderPlan(plan: Plan): string {
  const out: string[] = [];
  const pom = plan.pom;
  out.push(`Upgrade plan: Spring Boot ${pom?.bootVersion ?? '?'} → ${plan.target.boot}`, '');
  out.push(`  Boot version   ${pom?.bootVersion ?? 'not declared'}${pom?.bootVersionFrom ? `  (pom.xml, ${pom.bootVersionFrom})` : ''}`);
  out.push(`  Java declared  ${pom?.javaVersion ?? 'not declared'}`);
  out.push(`  Recipe         ${plan.target.recipe}`);
  out.push(`  Baseline JDK   ${plan.jdks.baseline ? `${plan.jdks.baseline.version} (${plan.jdks.baseline.home})` : 'none found'}`);
  out.push(`  Target JDK     ${plan.jdks.target ? `${plan.jdks.target.version} (${plan.jdks.target.home})` : 'none found'}`);
  out.push(`  Maven          ${plan.hasWrapper ? './mvnw (the project\'s wrapper)' : 'mvn on PATH'}`);
  for (const note of plan.jdks.notes) out.push(`  note: ${note}`);
  out.push('');
  if (plan.blockers.length > 0) {
    out.push('Cannot run:');
    for (const blocker of plan.blockers) out.push(`  ✗ ${blocker}`);
    out.push('');
  }
  if (plan.expected.length === 0) {
    out.push('Expected trouble: none of the patterns the gap map saw break are present.', '');
  } else {
    out.push('Expected trouble (the gap map saw these patterns break under the recipe; an expectation, not a result):', '');
    for (const entry of plan.expected) {
      const tag = entry.category.disposition === 'decision' ? 'needs a decision' : entry.category.disposition;
      out.push(`  ${entry.category.title}  [${tag}]`);
      out.push(`    why: ${entry.why}`);
      for (const hit of entry.hits) out.push(`    ${hit.file}:${hit.line}  ${hit.text}`);
      if (entry.more > 0) out.push(`    …and ${entry.more} more file(s)`);
      out.push('');
    }
  }
  out.push('`stratigraph upgrade run` will:');
  out.push('  1. build and test on a new branch as-is (the baseline),');
  out.push('  2. run the recipe (Maven downloads the rewrite plugin and the new dependencies),');
  out.push('  3. rebuild, apply known fixes, and — only with --ai claude-code — let Claude Code attempt the rest,');
  out.push('  4. keep a change only if it leaves fewer failures and no newly red test,');
  out.push('  5. write upgrade-report.md with what is left and the options for each decision.');
  return out.join('\n');
}
