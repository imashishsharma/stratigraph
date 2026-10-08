/**
 * The upgrade run — ADR-0047: baseline, recipe, then build → classify →
 * known fix or AI attempt → rebuild → keep only what made things better, until
 * the baseline's green tests are green again, a budget runs out, or every
 * remaining failure is a decision for a person.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { info, warn } from '../log.js';
import { parseBuildLog, type BuildLog } from './build-log.js';
import { categoriseTest, categoriseText } from './categories.js';
import { guardrailViolations, type Fixer } from './fixer.js';
import {
  branchExists,
  changedFiles,
  commitChanges,
  currentBranch,
  dirtyFiles,
  git,
  gitDir,
  head,
  isGitRepo,
  resetTo,
  trackedChanges,
  untracked,
} from './git.js';
import { KNOWN_FIXES, type Classified } from './known-fixes.js';
import { tidyEdit } from './tidy.js';
import { VERIFY, type Maven, type MavenResult } from './maven.js';
import { readPom } from './pom.js';
import { REWRITE_PLUGIN_VERSION, REWRITE_SPRING_VERSION, needsUpgrade, type UpgradeTarget } from './targets.js';
import { atParity, clearTestReports, diffTests, readTestReports, type TestDiff, type TestResult } from './test-reports.js';
import { writeReport, type Attempt, type UpgradeReport } from './report.js';

export class UpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeError';
  }
}

export interface RunOptions {
  repoPath: string;
  target: UpgradeTarget;
  /** Builds the baseline, on the JDK the project declares. */
  baselineMaven: (logDir: string) => Maven;
  /** Runs the recipe and every later build, on the target JDK. */
  targetMaven: (logDir: string) => Maven;
  targetJavaHome: string;
  mavenArgs: string[];
  fixer: Fixer | null;
  maxBuilds: number;
  maxMinutes: number;
  /** AI attempts allowed per category before it is handed off. */
  attemptsPerCategory: number;
  branch?: string | undefined;
  rewritePlugin?: string | undefined;
  rewriteSpring?: string | undefined;
  now?: () => number;
}

export interface BuildState {
  label: string;
  result: MavenResult;
  log: BuildLog;
  tests: Map<string, TestResult>;
  diff: TestDiff;
  failures: Classified[];
}

