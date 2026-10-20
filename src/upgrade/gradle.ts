/**
 * The Gradle side of `upgrade` — ADR-0047, amended: what a Gradle build
 * declares, what its output says went wrong, and the few exact edits the
 * known fixes make to build scripts.
 *
 * Like `pom.ts`, deliberately not a build model. Gradle scripts are programs;
 * what is read here is what Spring Boot projects write by convention (the
 * plugins block, gradle.properties, ext properties, a version catalog), and a
 * version that is not written in one of those places is reported unknown, not
 * guessed. The build is the authority on the rest.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import type { BuildFailure, BuildLog } from './build-log.js';

export interface GradleFacts {
  /** The root build script, repo-relative. */
  buildFile: string;
  kotlinDsl: boolean;
  bootVersion: string | null;
  bootVersionFrom: string | null;
  javaVersion: string | null;
  /** The wrapper's Gradle version, or null without a wrapper. */
  gradleVersion: string | null;
  /** Plugin ids applied in the root script (spotless, javaformat, …). */
  plugins: Set<string>;
}

export function isGradleProject(repoPath: string): boolean {
  return existsSync(join(repoPath, 'build.gradle')) || existsSync(join(repoPath, 'build.gradle.kts'));
}

export function readGradleFacts(repoPath: string): GradleFacts | null {
  const kotlinDsl = existsSync(join(repoPath, 'build.gradle.kts'));
  const buildFile = kotlinDsl ? 'build.gradle.kts' : 'build.gradle';
  if (!existsSync(join(repoPath, buildFile))) return null;
  const script = read(repoPath, buildFile) ?? '';
  const properties = parseProperties(read(repoPath, 'gradle.properties') ?? '');
  const catalog = read(repoPath, 'gradle/libs.versions.toml') ?? '';
  const ext = new Map<string, string>();
  for (const match of script.matchAll(/(?:set\(\s*"|ext\s*\{[^}]*?|ext\.)([\w.]+)['"]?\s*(?:,|=)\s*['"]([^'"]+)['"]/g)) {
    ext.set(match[1] as string, match[2] as string);
  }
  const resolveVar = (value: string | undefined): string | null => {
    if (value === undefined) return null;
    const name = /^\$\{?([\w.]+)\}?$/.exec(value)?.[1] ?? /^(?:project\.)?(\w+)$/.exec(value)?.[1];
    if (name && !/^\d/.test(name)) return properties.get(name) ?? ext.get(name) ?? null;
    return value;
  };

  let bootVersion: string | null = null;
  let bootVersionFrom: string | null = null;
  const plugin = /id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*\(?\s*["']?([^"'\s)]+)["']?/.exec(script);
  if (plugin) {
    bootVersion = resolveVar(plugin[1]);
    bootVersionFrom = `${buildFile} plugins block`;
  }
  if (bootVersion === null) {
    for (const name of ['springBootVersion', 'spring_boot_version', 'spring-boot.version', 'springBoot.version']) {
      const value = properties.get(name) ?? ext.get(name);
      if (value) {
        bootVersion = value;
        bootVersionFrom = properties.has(name) ? `gradle.properties ${name}` : `${buildFile} ext ${name}`;
        break;
      }
    }
  }
  if (bootVersion === null) {
    const fromClasspath = /org\.springframework\.boot:spring-boot-gradle-plugin:([\w.${}]+)/.exec(script)?.[1];
    if (fromClasspath) {
      bootVersion = resolveVar(fromClasspath);
      bootVersionFrom = `${buildFile} buildscript classpath`;
    }
  }
  if (bootVersion === null) {
    const fromCatalog = /^\s*(?:spring-?boot|springBoot)\s*=\s*"([^"]+)"/m.exec(catalog)?.[1];
    if (fromCatalog) {
      bootVersion = fromCatalog;
      bootVersionFrom = 'gradle/libs.versions.toml';
    }
  }
  if (bootVersion !== null && /[${]/.test(bootVersion)) bootVersion = null;

  const javaVersion =
    /languageVersion(?:\.set\()?\s*=?\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(script)?.[1] ??
    /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)['"]?/.exec(script)?.[1]?.replace(/_/g, '.') ??
    properties.get('java_version') ??
    properties.get('javaVersion') ??
    null;

  const plugins = new Set<string>();
  for (const match of script.matchAll(/id\s*\(?\s*["']([\w.-]+)["']/g)) plugins.add(match[1] as string);
  for (const match of script.matchAll(/apply\s+plugin:\s*["']([\w.-]+)["']/g)) plugins.add(match[1] as string);

  return {
    buildFile,
    kotlinDsl,
    bootVersion,
    bootVersionFrom,
    javaVersion,
    gradleVersion: wrapperGradleVersion(repoPath),
    plugins,
  };
}

/** The Gradle version the wrapper downloads, e.g. "6.0.1". */
export function wrapperGradleVersion(repoPath: string): string | null {
  const properties = read(repoPath, 'gradle/wrapper/gradle-wrapper.properties');
  if (properties === null) return null;
  return /distributionUrl\s*=\s*\S*?gradle-([\d.]+(?:-rc-\d+)?)-(?:all|bin)\.zip/.exec(properties)?.[1] ?? null;
}

/** Point the wrapper at `version`, keeping the -all/-bin flavour; null when there is no wrapper. */
export function setWrapperVersion(properties: string, version: string): string | null {
  const pattern = /(distributionUrl\s*=\s*\S*?gradle-)([\d.]+(?:-rc-\d+)?)(-(?:all|bin)\.zip)/;
  if (!pattern.test(properties)) return null;
  return properties
    .replace(pattern, `$1${version}$3`)
    // A checksum pins the old distribution; it would fail the new download.
    .replace(/\n?distributionSha256Sum\s*=.*$/m, '');
}

/** Add `-parameters` to every JavaCompile task; null when already there. */
export function addCompilerParametersArg(script: string, kotlinDsl: boolean): string | null {
  if (/-parameters/.test(script)) return null;
  const block = kotlinDsl
    ? '\ntasks.withType<JavaCompile>().configureEach {\n    options.compilerArgs.add("-parameters")\n}\n'
    : "\ntasks.withType(JavaCompile).configureEach {\n    options.compilerArgs << '-parameters'\n}\n";
  return `${script.replace(/\s*$/, '\n')}${block}`;
}

/** Add an `implementation` dependency to the top-level dependencies block; null when absent or present. */
export function addGradleDependency(script: string, coordinates: string, kotlinDsl: boolean): string | null {
  if (script.includes(coordinates)) return null;
  const top = topLevelDependenciesClose(script);
  if (top === null) return null;
  const line = kotlinDsl ? `    implementation("${coordinates}")\n` : `    implementation '${coordinates}'\n`;
  const lineStart = script.lastIndexOf('\n', top) + 1;
  return script.slice(0, lineStart) + line + script.slice(lineStart);
}

/**
 * Offset of the `}` closing the script's top-level `dependencies {` block:
 * the last one written at column 0, which is how scripts lay it out (the
 * buildscript block's own `dependencies` is indented inside it).
 */
function topLevelDependenciesClose(script: string): number | null {
  const opens = [...script.matchAll(/^dependencies\s*\{/gm)];
  const open = opens.at(-1);
  if (open === undefined) return null;
  let depth = 0;
  for (let i = (open.index ?? 0) + open[0].length - 1; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading what a Gradle build said went wrong.

const JAVAC = /^(\/.+\.java|[A-Za-z]:\\.+\.java):(\d+): (?:error|warning): (.+)$/;
const KOTLIN = /^e: (?:file:\/\/)?(\/.+\.kts?|[A-Za-z]:\\.+\.kts?):(\d+):(\d+) (.+)$/;
const KOTLIN_OLD = /^e: (\/.+\.kts?): \((\d+), (\d+)\): (.+)$/;

/**
 * Gradle's output, read into the same shape as Maven's (build-log.ts). A
 * build that fails only because tests failed counts as built — the same as
 * Maven's `-Dmaven.test.failure.ignore` — since the tests' outcomes are read
 * from their reports and a red test is not a build failure.
 */
export function parseGradleLog(text: string, repoPath: string): BuildLog {
  const lines = text.split(/\r?\n/);
  const failures: BuildFailure[] = [];
  const seen = new Set<string>();
  const push = (failure: BuildFailure) => {
    const key = `${failure.kind}\0${failure.file}\0${failure.line}\0${failure.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push(failure);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trimEnd();
    const javac = JAVAC.exec(line);
    if (javac && line.includes(': error: ')) {
      const excerpt = [line];
      let symbol: string | null = null;
      // javac echoes the source line and a caret, then symbol/location.
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
        if (JAVAC.test((lines[j] as string).trimEnd())) break;
        const detail = /^(symbol|location):\s+(.+)$/.exec((lines[j] as string).trim());
        if (detail) {
          excerpt.push(lines[j] as string);
          if (detail[1] === 'symbol') symbol = (detail[2] as string).trim();
        }
      }
      push({ kind: 'compile', message: (javac[3] as string).trim(), file: rel(javac[1] as string, repoPath), line: Number(javac[2]), symbol, excerpt });
      continue;
    }
    const kotlin = KOTLIN.exec(line) ?? KOTLIN_OLD.exec(line);
    if (kotlin) {
      push({ kind: 'compile', message: (kotlin[4] as string).trim(), file: rel(kotlin[1] as string, repoPath), line: Number(kotlin[2]), symbol: null, excerpt: [line] });
    }
  }

  // "* What went wrong:" blocks: one per failed task or script problem.
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\* What went wrong:/.test(lines[i] as string)) continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\* (?:Try|Exception is|Get more help):/.test(lines[j] as string); j += 1) {
      if ((lines[j] as string).trim() !== '') block.push((lines[j] as string).trim());
    }
    const text = block.join('\n');
    const task = /Execution failed for task '([^']+)'/.exec(text)?.[1] ?? null;
    if (task && /There were failing tests|tests completed, \d+ failed/i.test(text)) continue; // read from the reports
    if (task && /Compilation (?:failed|error)/i.test(text) && failures.some((failure) => failure.kind === 'compile')) continue;
    const reason = block.find((entry) => entry.startsWith('>'))?.replace(/^>\s*/, '') ?? block[0] ?? 'the build failed';
    const kind: BuildFailure['kind'] =
      /Could not (?:resolve|find|download)|could not be resolved|Could not GET|Could not HEAD/i.test(text)
        ? 'dependency'
        : task === null || /problem occurred (?:evaluating|configuring)|Plugin \[id: |requires Gradle|Unsupported class file major version|incompatible with|Could not open .* class cache|BUG! exception in phase/i.test(text)
          ? 'pom'
          : 'plugin';
    push({
      kind,
      message: task ? `${task}: ${reason}` : reason,
      file: kind === 'pom' ? 'build.gradle' : null,
      line: null,
      symbol: null,
      excerpt: block.slice(0, 12),
    });
  }

  const goals = (text.match(/^> Task :[\w:.-]+/gm) ?? []).length;
  const success = /^BUILD SUCCESSFUL/m.test(text) || (/^BUILD FAILED/m.test(text) && failures.length === 0 && /There were failing tests|tests completed, \d+ failed/i.test(text));
  if (!success && failures.length === 0) {
    // No Gradle summary: the wrapper or the JVM failed before Gradle ran.
    // Its exception line says why; the stack under it does not.
    const thrown = lines.find((entry) => /^Exception in thread |^Error: /.test(entry))?.trim();
    const tail = lines.filter((entry) => entry.trim() !== '').slice(-12);
    failures.push({
      kind: thrown ? 'pom' : 'plugin',
      message: `the build failed: ${(thrown ?? tail.find((entry) => /error|fail|exception/i.test(entry))?.trim() ?? 'no error line recognised').slice(0, 300)}`,
      file: null,
      line: null,
      symbol: null,
      excerpt: thrown ? [thrown, ...tail.slice(-6)] : tail,
    });
  }
  return { success, failures, goals };
}

function rel(path: string, repoPath: string): string {
  return (isAbsolute(path) ? relative(repoPath, path) : path).split('\\').join('/');
}

function read(repoPath: string, file: string): string | null {
  try {
    return readFileSync(join(repoPath, file), 'utf8');
  } catch {
    return null;
  }
}

function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#')) out.set(match[1] as string, match[2] as string);
  }
  return out;
}

/**
 * The init script that applies OpenRewrite's Gradle plugin to the root
 * project for one run, so the project's build files are never edited to add
 * it (the same rule as the Maven invocation by coordinates).
 */
export function rewriteInitScript(pluginVersion: string, recipeCoordinates: string, recipe: string, exclusions: string[]): string {
  return `initscript {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
    dependencies {
        classpath("org.openrewrite:plugin:${pluginVersion}")
    }
}
rootProject {
    plugins.apply(org.openrewrite.gradle.RewritePlugin)
    dependencies {
        rewrite("${recipeCoordinates}")
    }
    rewrite {
        activeRecipe("${recipe}")
${exclusions.map((glob) => `        exclusion("${glob}")`).join('\n')}
    }
    afterEvaluate {
        if (repositories.isEmpty()) {
            repositories {
                mavenCentral()
            }
        }
    }
}
`;
}

// ---------------------------------------------------------------------------
// What Spring Boot's BOM manages, read from the BOM itself.

export interface BootManaged {
  /** group:artifact listed in spring-boot-dependencies. */
  artifacts: Set<string>;
  /** Groups whose own BOM spring-boot-dependencies imports (all their artifacts are managed). */
  groups: Set<string>;
  /** The file it was read from, for the commit message. */
  source: string;
}

/**
 * spring-boot-dependencies for `bootVersion`, from the local Gradle or Maven
 * cache — never the network. Null when neither has it (the fix that needs it
 * then does not apply).
 */
export function readBootManaged(bootVersion: string, env: NodeJS.ProcessEnv = process.env): BootManaged | null {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  const gradleHome = env['GRADLE_USER_HOME'] ?? join(home, '.gradle');
  const candidates: string[] = [];
  const gradleDir = join(gradleHome, 'caches', 'modules-2', 'files-2.1', 'org.springframework.boot', 'spring-boot-dependencies', bootVersion);
  try {
    for (const hash of readdirSync(gradleDir)) candidates.push(join(gradleDir, hash, `spring-boot-dependencies-${bootVersion}.pom`));
  } catch {
    // not in the Gradle cache
  }
  candidates.push(join(home, '.m2', 'repository', 'org', 'springframework', 'boot', 'spring-boot-dependencies', bootVersion, `spring-boot-dependencies-${bootVersion}.pom`));
  for (const path of candidates) {
    let xml: string;
    try {
      xml = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const managed = xml.slice(xml.indexOf('<dependencyManagement>'));
    const artifacts = new Set<string>();
    const groups = new Set<string>();
    for (const [block] of managed.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)) {
      const group = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1];
      const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1];
      if (!group || !artifact) continue;
      if (/<scope>import<\/scope>/.test(block)) groups.add(group);
      else artifacts.add(`${group}:${artifact}`);
    }
    return { artifacts, groups, source: path };
  }
  return null;
}

const PIN = /^(\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly)\s*\(?\s*)(['"])([\w.-]+):([\w.-]+):([\w.+-]+)\2/gm;

/**
 * Drop the version from dependencies the Boot BOM manages whose group the
 * failures name (a NoSuchMethodError in io.restassured.* names
 * io.rest-assured): a hand pin beside a BOM-managed sibling is how two
 * versions of one library end up on a classpath.
 */
export function dropManagedPins(script: string, managed: BootManaged, failureText: string): { script: string; dropped: string[] } {
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const packages = [...new Set([...failureText.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,})\.[A-Z]\w*/g)].map((match) => squash(match[1] as string)))];
  const dropped: string[] = [];
  const next = script.replace(PIN, (whole, lead: string, quote: string, group: string, artifact: string) => {
    const isManaged = managed.groups.has(group) || managed.artifacts.has(`${group}:${artifact}`);
    const named = packages.some((pkg) => pkg.startsWith(squash(group)));
    if (!isManaged || !named) return whole;
    dropped.push(`${group}:${artifact}`);
    return `${lead}${quote}${group}:${artifact}${quote}`;
  });
  return { script: next, dropped };
}
