/**
 * Every test's outcome, read from the Surefire and Failsafe XML reports —
 * ADR-0047's baseline. "Red after the upgrade" means a test that passed at
 * baseline fails now; this is where both sides of that comparison come from.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type TestOutcome = 'passed' | 'failed' | 'error' | 'skipped';

export interface TestResult {
  /** `class#method`, the identity compared across runs. */
  id: string;
  outcome: TestOutcome;
  /** The failure's message and type, when it failed. */
  message: string | null;
  /** Report file it was read from, repo-relative. */
  report: string;
}

const REPORT_DIRS = new Set(['surefire-reports', 'failsafe-reports']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'src', '.idea']);

/** Every test in every report under `repoPath`'s `target/` directories. */
export function readTestReports(repoPath: string): Map<string, TestResult> {
  const results = new Map<string, TestResult>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (REPORT_DIRS.has(entry.name)) readReportDir(path, repoPath, results);
      else if (!SKIP_DIRS.has(entry.name)) walk(path, depth + 1);
    }
  };
  walk(repoPath, 0);
  return results;
}

function readReportDir(dir: string, repoPath: string, into: Map<string, TestResult>): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^TEST-.+\.xml$/.test(name)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    let xml: string;
    try {
      xml = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const result of parseReport(xml, relative(repoPath, file).split('\\').join('/'))) {
      // A test run by both plugins, or re-run: the worse outcome stands.
      const previous = into.get(result.id);
      if (previous === undefined || rank(result.outcome) > rank(previous.outcome)) into.set(result.id, result);
    }
  }
}

function rank(outcome: TestOutcome): number {
  return { skipped: 0, passed: 1, failed: 2, error: 3 }[outcome];
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

export function parseReport(xml: string, report: string): TestResult[] {
  const results: TestResult[] = [];
  for (const match of xml.matchAll(TESTCASE)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const name = attribute(attrs, 'name');
    const cls = attribute(attrs, 'classname') ?? '';
    if (name === null) continue;
    let outcome: TestOutcome = 'passed';
    let message: string | null = null;
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (problem) {
      outcome = problem[1] === 'failure' ? 'failed' : 'error';
      const type = attribute(problem[2] ?? '', 'type');
      const text = attribute(problem[2] ?? '', 'message') ?? firstLine(decode(problem[3] ?? ''));
      message = [type, text].filter(Boolean).join(': ').slice(0, 500) || null;
    } else if (/<skipped\b/.test(body)) {
      outcome = 'skipped';
    }
    results.push({ id: `${cls}#${name}`, outcome, message, report });
  }
  return results;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? decode(match[1] as string) : null;
}

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

export interface TestDiff {
  /** Passed at baseline, failed or errored now: the upgrade's to fix. */
  regressed: TestResult[];
  /** Failed at baseline and now: not the upgrade's (Docker, a browser, a network). */
  stillFailing: TestResult[];
  /** Failed at baseline, pass now. */
  fixed: TestResult[];
  /** Ran at baseline, absent now — a compile failure hides every test. */
  missing: string[];
  /** Tests that did not exist at baseline. */
  added: TestResult[];
  baselinePassed: number;
  nowPassed: number;
}

export function diffTests(baseline: Map<string, TestResult>, now: Map<string, TestResult>): TestDiff {
  const bad = (outcome: TestOutcome) => outcome === 'failed' || outcome === 'error';
  const diff: TestDiff = {
    regressed: [],
    stillFailing: [],
    fixed: [],
    missing: [],
    added: [],
    baselinePassed: 0,
    nowPassed: 0,
  };
  for (const [id, before] of baseline) {
    if (before.outcome === 'passed') diff.baselinePassed += 1;
    const after = now.get(id);
    if (after === undefined) {
      if (before.outcome === 'passed') diff.missing.push(id);
      continue;
    }
    if (before.outcome === 'passed' && bad(after.outcome)) diff.regressed.push(after);
    else if (bad(before.outcome) && bad(after.outcome)) diff.stillFailing.push(after);
    else if (bad(before.outcome) && after.outcome === 'passed') diff.fixed.push(after);
  }
  for (const [id, after] of now) {
    if (after.outcome === 'passed') diff.nowPassed += 1;
    if (!baseline.has(id)) diff.added.push(after);
  }
  diff.missing.sort();
  return diff;
}

/** Every test that passed at baseline passes now. */
export function atParity(diff: TestDiff): boolean {
  return diff.regressed.length === 0 && diff.missing.length === 0;
}