export async function runUpgrade(options: RunOptions): Promise<UpgradeReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const { repoPath, target } = options;

  if (!isGitRepo(repoPath)) throw new UpgradeError(`${repoPath} is not a git repository; the upgrade works on a branch of it.`);
  const dirty = trackedChanges(repoPath);
  if (dirty.length > 0) {
    throw new UpgradeError(`the work tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}); commit or stash them first.`);
  }
  const pom = readPom(repoPath);
  if (pom === null) throw new UpgradeError(`no pom.xml in ${repoPath}; the upgrade supports Maven projects.`);
  if (pom.bootVersion === null) {
    throw new UpgradeError('the Spring Boot version is not declared in pom.xml (parent, BOM import or spring-boot.version).');
  }
  if (!needsUpgrade(pom.bootVersion, target)) {
    throw new UpgradeError(`the project is already on Spring Boot ${pom.bootVersion}; nothing to upgrade to ${target.boot}.`);
  }

  const preexisting = untracked(repoPath);
  const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
  const logDir = join(gitDir(repoPath), 'stratigraph-upgrade', stamp);
  mkdirSync(logDir, { recursive: true });

  const startBranch = currentBranch(repoPath);
  const startSha = head(repoPath);
  const branch = options.branch ?? `stratigraph/upgrade-spring-boot-${target.boot}`;
  if (branchExists(repoPath, branch)) {
    throw new UpgradeError(`branch ${branch} already exists; delete it or pass --branch.`);
  }
  git(repoPath, ['switch', '-q', '-c', branch]);
  info(`upgrade: Spring Boot ${pom.bootVersion} → ${target.boot} on branch ${branch} (from ${startBranch} ${startSha.slice(0, 10)})`);
  info(`upgrade: build logs in ${logDir}`);

  const baselineMaven = options.baselineMaven(logDir);
  const maven = options.targetMaven(logDir);
  const attempts: Attempt[] = [];
  const report: UpgradeReport = {
    status: 'stuck',
    from: pom.bootVersion,
    to: target.boot,
    recipe: target.recipe,
    rewriteSpring: options.rewriteSpring ?? REWRITE_SPRING_VERSION,
    branch,
    startBranch,
    startSha,
    logDir,
    ai: options.fixer?.name ?? null,
    baseline: null,
    final: null,
    commits: [],
    attempts,
    remaining: [],
    testFilesChanged: [],
    codeChangedForTests: [],
    builds: 0,
    minutes: 0,
    costUsd: 0,
    notes: [],
  };
  const finish = (status: UpgradeReport['status']) => {
    report.status = status;
    report.minutes = Math.round((now() - started) / 60000);
    const sha = writeReport(repoPath, report, preexisting);
    if (sha) report.commits.push({ sha, layer: 'report', subject: 'upgrade: report' });
    return report;
  };

  // 1. Baseline: the reference every later build is compared with.
  info('upgrade: baseline build (this is the reference: tests red here are not the upgrade\'s to fix)');
  clearTestReports(repoPath);
  const baselineRun = await baselineMaven(VERIFY, 'baseline');
  const baselineLog = parseBuildLog(baselineRun.log, repoPath);
  const baselineTests = readTestReports(repoPath);
  report.builds += 1;
  report.baseline = summarise(baselineTests, baselineLog, baselineRun);
  if (!baselineLog.success) {
    report.notes.push(`The project does not build before the upgrade (${baselineRun.logPath}). Fix that first; the upgrade needs a baseline to compare against.`);
    report.remaining = handoffs(classify(baselineLog, diffTests(new Map(), new Map())), attempts);
    return finish('baseline-broken');
  }
  info(`upgrade: baseline ${report.baseline.passed}/${report.baseline.tests} tests pass`);

  // 2. The recipe, as one commit.
  const exclusions = gradleExclusions(repoPath);
  const recipeArgs = (goal: string) => [
    `org.openrewrite.maven:rewrite-maven-plugin:${options.rewritePlugin ?? REWRITE_PLUGIN_VERSION}:${goal}`,
    `-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:${options.rewriteSpring ?? REWRITE_SPRING_VERSION}`,
    `-Drewrite.activeRecipes=${target.recipe}`,
    ...(exclusions ? [`-Drewrite.exclusions=${exclusions}`] : []),
  ];
  info(`upgrade: running ${target.recipe}`);
  let recipe = await maven(recipeArgs('run'), 'recipe');
  if (recipe.exitCode !== 0) {
    // `run` compiles first; on the target JDK the old code may not, and
    // runNoFork parses without that compile.
    warn('upgrade: the recipe run failed; retrying without its forked compile (runNoFork)');
    recipe = await maven(recipeArgs('runNoFork'), 'recipe-nofork');
  }
  if (recipe.exitCode !== 0) {
    report.notes.push(`The OpenRewrite recipe itself failed (${recipe.logPath}).`);
    report.remaining = handoffs(classify(parseBuildLog(recipe.log, repoPath), diffTests(baselineTests, new Map())), attempts);
    return finish('recipe-failed');
  }
  const recipeSha = commitChanges(repoPath, `upgrade(recipe): ${target.recipe}\n\nOpenRewrite rewrite-spring ${report.rewriteSpring}, unedited.`, preexisting);
  if (recipeSha) report.commits.push({ sha: recipeSha, layer: 'recipe', subject: target.recipe });
  else report.notes.push('The recipe made no changes.');
  let lastGood = head(repoPath);

  // 3. The loop.
  const evaluate = async (label: string): Promise<BuildState> => {
    clearTestReports(repoPath);
    const result = await maven(VERIFY, label);
    report.builds += 1;
    const log = parseBuildLog(result.log, repoPath);
    const tests = readTestReports(repoPath);
    const diff = diffTests(baselineTests, tests);
    return { label, result, log, tests, diff, failures: classify(log, diff, repoPath) };
  };

  let state = await evaluate('build-1');
  const tried = new Set<string>();
  let fixer = options.fixer;
  const aiTries = new Map<string, number>();
  const outOfBudget = () => report.builds >= options.maxBuilds || now() - started > options.maxMinutes * 60000;

  while (!isParity(state) && !outOfBudget()) {
    info(`upgrade: ${state.label}: ${describe(state)}`);
    let progressed = false;

    // Known fixes first: exact, and cheap to try.
    for (const fix of KNOWN_FIXES) {
      const relevant = state.failures.filter((failure) => fix.categories.includes(failure.category.id));
      if (relevant.length === 0) continue;
      const key = `${fix.id}\0${signature(relevant)}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const result = await fix.attempt({
        repoPath,
        failures: state.failures,
        maven: async (args) => (await maven(args, `fix-${fix.id}`)).exitCode,
      });
      if (result === null) continue;
      if (dirtyFiles(repoPath, preexisting).length === 0) continue;
      const next = await evaluate(`build-${report.builds + 1}`);
      const verdict = judge(state, next);
      if (verdict === null) {
        const sha = commitChanges(repoPath, `upgrade(known-fix): ${result.description}`, preexisting);
        if (sha) {
          report.commits.push({ sha, layer: 'known-fix', subject: result.description });
          lastGood = sha;
          flagCodeChangedForTests(repoPath, sha, relevant, report);
        }
        attempts.push({ by: 'known-fix', id: fix.id, category: relevant[0]!.category.id, accepted: true, reason: 'fewer failures, no new red test', sha, description: result.description });
        info(`upgrade: known fix kept: ${result.description}`);
        state = next;
        progressed = true;
        break;
      }
      resetTo(repoPath, lastGood, preexisting);
      attempts.push({ by: 'known-fix', id: fix.id, category: relevant[0]!.category.id, accepted: false, reason: verdict, sha: null, description: result.description });
      info(`upgrade: known fix rejected (${verdict}): ${result.description}`);
    }
    if (progressed) continue;

    // Then the AI fixer, for what is not a decision.
    if (fixer === null) break;
    // Consequences wait while what causes them is still failing.
    const causes = state.failures.filter((failure) => !failure.category.consequence);
    const workable = (causes.length > 0 ? causes : state.failures).filter(
      (failure) => failure.category.disposition !== 'decision' && !(causes.length > 0 && failure.category.consequence),
    );
    const groups = groupByCategory(workable);
    const group = groups.find(([id]) => (aiTries.get(id) ?? 0) < options.attemptsPerCategory);
    if (group === undefined) break;
    const [categoryId, targetFailures] = group;
    aiTries.set(categoryId, (aiTries.get(categoryId) ?? 0) + 1);
    const number = attempts.filter((attempt) => attempt.by === 'ai').length + 1;
    info(`upgrade: AI attempt ${number} on ${categoryId} (${targetFailures.length} failure(s))`);
    const fixed = await fixer.attempt({
      repoPath,
      from: report.from,
      to: target.boot,
      target: targetFailures,
      others: state.failures,
      attempt: number,
      logDir,
      javaHome: options.targetJavaHome,
      mavenArgs: options.mavenArgs,
    });
    report.costUsd += fixed.costUsd ?? 0;
    // Line endings and trailing whitespace the fixer changed on lines it did
    // not really edit go back as they were, before anything judges the edit.
    const tidy = tidyEdit(repoPath, dirtyFiles(repoPath, preexisting).filter((path) => trackedChanges(repoPath).includes(path)));
    const touched = dirtyFiles(repoPath, preexisting);
    if (fixed.unavailable) {
      // Not a failed fix: the fixer never ran. Say so once and stop asking it.
      resetTo(repoPath, lastGood, preexisting);
      report.notes.push(`The AI fixer could not run (${fixed.error ?? 'unavailable'}); no AI attempts were made. Fix that and run again.`);
      warn(`upgrade: the AI fixer could not run: ${fixed.error}`);
      fixer = null;
      continue;
    }
    if (fixed.error !== null || touched.length === 0) {
      resetTo(repoPath, lastGood, preexisting);
      const reason = fixed.error ?? 'made no change';
      attempts.push({ by: 'ai', id: `ai-${number}`, category: categoryId, accepted: false, reason, sha: null, description: fixed.summary });
      info(`upgrade: AI attempt ${number} rejected (${reason})`);
      continue;
    }
    // New files join the diff the guardrails read.
    const fresh = touched.filter((path) => !trackedChanges(repoPath).includes(path));
    if (fresh.length > 0) git(repoPath, ['add', '-N', '--', ...fresh]);
    const violations = guardrailViolations(git(repoPath, ['diff', 'HEAD']));
    if (violations.length > 0) {
      resetTo(repoPath, lastGood, preexisting);
      const reason = `broke a rule: ${violations.map((v) => `${v.file} ${v.reason}`).join('; ')}`;
      attempts.push({ by: 'ai', id: `ai-${number}`, category: categoryId, accepted: false, reason, sha: null, description: fixed.summary });
      info(`upgrade: AI attempt rejected (${reason})`);
      continue;
    }
    const next = await evaluate(`build-${report.builds + 1}`);
    const verdict = judge(state, next);
    if (verdict === null) {
      const subject = `upgrade(ai): ${targetFailures[0]!.category.title}`;
      const tidied = [...tidy.restored, ...tidy.tidied];
      const body =
        `Written by an AI fixer (${fixer.name}); kept because the build got further and no passing test turned red.` +
        (tidied.length > 0 ? `\nWhitespace and line-ending changes on lines it did not edit were reverted in: ${tidied.join(', ')}.` : '') +
        `\n\n${fixed.summary}`;
      const sha = commitChanges(repoPath, `${subject}\n\n${body}`, preexisting);
      if (sha) {
        report.commits.push({ sha, layer: 'ai', subject });
        lastGood = sha;
        flagCodeChangedForTests(repoPath, sha, targetFailures, report);
      }
      attempts.push({ by: 'ai', id: `ai-${number}`, category: categoryId, accepted: true, reason: 'fewer failures, no new red test', sha, description: fixed.summary });
      state = next;
    } else {
      resetTo(repoPath, lastGood, preexisting);
      attempts.push({ by: 'ai', id: `ai-${number}`, category: categoryId, accepted: false, reason: verdict, sha: null, description: fixed.summary });
      info(`upgrade: AI attempt rejected (${verdict})`);
    }
  }

  report.final = summarise(state.tests, state.log, state.result, state.diff);
  report.remaining = handoffs(state.failures, attempts);
  // Test files changed after the recipe, by a known fix or the AI: a reviewer reads these first.
  report.testFilesChanged = changedFiles(repoPath, recipeSha ?? startSha).filter((path) => /(^|\/)src\/test\//.test(path));
  if (report.baseline && report.baseline.passed === 0) {
    report.notes.push(
      'No tests ran before the upgrade, so "parity" here means only that the project builds: its behaviour after the upgrade is unverified. Review the AI fixes as unverified code.',
    );
  }
  if (outOfBudget() && !isParity(state)) {
    report.notes.push(`Stopped at the budget (${report.builds} builds, ${Math.round((now() - started) / 60000)} min).`);
  }
  // What decides the status is what causes the failures, not their consequences.
  const deciding = state.failures.filter((failure) => !failure.category.consequence);
  const status = isParity(state)
    ? 'parity'
    : deciding.length > 0 && deciding.every((failure) => failure.category.disposition === 'decision')
      ? 'needs-decision'
      : 'stuck';
  return finish(status);
}

/**
 * A fix aimed only at failing tests that changed application code is the
 * change most worth a reviewer's eye: the tests may now pass because the code
 * bent to them (dddsample: sample-data ids reset by reflection for Hibernate 7).
 */
function flagCodeChangedForTests(repoPath: string, sha: string, failures: Classified[], report: UpgradeReport): void {
  if (failures.length === 0 || failures.some((failure) => failure.build !== undefined)) return;
  const main = changedFiles(repoPath, `${sha}~1`, sha).filter((path) => /(^|\/)src\/main\//.test(path));
  if (main.length === 0) return;
  report.codeChangedForTests.push({ sha, files: main, tests: failures.flatMap((failure) => (failure.test ? [failure.test.id] : [])).slice(0, 5) });
}

function isParity(state: BuildState): boolean {
  return state.log.success && atParity(state.diff);
}

/** The failures to work on: build errors, then baseline-green tests that are red now. */
function classify(log: BuildLog, diff: TestDiff, repoPath: string | null = null): Classified[] {
  const out: Classified[] = log.failures.map((failure) => {
    // The line the compiler points at often names the problem its message
    // does not: "cannot find symbol (variable uuid)" is @Type(uuid-char.class),
    // the recipe's own invalid Java (blog-app).
    const source = repoPath !== null ? sourceLine(repoPath, failure.file, failure.line) : null;
    const text = [failure.message, failure.symbol ?? '', failure.file ?? '', ...failure.excerpt, ...(source ? [`source: ${source}`] : [])].join('\n');
    return { category: categoriseText(text), build: failure, text };
  });
  // A compiler error no rule recognises, in a file whose other errors one does,
  // is almost always the same problem seen from another line: "method does not
  // override" under a removed superclass is the security migration too.
  const byFile = new Map<string, Classified>();
  for (const failure of out) {
    if (failure.build?.file && failure.category.id !== 'uncategorised' && !byFile.has(failure.build.file)) {
      byFile.set(failure.build.file, failure);
    }
  }
  for (const failure of out) {
    const sibling = failure.build?.file ? byFile.get(failure.build.file) : undefined;
    if (failure.category.id === 'uncategorised' && sibling) failure.category = sibling.category;
  }
  for (const test of diff.regressed) {
    out.push({ category: categoriseTest(test), test, text: `${test.id}\n${test.message ?? ''}` });
  }
  // A green build that ran fewer of the baseline's passing tests is a silent
  // regression (WebGoat: the app its integration tests need did not start,
  // and Failsafe found 0 tests). Only after a successful build: a failed one
  // runs no tests and is already a failure of its own.
  if (log.success && diff.missing.length > 0) {
    const text = `stratigraph: tests did not run\n${diff.missing.length} test(s) passed at baseline and did not run: ${diff.missing.slice(0, 20).join(', ')}`;
    out.push({ category: categoriseText(text), text });
  }
  return out;
}

/**
 * How far the build got, worst first: the POM could not be read or resolved
 * (3), it did not compile or a plugin failed (2), it built and tests are red
 * or missing (1), parity (0). A fix that moves the build to a later stage is
 * progress whatever the counts: unblocking dependency resolution lets the
 * compiler run for the first time, and its errors were always there
 * (spring-boot-blog-app: one POM error became several compile errors).
 */
function stage(state: BuildState): number {
  if (!state.log.success) {
    const failures = state.log.failures;
    return failures.length === 0 || failures.some((failure) => failure.kind === 'pom' || failure.kind === 'dependency') ? 3 : 2;
  }
  return state.diff.regressed.length + state.diff.missing.length > 0 ? 1 : 0;
}

/**
 * javac refusing its own options (an error naming no file) compiles nothing;
 * once it starts, the source errors it then reports were always there
 * (kafdrop: --add-exports with --release, then springfox). Compared only
 * between builds that got equally far.
 */
function compilerRefused(state: BuildState): number {
  return state.log.failures.some((failure) => failure.kind === 'compile' && failure.file === null) ? 1 : 0;
}

function sourceLine(repoPath: string, file: string | null, line: number | null): string | null {
  if (file === null || line === null || !/\.(java|kt)$/.test(file)) return null;
  try {
    return readFileSync(join(repoPath, file), 'utf8').split('\n')[line - 1]?.trim().slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

/** javac's syntax errors: it parses every file before it resolves any name. */
const SYNTAX = /^(?:'[^']+' expected|illegal character|not a statement|unclosed |class, interface, enum,? or record expected|illegal start of|reached end of file while parsing)/;

/**
 * javac reports nothing but syntax errors until every file parses; only then
 * does it resolve names. A build down to "package x does not exist" has got
 * further than one with "';' expected", even at the same error count — and
 * javac stops at 100 errors, so the counts often tie (petclinic-reactjs: the
 * generator's escaping bug fixed, then the javax left in generated code).
 */
function syntaxErrors(state: BuildState): number {
  return state.log.failures.some((failure) => failure.kind === 'compile' && SYNTAX.test(failure.message)) ? 1 : 0;
}

/**
 * javac resolves imports before the code that uses them, and a missing
 * package stops it there: fixing the import lets it check the code, where
 * the next error may wait, one for one (petclinic-reactjs: the deleted
 * orm.hibernate5 import, then a Jackson 3 builder method).
 */
function importErrors(state: BuildState): number {
  return state.failures.some(
    (failure) =>
      failure.build?.kind === 'compile' &&
      (/^package [\w.]+ does not exist/.test(failure.build.message) || /\nsource: import /.test(failure.text)),
  )
    ? 1
    : 0;
}

function score(state: BuildState): [number, number, number, number, number, number, number] {
  // Among failing builds, the one that got further through the lifecycle is better.
  const further = state.log.success ? 0 : -state.log.goals;
  return [
    stage(state),
    further,
    compilerRefused(state),
    syntaxErrors(state),
    importErrors(state),
    state.log.failures.length,
    state.diff.regressed.length + state.diff.missing.length,
  ];
}

/** null when `next` is better than `previous`; otherwise why it is not. */
export function judge(previous: BuildState, next: BuildState): string | null {
  if (previous.log.success && next.log.success) {
    // Newly red means passing in the previous build and failing now. A test
    // that did not run before was not passing either: getting 39 skipped
    // tests to run, 34 green and 5 red, is progress (WebGoat).
    const notPassing = new Set([...previous.diff.regressed.map((test) => test.id), ...previous.diff.missing]);
    const newlyRed = next.diff.regressed.filter((test) => !notPassing.has(test.id));
    if (newlyRed.length > 0) return `turned ${newlyRed.length} passing test(s) red (${newlyRed[0]!.id})`;
  }
  const a = score(previous);
  const b = score(next);
  for (let i = 0; i < a.length; i += 1) {
    if (b[i]! < a[i]!) return null;
    if (b[i]! > a[i]!) return 'more failures than before';
  }
  return 'no fewer failures';
}

function signature(failures: Classified[]): string {
  return failures.map((failure) => failure.text.split('\n')[0]).sort().join('|');
}

function groupByCategory(failures: Classified[]): Array<[string, Classified[]]> {
  const groups = new Map<string, Classified[]>();
  for (const failure of failures) {
    const list = groups.get(failure.category.id) ?? [];
    list.push(failure);
    groups.set(failure.category.id, list);
  }
  // Build failures before test failures: nothing else can be seen until it compiles.
  return [...groups].sort(([, a], [, b]) => Number(b.some((f) => f.build)) - Number(a.some((f) => f.build)));
}

function describe(state: BuildState): string {
  if (!state.log.success) return `build fails (${state.log.failures.length} error(s))`;
  return `${state.diff.regressed.length} baseline-green test(s) red, ${state.diff.missing.length} missing`;
}

function summarise(tests: Map<string, TestResult>, log: BuildLog, result: MavenResult, diff?: TestDiff): NonNullable<UpgradeReport['baseline']> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const test of tests.values()) {
    if (test.outcome === 'passed') passed += 1;
    else if (test.outcome === 'skipped') skipped += 1;
    else failed += 1;
  }
  return {
    built: log.success,
    tests: tests.size,
    passed,
    failed,
    skipped,
    log: result.logPath,
    ...(diff
      ? {
          regressed: diff.regressed.map((test) => test.id),
          missing: diff.missing.length,
          stillFailing: diff.stillFailing.map((test) => test.id),
          fixed: diff.fixed.map((test) => test.id),
        }
      : {}),
  };
}

function handoffs(failures: Classified[], attempts: Attempt[]): UpgradeReport['remaining'] {
  return groupByCategory(failures).map(([id, group]) => {
    const category = group[0]!.category;
    return {
      category: id,
      title: category.title,
      disposition: category.disposition,
      ...(category.consequence ? { consequence: true } : {}),
      evidence: group.slice(0, 10).map((failure) =>
        failure.test
          ? { test: failure.test.id, message: failure.test.message ?? '', file: null, line: null }
          : failure.build
            ? { test: null, message: failure.build.message + (failure.build.symbol ? ` (${failure.build.symbol})` : ''), file: failure.build.file, line: failure.build.line }
            : { test: null, message: failure.text.split('\n').slice(1).join(' '), file: null, line: null },
      ),
      more: Math.max(0, group.length - 10),
      tried: attempts.filter((attempt) => attempt.category === id && !attempt.accepted),
      guidance: category.guidance,
      options: category.options ?? null,
    };
  });
}

/** A Maven project that also carries a Gradle wrapper makes the recipe try to download Gradle (gap map). */
function gradleExclusions(repoPath: string): string | null {
  const files = git(repoPath, ['ls-files', 'gradlew', 'gradlew.bat', 'gradle/wrapper']).trim();
  return files === '' ? null : 'gradle/wrapper/**,gradlew,gradlew.bat';
}
