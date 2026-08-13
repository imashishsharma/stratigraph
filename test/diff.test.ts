import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diffRuns, identity } from '../src/analysis/diff.js';
import { DiffError, runDiff } from '../src/commands/diff.js';
import { GateError } from '../src/commands/analyze.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-diff-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
});

/** One run holding two packages and the named findings, each cited. */
function run(findings: Array<{ rule: string; title: string; severity: string }>): number {
  const runId = createRun(db, FIXTURE).id;
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of [
    { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' },
    { v: 1, type: 'file', path: 'src/a/A.java', language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
    { v: 1, type: 'node', kind: 'package', fqn: 'b', name: 'b' },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'a.A',
      name: 'A',
      parent: { kind: 'package', fqn: 'a' },
      file: 'src/a/A.java',
    },
    { v: 1, type: 'node', kind: 'class', fqn: 'b.B', name: 'B', parent: { kind: 'package', fqn: 'b' } },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'a.A' },
      dst: { kind: 'class', fqn: 'b.B' },
      file: 'src/a/A.java',
      line: 3,
    },
  ]) {
    writer.write(parseFact(JSON.stringify(fact)) as Fact);
  }
  writer.close();

  const edgeId = (db.prepare('SELECT id FROM edge WHERE run_id = ? LIMIT 1').get(runId) as {
    id: number;
  }).id;
  for (const item of findings) {
    const id = Number(
      db
        .prepare(
          `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
           VALUES (?, ?, ?, 'detail', ?, 'algorithm')`,
        )
        .run(runId, item.rule, item.title, item.severity).lastInsertRowid,
    );
    db.prepare(`INSERT INTO citation (finding_id, kind, edge_id) VALUES (?, 'edge', ?)`).run(
      id,
      edgeId,
    );
  }
  return runId;
}

const CYCLE = { rule: 'package-cycle', title: 'Package cycle: a ⇄ b', severity: 'high' };
const HOTSPOT = { rule: 'hotspot', title: 'src/a/A.java is changed often', severity: 'medium' };

describe('diffing two runs', () => {
  it('reports a finding that appeared as added', () => {
    const from = run([HOTSPOT]);
    const to = run([HOTSPOT, CYCLE]);

    const result = diffRuns(db, from, to);
    expect(result.findings.added.map((f) => f.title)).toEqual([CYCLE.title]);
    expect(result.findings.resolved).toEqual([]);
    expect(result.findings.unchanged).toBe(1);
  });

  it('reports a finding that went away as resolved', () => {
    const from = run([HOTSPOT, CYCLE]);
    const to = run([HOTSPOT]);

    const result = diffRuns(db, from, to);
    expect(result.findings.resolved.map((f) => f.title)).toEqual([CYCLE.title]);
    expect(result.findings.added).toEqual([]);
  });

  it('calls nothing changed when nothing changed', () => {
    const from = run([HOTSPOT, CYCLE]);
    const to = run([HOTSPOT, CYCLE]);

    const result = diffRuns(db, from, to);
    expect(result.findings.added).toEqual([]);
    expect(result.findings.resolved).toEqual([]);
    expect(result.findings.unchanged).toBe(2);
  });

  it('counts what was added and resolved by severity, strongest first', () => {
    const from = run([]);
    const to = run([CYCLE, HOTSPOT, { ...CYCLE, title: 'Package cycle: c ⇄ d' }]);

    expect(diffRuns(db, from, to).findings.addedBySeverity).toEqual([
      { severity: 'high', count: 2 },
      { severity: 'medium', count: 1 },
    ]);
  });

  it('ignores a finding nothing can check, exactly as the report does', () => {
    const from = run([]);
    const to = run([]);
    db.prepare(
      `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
       VALUES (?, 'package-cycle', 'uncited', 'd', 'high', 'algorithm')`,
    ).run(to);

    // ADR-0021: a build must not regress on a claim no output will show.
    expect(diffRuns(db, from, to).findings.added).toEqual([]);
  });

  it('tracks the structural counts either way', () => {
    const from = run([]);
    const to = run([]);
    const result = diffRuns(db, from, to);
    expect(result.counts.packages).toEqual({ from: 2, to: 2, delta: 0 });
    expect(result.counts.types).toEqual({ from: 2, to: 2, delta: 0 });
  });

  it('notices two runs taken from different repositories', () => {
    const from = run([]);
    const to = createRun(db, '/somewhere/else').id;
    expect(diffRuns(db, from, to).differentRepo).toBe(true);
  });
});

