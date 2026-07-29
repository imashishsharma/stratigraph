import { beforeEach, describe, expect, it } from 'vitest';

import {
  computeTemporalCoupling,
  CouplingError,
  type CouplingOptions,
} from '../src/analysis/coupling.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';

let db: Db;
let runId: number;
let sha = 0;

const DEFAULTS: CouplingOptions = { maxFilesPerCommit: 50, minShared: 5, minCommits: 5 };

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  runId = createRun(db, '/tmp/repo').id;
  sha = 0;
});

/**
 * Seed a commit touching a set of files, and keep `file_metric` in step —
 * coupling only pairs files that survived into it, which is ADR-0011's
 * "present at HEAD and in scope" already applied.
 */
function commit(files: string[], options: { author?: string; merge?: boolean } = {}): void {
  sha += 1;
  const commitId = Number(
    db
      .prepare(
        `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
         VALUES (?, ?, ?, ?, ?, 'subject', ?)`,
      )
      .run(
        runId,
        `sha${sha}`,
        options.author ?? 'ada',
        `${options.author ?? 'ada'}@example.invalid`,
        `2024-01-01T00:00:${String(sha).padStart(2, '0')}.000Z`,
        options.merge ? 1 : 0,
      ).lastInsertRowid,
  );
  for (const path of files) {
    db.prepare(
      `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions)
       VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(runId, commitId, path, path);
    db.prepare(
      `INSERT OR IGNORE INTO file_metric (run_id, path, commits, churn, authors)
       VALUES (?, ?, 0, 0, 0)`,
    ).run(runId, path);
  }
}

/** Commit `files` together `times` times. */
function together(files: string[], times: number): void {
  for (let i = 0; i < times; i += 1) commit(files);
}

/**
 * Unrelated single-file commits.
 *
 * Not padding. Lift compares a pair's co-changes against what chance would
 * give, and chance is measured against the whole history — so a repository in
 * which two files are the *only* files is one where they co-change with
 * certainty and the measure has nothing to say. Real repositories have a
 * background of other work, and a test without one is testing a degenerate
 * case rather than the intended one.
 */
function background(commits = 40): void {
  for (let i = 0; i < commits; i += 1) commit([`background/f${i}.java`]);
}

function pairsOf(result: ReturnType<typeof computeTemporalCoupling>) {
  return result.pairs.map((p) => `${p.pathA}+${p.pathB}`);
}

describe('computeTemporalCoupling', () => {
  it('finds a pair that always changes together', () => {
    together(['a.java', 'b.java'], 8);
    background();

    const { pairs, stats } = computeTemporalCoupling(db, runId, DEFAULTS);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      pathA: 'a.java',
      pathB: 'b.java',
      shared: 8,
      commitsA: 8,
      commitsB: 8,
      strength: 1,
      staticEdges: 0,
    });
    // 8 paired commits plus 40 background ones: single-file commits are in
    // the denominator, because they are commits that touched one file and not
    // the other.
    expect(stats).toMatchObject({ commitsConsidered: 48, stored: 1 });
  });

  it('keys a pair the same way however the commit listed its files', () => {
    // A pair counted under two keys is counted half as often as it happened.
    together(['b.java', 'a.java'], 4);
    together(['a.java', 'b.java'], 4);
    background();

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs[0]).toMatchObject({
      pathA: 'a.java',
      pathB: 'b.java',
      shared: 8,
    });
  });

  it('computes strength against the file that changes less often', () => {
    // A small config file that only ever changes alongside a big one is
    // exactly the hidden coupling worth finding, so the denominator is the
    // smaller count.
    together(['big.java', 'small.xml'], 6);
    for (let i = 0; i < 14; i += 1) commit(['big.java', `other${i}.java`]);
    background();

    const pair = computeTemporalCoupling(db, runId, DEFAULTS).pairs.find(
      (p) => p.pathB === 'small.xml',
    );
    expect(pair).toMatchObject({ shared: 6, commitsA: 20, commitsB: 6, strength: 1 });
  });

  it('excludes merge commits', () => {
    together(['a.java', 'b.java'], 4);
    for (let i = 0; i < 10; i += 1) commit(['a.java', 'b.java'], { merge: true });

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs).toEqual([]);
  });

  it('drops a sweeping commit from pairing, and says it did', () => {
    // One repo-wide change otherwise couples everything it touched. This is
    // the single most consequential filter in the whole analysis.
    const everything = Array.from({ length: 60 }, (_, i) => `f${i}.java`);
    for (let i = 0; i < 10; i += 1) commit(everything);

    const { pairs, stats } = computeTemporalCoupling(db, runId, DEFAULTS);

    expect(pairs).toEqual([]);
    expect(stats).toMatchObject({ commitsCapped: 10, commitsConsidered: 0 });
  });

  it('lets the cap through when it is raised', () => {
    const everything = Array.from({ length: 60 }, (_, i) => `f${i}.java`);
    for (let i = 0; i < 10; i += 1) commit(everything);

    const { stats } = computeTemporalCoupling(db, runId, { ...DEFAULTS, maxFilesPerCommit: 100 });
    expect(stats).toMatchObject({ commitsCapped: 0, commitsConsidered: 10 });
  });

  it('still counts a sweeping commit towards churn', () => {
    // ADR-0011 drops the pairing, not the change: the file really was changed.
    const everything = Array.from({ length: 60 }, (_, i) => `f${i}.java`);
    commit(everything);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM commit_file WHERE run_id = ?').get(runId),
    ).toEqual({ n: 60 });
  });

  it('requires a pair to co-change often enough to mean anything', () => {
    together(['a.java', 'b.java'], 4);
    // Both files clear minCommits, so only minShared can reject this.
    commit(['a.java', 'x.java']);
    commit(['b.java', 'x.java']);

    const { pairs, stats } = computeTemporalCoupling(db, runId, DEFAULTS);
    expect(pairsOf({ pairs, stats })).not.toContain('a.java+b.java');
    expect(stats.pairsBelowMinShared).toBeGreaterThan(0);
  });

  it('requires each file to have a history, not just the pair', () => {
    // Two files each changed five times, always together, is a real pair.
    // Raise the floor above that and it is no longer evidence of anything.
    together(['a.java', 'b.java'], 5);
    background();

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs).toHaveLength(1);
    expect(
      computeTemporalCoupling(db, runId, { ...DEFAULTS, minCommits: 6 }).pairs,
    ).toEqual([]);
  });

  it('rejects a pair that co-changes no more than chance', () => {
    // Two files touched in nearly every commit will share most of them by
    // coincidence. Reporting that as coupling is reporting the base rate.
    // Here a and b are each in ~half the commits and never together.
    for (let i = 0; i < 20; i += 1) commit(['a.java', 'noise.java']);
    for (let i = 0; i < 20; i += 1) commit(['b.java', 'noise.java']);
    // noise.java is in all 40; a and b are in 20 each. Expected a+noise
    // co-changes = 20*40/40 = 20, observed = 20, so lift is exactly 1.
    const { pairs, stats } = computeTemporalCoupling(db, runId, DEFAULTS);

    expect(pairsOf({ pairs, stats })).not.toContain('a.java+noise.java');
    expect(stats.pairsBelowLift).toBeGreaterThan(0);
  });

  it('keeps a pair that beats chance', () => {
    for (let i = 0; i < 6; i += 1) commit(['a.java', 'b.java']);
    for (let i = 0; i < 20; i += 1) commit(['c.java', 'd.java']);

    const pair = computeTemporalCoupling(db, runId, DEFAULTS).pairs.find(
      (p) => p.pathA === 'a.java',
    );
    expect(pair?.lift).toBeGreaterThan(1);
  });

  it('ranks by strength, not by how often the pair co-changed', () => {
    background();
    // `loose` co-changes more often in absolute terms, but each of its files
    // changes twice as often again on its own — so it is the weaker pair.
    together(['tight-a.java', 'tight-b.java'], 8);
    together(['loose-a.java', 'loose-b.java'], 12);
    for (let i = 0; i < 12; i += 1) commit(['loose-a.java', `solo-a${i}.java`]);
    for (let i = 0; i < 12; i += 1) commit(['loose-b.java', `solo-b${i}.java`]);

    const pairs = computeTemporalCoupling(db, runId, DEFAULTS).pairs;

    expect(pairs.map((p) => [p.pathA, p.strength])).toEqual([
      ['tight-a.java', 1],
      ['loose-a.java', 0.5],
    ]);
  });

  it('breaks a tie by name, so two runs produce the same order', () => {
    background();
    // Identical shape, so only the tie-break can order them.
    together(['zulu-a.java', 'zulu-b.java'], 8);
    together(['alpha-a.java', 'alpha-b.java'], 8);

    const first = computeTemporalCoupling(db, runId, DEFAULTS).pairs;
    const second = computeTemporalCoupling(db, runId, DEFAULTS).pairs;

    expect(first.map((p) => p.pathA)).toEqual(['alpha-a.java', 'zulu-a.java']);
    expect(second.map((p) => p.pathA)).toEqual(first.map((p) => p.pathA));
  });

  it('replaces its own rows rather than appending', () => {
    together(['a.java', 'b.java'], 8);
    background();

    computeTemporalCoupling(db, runId, DEFAULTS);
    computeTemporalCoupling(db, runId, DEFAULTS);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM temporal_coupling WHERE run_id = ?').get(runId),
    ).toEqual({ n: 1 });
  });

  it('stores strength but not lift, because the schema has no column for it', () => {
    together(['a.java', 'b.java'], 8);
    background();
    computeTemporalCoupling(db, runId, DEFAULTS);

    expect(
      db
        .prepare(
          'SELECT path_a, path_b, shared, commits_a, commits_b, strength, static_edges ' +
            'FROM temporal_coupling WHERE run_id = ?',
        )
        .get(runId),
    ).toEqual({
      path_a: 'a.java',
      path_b: 'b.java',
      shared: 8,
      commits_a: 8,
      commits_b: 8,
      strength: 1,
      static_edges: 0,
    });
  });

  it('refuses to run away when the settings do not fit the repository', () => {
    // A repository of very broad commits with the cap raised produces pairs
    // quadratically. Failing with advice beats being killed by the OS with
    // none, so the guard is a real error naming both knobs that would fix it.
    const wide = Array.from({ length: 200 }, (_, i) => `f${i}.java`);
    for (let i = 0; i < 6; i += 1) commit(wide);

    const runaway = () =>
      computeTemporalCoupling(db, runId, {
        maxFilesPerCommit: 1000,
        minShared: 1,
        minCommits: 1,
        maxPairs: 1000,
      });

    expect(runaway).toThrow(CouplingError);
    expect(runaway).toThrow(/history.minCommits \(now 1\)/);
    expect(runaway).toThrow(/history.maxFilesPerCommit \(now 1000\)/);
  });

  it('produces nothing on a repository with no history', () => {
    expect(computeTemporalCoupling(db, runId, DEFAULTS)).toMatchObject({
      pairs: [],
      stats: { commitsConsidered: 0, stored: 0 },
    });
  });
});

describe('static edges', () => {
  function seedFacts(facts: object[]): void {
    const writer = new SqliteFactWriter(db, runId);
    for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
    writer.close();
  }

  const meta = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

  it('counts the dependency between two coupled files', () => {
    together(['a.java', 'b.java'], 8);
    background();
    seedFacts([
      meta,
      { v: 1, type: 'file', path: 'a.java', language: 'java' },
      { v: 1, type: 'file', path: 'b.java', language: 'java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'A', name: 'A', file: 'a.java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'B', name: 'B', file: 'b.java' },
      {
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: 'A' },
        dst: { kind: 'class', fqn: 'B' },
        file: 'a.java',
        line: 3,
      },
    ]);

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs[0]?.staticEdges).toBe(1);
  });

  it('counts an edge in either direction as connecting the pair', () => {
    together(['a.java', 'b.java'], 8);
    background();
    seedFacts([
      meta,
      { v: 1, type: 'file', path: 'a.java', language: 'java' },
      { v: 1, type: 'file', path: 'b.java', language: 'java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'A', name: 'A', file: 'a.java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'B', name: 'B', file: 'b.java' },
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'class', fqn: 'B' },
        dst: { kind: 'class', fqn: 'A' },
        file: 'b.java',
        line: 9,
      },
    ]);

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs[0]?.staticEdges).toBe(1);
  });

  it('leaves a pair with no dependency at zero — the pairs M2 exists to find', () => {
    together(['OrderService.java', 'order-form.html'], 8);
    background();
    seedFacts([
      meta,
      { v: 1, type: 'file', path: 'OrderService.java', language: 'java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'OrderService', name: 'OrderService', file: 'OrderService.java' },
    ]);

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs[0]).toMatchObject({
      pathA: 'OrderService.java',
      pathB: 'order-form.html',
      staticEdges: 0,
    });
  });

  it('ignores an inferred edge, which is not an observed dependency', () => {
    together(['a.java', 'b.java'], 8);
    background();
    seedFacts([
      meta,
      { v: 1, type: 'file', path: 'a.java', language: 'java' },
      { v: 1, type: 'file', path: 'b.java', language: 'java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'A', name: 'A', file: 'a.java' },
      { v: 1, type: 'node', kind: 'class', fqn: 'B', name: 'B', file: 'b.java' },
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'class', fqn: 'A' },
        dst: { kind: 'class', fqn: 'B' },
        confidence: 'inferred',
      },
    ]);

    expect(computeTemporalCoupling(db, runId, DEFAULTS).pairs[0]?.staticEdges).toBe(0);
  });
});
