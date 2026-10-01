/**
 * The upgrade report — ADR-0047: what happened, in layers a reviewer can
 * trust differently, and for everything left, a handoff someone can act on.
 *
 * Written as `upgrade-report.md` (for people) and `upgrade-report.json` (for
 * tools and the benchmark) at the repository root, in the branch's last
 * commit. Every claim points at a commit, a test, a file:line or a log.
 * What a model wrote is labelled as such.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Disposition } from './categories.js';
import { commitChanges } from './git.js';

export interface Attempt {
  by: 'known-fix' | 'ai';
  id: string;
  category: string;
  accepted: boolean;
  reason: string;
  sha: string | null;
  /** For the AI: its own summary, authored by a model. */
  description: string;
}

export interface BuildSummary {
  built: boolean;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  log: string;
  regressed?: string[];
  missing?: number;
  stillFailing?: string[];
  fixed?: string[];
}

export interface Handoff {
  category: string;
  title: string;
  disposition: Disposition;
  evidence: Array<{ test: string | null; message: string; file: string | null; line: number | null }>;
  more: number;
  tried: Attempt[];
  guidance: string;
  options: string[] | null;
}

export interface UpgradeReport {
  status: 'parity' | 'needs-decision' | 'stuck' | 'baseline-broken' | 'recipe-failed';
  from: string;
  to: string;
  recipe: string;
  rewriteSpring: string;
  branch: string;
  startBranch: string;
  startSha: string;
  logDir: string;
  ai: string | null;
  baseline: BuildSummary | null;
  final: BuildSummary | null;
  commits: Array<{ sha: string; layer: 'recipe' | 'known-fix' | 'ai' | 'report'; subject: string }>;
  attempts: Attempt[];
  remaining: Handoff[];
  testFilesChanged: string[];
  builds: number;
  minutes: number;
  costUsd: number;
  notes: string[];
}

export const REPORT_MD = 'upgrade-report.md';
export const REPORT_JSON = 'upgrade-report.json';

/** Write both files and commit them; returns the commit sha. */
export function writeReport(repoPath: string, report: UpgradeReport, preexisting: Set<string>): string | null {
  writeFileSync(join(repoPath, REPORT_JSON), `${JSON.stringify({ format: 'stratigraph-upgrade/1', ...report }, null, 2)}\n`);
  writeFileSync(join(repoPath, REPORT_MD), renderReport(report));
  return commitChanges(repoPath, `upgrade: report (${report.status})`, preexisting);
}

const HEADLINE: Record<UpgradeReport['status'], string> = {
  parity: '✅ Every test that passed before the upgrade passes after it.',
  'needs-decision': '🟡 Stopped: what is left needs a decision only a person should make.',
  stuck: '🔴 Stopped: failures remain that the automatic fixes could not resolve.',
  'baseline-broken': '⛔ Not started: the project does not build before the upgrade.',
  'recipe-failed': '⛔ The OpenRewrite recipe itself failed.',
};