describe('recognising the same finding twice', () => {
  it('treats a cycle as the same cycle when the shortest path rotates', () => {
    // The title names the shortest path through a component, and that path can
    // rotate when an unrelated edge appears. Same three packages, same cycle.
    const before = {
      rule: 'package-cycle',
      ruleTitle: 'package-cycle',
      title: 'Package cycle across 3 packages: a → b → c → a',
      severity: 'high',
      authoredBy: 'algorithm',
    };
    const after = { ...before, title: 'Package cycle across 3 packages: b → c → a → b' };

    expect(identity(before)).toBe(identity(after));
  });

  it('keeps two genuinely different cycles apart', () => {
    const one = {
      rule: 'package-cycle',
      ruleTitle: 'package-cycle',
      title: 'Package cycle: a ⇄ b',
      severity: 'high',
      authoredBy: 'algorithm',
    };
    const two = { ...one, title: 'Package cycle: a ⇄ c' };
    expect(identity(one)).not.toBe(identity(two));
  });

  it('falls back to the whole title for every other rule', () => {
    const hotspot = {
      rule: 'hotspot',
      ruleTitle: 'hotspot',
      title: 'src/a/A.java is changed often',
      severity: 'medium',
      authoredBy: 'algorithm',
    };
    expect(identity(hotspot)).toBe('hotspot src/a/A.java is changed often');
  });

  it('falls back rather than throwing when a cycle title stops matching', () => {
    // If cycles.ts changes its wording, the diff gets noisier and stays
    // correct. This is the test that fails first when that happens.
    const odd = {
      rule: 'package-cycle',
      ruleTitle: 'package-cycle',
      title: 'something else entirely',
      severity: 'high',
      authoredBy: 'algorithm',
    };
    expect(identity(odd)).toBe('package-cycle something else entirely');
  });
});

describe('the diff command', () => {
  function diff(options: { from?: number; to?: number; failOnNew?: 'high' | 'medium' } = {}) {
    return runDiff({ repo: FIXTURE, cwd, ...options });
  }

  it('defaults to the two most recent analysed runs', () => {
    const first = run([HOTSPOT]);
    const second = run([HOTSPOT, CYCLE]);

    const result = diff();
    expect(result.from.id).toBe(first);
    expect(result.to.id).toBe(second);
  });

  it('skips a bare extract when picking the default runs', () => {
    // `extract` opens a run with no findings. Defaulting to it would compare
    // the latest analysis against nothing and call every finding resolved.
    const first = run([HOTSPOT]);
    const second = run([CYCLE]);
    createRun(db, FIXTURE); // a bare extract, never analysed

    const result = diff();
    expect(result.from.id).toBe(first);
    expect(result.to.id).toBe(second);
  });

  it('refuses to compare against a run nobody analysed', () => {
    const first = run([HOTSPOT]);
    const bare = createRun(db, FIXTURE).id;
    expect(() => diff({ from: first, to: bare })).toThrow(DiffError);
    expect(() => diff({ from: first, to: bare })).toThrow(/no analysis output/);
  });

  it('refuses a diff read backwards', () => {
    const first = run([HOTSPOT]);
    const second = run([CYCLE]);
    expect(() => diff({ from: second, to: first })).toThrow(/every fix as a regression/);
  });

  it('says so when there is only one run to compare', () => {
    run([HOTSPOT]);
    expect(() => diff()).toThrow(/only one analysed run/);
  });

  it('exits through GateError when something new is severe enough', () => {
    run([HOTSPOT]);
    run([HOTSPOT, CYCLE]);
    expect(() => diff({ failOnNew: 'high' })).toThrow(GateError);
    expect(() => diff({ failOnNew: 'high' })).toThrow(/1 new finding\(s\) at or above `high`/);
  });

  it('stays silent about debt that was already there', () => {
    // The whole reason this gate exists: a legacy repository full of high
    // findings can adopt it on day one, because only regressions fail.
    run([CYCLE, { ...CYCLE, title: 'Package cycle: c ⇄ d' }]);
    run([CYCLE, { ...CYCLE, title: 'Package cycle: c ⇄ d' }]);
    expect(() => diff({ failOnNew: 'high' })).not.toThrow();
  });

  it('does not fail a build for fixing something', () => {
    run([CYCLE, HOTSPOT]);
    run([HOTSPOT]);
    expect(() => diff({ failOnNew: 'high' })).not.toThrow();
  });
});
