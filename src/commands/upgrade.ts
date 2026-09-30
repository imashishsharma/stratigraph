/**
 * `stratigraph upgrade plan|run` — ADR-0047.
 */

import { dirname, resolve } from 'node:path';

import { info, print, warn } from '../log.js';
import { discoverJavaRuntimes, inspectJavaHome, type JavaRuntime } from '../toolchain/java.js';
import { claudeCodeFixer } from '../upgrade/fixer.js';
import { runUpgrade, UpgradeError } from '../upgrade/loop.js';
import { createMaven } from '../upgrade/maven.js';
import { javaMajor, readPom } from '../upgrade/pom.js';
import { REPORT_MD, type UpgradeReport } from '../upgrade/report.js';
import { planUpgrade, renderPlan, type Plan } from '../upgrade/survey.js';
import { TARGETS, type UpgradeTarget } from '../upgrade/targets.js';
import { chooseJdks } from '../upgrade/maven.js';

export { UpgradeError };

export interface UpgradeCommandOptions {
  repo?: string | undefined;
  to: string;
  javaHome?: string | undefined;
  baselineJavaHome?: string | undefined;
  mavenArgs?: string | undefined;
}

export interface UpgradeRunOptions extends UpgradeCommandOptions {
  ai?: string | undefined;
  maxBuilds?: number | undefined;
  maxMinutes?: number | undefined;
  attemptsPerCategory?: number | undefined;
  aiBudgetUsd?: number | undefined;
  aiModel?: string | undefined;
  branch?: string | undefined;
  buildTimeoutMinutes?: number | undefined;
  rewriteSpring?: string | undefined;
  rewritePlugin?: string | undefined;
}

function target(to: string): UpgradeTarget {
  const found = TARGETS[to];
  if (!found) throw new UpgradeError(`unknown target "${to}"; supported: ${Object.keys(TARGETS).join(', ')}`);
  return found;
}

function runtimeAt(home: string): JavaRuntime {
  const runtime = inspectJavaHome(resolve(home), 'config');
  if (!runtime) throw new UpgradeError(`no JDK at ${home}`);
  return runtime;
}

function homeOf(runtime: JavaRuntime): string {
  return runtime.home ?? dirname(dirname(runtime.javaBin));
}

export function runUpgradePlan(options: UpgradeCommandOptions): Plan {
  const repoPath = resolve(options.repo ?? '.');
  const plan = planUpgrade(repoPath, target(options.to));
  print(renderPlan(plan));
  return plan;
}

export async function runUpgradeRun(options: UpgradeRunOptions): Promise<UpgradeReport> {
  const repoPath = resolve(options.repo ?? '.');
  const upgradeTarget = target(options.to);
  const pom = readPom(repoPath);
  const runtimes = discoverJavaRuntimes();
  const choice = chooseJdks(javaMajor(pom?.javaVersion ?? null), upgradeTarget.minJava, runtimes);
  const baselineJdk = options.baselineJavaHome ? runtimeAt(options.baselineJavaHome) : choice.baseline;
  const targetJdk = options.javaHome ? runtimeAt(options.javaHome) : choice.target;
  if (baselineJdk === null || targetJdk === null) throw new UpgradeError(choice.notes.join('; '));
  if (targetJdk.major < upgradeTarget.minJava) {
    throw new UpgradeError(`Spring Boot ${upgradeTarget.boot} needs JDK ${upgradeTarget.minJava}+; ${targetJdk.version} was given.`);
  }
  if (options.ai !== undefined && options.ai !== 'claude-code') {
    throw new UpgradeError(`unknown --ai "${options.ai}"; supported: claude-code`);
  }

  const mavenArgs = (options.mavenArgs ?? '').split(/\s+/).filter(Boolean);
  const timeoutMs = (options.buildTimeoutMinutes ?? 30) * 60000;

  warn(
    'upgrade: this builds the project. Maven will download the OpenRewrite plugin and the dependencies of the ' +
      'new versions. Work happens on a new branch; nothing is pushed.',
  );
  if (options.ai === 'claude-code') {
    warn(
      'upgrade: --ai claude-code: the Claude Code CLI will read and edit this repository\'s source under your ' +
        'Claude account. Source code leaves this machine for the model. Every change it makes is rebuilt and ' +
        'kept only if the build improves.',
    );
  }
  info(`upgrade: baseline on JDK ${baselineJdk.version}, upgrade on JDK ${targetJdk.version}`);

  const report = await runUpgrade({
    repoPath,
    target: upgradeTarget,
    baselineMaven: (logDir) => createMaven({ repoPath, javaHome: homeOf(baselineJdk), logDir, extraArgs: mavenArgs, timeoutMs }),
    targetMaven: (logDir) => createMaven({ repoPath, javaHome: homeOf(targetJdk), logDir, extraArgs: mavenArgs, timeoutMs }),
    targetJavaHome: homeOf(targetJdk),
    mavenArgs,
    fixer:
      options.ai === 'claude-code'
        ? claudeCodeFixer({
            maxBudgetUsd: options.aiBudgetUsd ?? 5,
            timeoutMs: 30 * 60000,
            model: options.aiModel,
          })
        : null,
    maxBuilds: options.maxBuilds ?? 25,
    maxMinutes: options.maxMinutes ?? 180,
    attemptsPerCategory: options.attemptsPerCategory ?? 2,
    branch: options.branch,
    rewriteSpring: options.rewriteSpring,
    rewritePlugin: options.rewritePlugin,
  });

  print('');
  print(`upgrade: ${report.status} — see ${REPORT_MD} on branch ${report.branch}`);
  if (report.final) {
    print(
      `  tests: ${report.final.passed}/${report.final.tests} pass (baseline ${report.baseline?.passed}/${report.baseline?.tests}); ` +
        `${report.final.regressed?.length ?? 0} passed before and fail now`,
    );
  }
  const decisions = report.remaining.filter((handoff) => handoff.disposition === 'decision').length;
  const unresolved = report.remaining.length - decisions;
  if (decisions > 0) print(`  ${decisions} decision(s) for you, with options, in the report`);
  if (unresolved > 0) print(`  ${unresolved} failure group(s) the automatic fixes could not resolve`);
  print(`  commits: ${report.commits.map((commit) => `${commit.layer} ${commit.sha.slice(0, 8)}`).join(', ')}`);
  return report;
}