export function renderReport(report: UpgradeReport): string {
  const out: string[] = [];
  const short = (sha: string) => sha.slice(0, 10);
  out.push(`# Spring Boot ${report.from} → ${report.to}: upgrade report`, '');
  out.push(`**${HEADLINE[report.status]}**`, '');
  out.push(
    `Branch \`${report.branch}\`, started from \`${report.startBranch}\` at \`${short(report.startSha)}\`. ` +
      `${report.builds} build(s), ${report.minutes} min` +
      (report.ai ? `, AI fixer: ${report.ai}${report.costUsd > 0 ? ` ($${report.costUsd.toFixed(2)})` : ''}` : ', no AI fixer') +
      '.',
    '',
  );

  if (report.baseline) {
    out.push('## Tests against the baseline', '');
    out.push('| | Built | Tests | Passed | Failed | Skipped |', '|---|---|---|---|---|---|');
    const row = (name: string, s: BuildSummary) => `| ${name} | ${s.built ? 'yes' : 'no'} | ${s.tests} | ${s.passed} | ${s.failed} | ${s.skipped} |`;
    out.push(row('Before (baseline)', report.baseline));
    if (report.final) out.push(row('After', report.final));
    out.push('');
    if (report.final) {
      const regressed = report.final.regressed ?? [];
      out.push(`- **Passed before, fail now:** ${regressed.length === 0 ? 'none' : regressed.length}`);
      for (const id of regressed.slice(0, 20)) out.push(`  - \`${id}\``);
      if ((report.final.missing ?? 0) > 0) {
        out.push(
          `- **Passed before, did not run now:** ${report.final.missing} ` +
            (report.final.built ? '(the build succeeded, but these tests were not run)' : '(the build failed before running them)'),
        );
      }
      const still = report.final.stillFailing ?? [];
      if (still.length > 0) {
        out.push(`- **Failed before and still fail** (not the upgrade's; e.g. they need Docker or a network): ${still.length}`);
      }
      const fixed = report.final.fixed ?? [];
      if (fixed.length > 0) out.push(`- **Failed before, pass now:** ${fixed.length}`);
      out.push('');
    }
  }

  const decisions = report.remaining.filter((handoff) => handoff.disposition === 'decision');
  const unresolved = report.remaining.filter((handoff) => handoff.disposition !== 'decision');
  if (decisions.length > 0) {
    out.push('## Needs your decision', '');
    out.push('Each of these can be fixed several ways, and the ways differ in behaviour. Nothing was attempted; pick one.', '');
    for (const handoff of decisions) out.push(...renderHandoff(handoff), '');
  }
  if (unresolved.length > 0) {
    out.push('## Could not be fixed automatically', '');
    for (const handoff of unresolved) out.push(...renderHandoff(handoff), '');
  }

  out.push('## What changed, layer by layer', '');
  out.push('Review each layer on its own terms: the recipe is OpenRewrite\'s, the known fixes are exact repairs, the AI fixes were written by a model and kept only because the build improved.', '');
  const layers: Array<[UpgradeReport['commits'][number]['layer'], string]> = [
    ['recipe', 'Recipe'],
    ['known-fix', 'Known fixes'],
    ['ai', 'AI fixes (authored by a model)'],
  ];
  for (const [layer, title] of layers) {
    const commits = report.commits.filter((commit) => commit.layer === layer);
    out.push(`**${title}:** ${commits.length === 0 ? 'none' : ''}`);
    for (const commit of commits) out.push(`- \`${short(commit.sha)}\` ${commit.subject}`);
    out.push('');
  }
  if (report.testFilesChanged.length > 0) {
    out.push('**Test files changed after the recipe (read these first):**');
    for (const path of report.testFilesChanged) out.push(`- \`${path}\``);
    out.push('');
  }

  const rejected = report.attempts.filter((attempt) => !attempt.accepted);
  if (rejected.length > 0) {
    out.push('## Attempts that were rejected', '');
    for (const attempt of rejected) {
      out.push(`- ${attempt.by === 'ai' ? 'AI' : 'Known fix'} \`${attempt.id}\` on ${attempt.category}: ${attempt.reason}`);
    }
    out.push('');
  }

  if (report.notes.length > 0) {
    out.push('## Notes', '');
    for (const note of report.notes) out.push(`- ${note}`);
    out.push('');
  }
  out.push('---', '');
  out.push(
    `Recipe \`${report.recipe}\` (rewrite-spring ${report.rewriteSpring}). Full build logs: \`${report.logDir}\`. ` +
      'Generated by `stratigraph upgrade run`.',
    '',
  );
  return out.join('\n');
}

function renderHandoff(handoff: Handoff): string[] {
  const out = [`### ${handoff.title} \`${handoff.category}\``, ''];
  out.push('**Evidence:**');
  for (const item of handoff.evidence) {
    if (item.test) out.push(`- test \`${item.test}\`: ${oneLine(item.message)}`);
    else out.push(`- ${item.file ? `\`${item.file}${item.line ? `:${item.line}` : ''}\`` : '(build)'}: ${oneLine(item.message)}`);
  }
  if (handoff.more > 0) out.push(`- …and ${handoff.more} more like these`);
  out.push('');
  if (handoff.options) {
    out.push('**Options:**');
    handoff.options.forEach((option, i) => out.push(`${i + 1}. ${option}`));
    out.push('');
  } else {
    out.push(`**What usually fixes it:** ${handoff.guidance}`, '');
  }
  if (handoff.tried.length > 0) {
    out.push('**Already tried:**');
    for (const attempt of handoff.tried) {
      out.push(`- ${attempt.by === 'ai' ? 'AI' : 'known fix'} \`${attempt.id}\`: rejected, ${attempt.reason}`);
      if (attempt.by === 'ai' && attempt.description) out.push(`  - the fixer said (model-written): ${oneLine(attempt.description).slice(0, 400)}`);
    }
  }
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
