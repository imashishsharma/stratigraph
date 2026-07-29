import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalysisError, runAnalyze } from '../src/commands/analyze.js';
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
let dbPath: string;
let db: Db;
let runId: number;
let sha = 0;
let printed: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-analyze-'));
  runInit({ repo: FIXTURE, cwd });
  dbPath = join(cwd, '.stratigraph', 'tiny-java.db');
  db = openDatabase(dbPath, { mustExist: true });
  runId = createRun(db, FIXTURE).id;
  sha = 0;

  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
});

function stdout(): string {
  return printed.join('');
}

function commit(files: string[], author = 'ada'): void {
  sha += 1;
  const commitId = Number(
    db
      .prepare(
        `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
         VALUES (?, ?, ?, ?, ?, 'subject', 0)`,
      )
      .run(
        runId,
        `sha${String(sha).padStart(3, '0')}`,
        author,
        `${author}@example.invalid`,
        `2024-01-01T00:00:${String(sha).padStart(2, '0')}.000Z`,
      ).lastInsertRowid,
  );
  for (const path of files) {
    db.prepare(
      `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions)
       VALUES (?, ?, ?, ?, 5, 5)`,
    ).run(runId, commitId, path, path);
    db.prepare(
      `INSERT OR IGNORE INTO file_metric (run_id, path, commits, churn, complexity, authors, top_author_share)
       VALUES (?, ?, 10, 100, 20, 1, 1.0)`,
    ).run(runId, path);
  }
}

function background(n = 40): void {
  for (let i = 0; i < n; i += 1) commit([`background/f${i}.java`]);
}

function seedFacts(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

const META = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

/** Two packages that depend on each other, so there is a cycle to report. */
function seedCycle(): void {
  seedFacts([
    META,
    { v: 1, type: 'file', path: 'src/a/A.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/b/B.java', language: 'java' },
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
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'b.B',
      name: 'B',
      parent: { kind: 'package', fqn: 'b' },
      file: 'src/b/B.java',
    },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'a.A' },
      dst: { kind: 'class', fqn: 'b.B' },
      file: 'src/a/A.java',
      line: 3,
    },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'b.B' },
      dst: { kind: 'class', fqn: 'a.A' },
      file: 'src/b/B.java',
      line: 3,
    },
  ]);
}

describe('runAnalyze with both facts and history', () => {
  it('reports cycles, coupling, hotspots and ownership together', () => {
    seedCycle();
    for (let i = 0; i < 8; i += 1) commit(['OrderService.java', 'order-form.html']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.cycles).toHaveLength(1);
    expect(result.coupling).toHaveLength(1);
    expect(result.hotspots.length).toBeGreaterThan(0);
    expect(result.findings).toMatchObject({ coupling: 1 });

    const out = stdout();
    expect(out).toMatch(/1 package cycle/);
    expect(out).toMatch(/Files that change together with no dependency between them/);
    expect(out).toMatch(/OrderService\.java/);
    expect(out).toMatch(/Hotspots — churn x complexity/);
  });

  it('prints the numbers a coupling claim rests on', () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    runAnalyze({ repo: FIXTURE, cwd });

    // strength, lift and both commit counts, so the reader can check the claim
    // without opening the database.
    expect(stdout()).toMatch(/8 shared commits — strength 1\.00, [\d.]+x chance \(8 and 8 commits/);
  });

  it('leaves a coupled pair with a dependency out of the report', () => {
    seedFacts([
      META,
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
        line: 1,
      },
    ]);
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.coupling).toEqual([]);
    expect(result.couplingStats?.stored).toBe(1);
    // Stored but not reported, and the report says so rather than looking empty.
    expect(stdout()).toMatch(/1 coupled pair\(s\) were found, but the static graph already/);
  });

  it('honours --top', () => {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 8; j += 1) commit([`pair${i}-a.java`, `pair${i}-b.java`]);
    }
    background();
    db.close();

    expect(runAnalyze({ repo: FIXTURE, cwd, top: 2 }).coupling).toHaveLength(2);
  });

  it('replaces its findings rather than appending across runs', () => {
    seedCycle();
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    runAnalyze({ repo: FIXTURE, cwd });
    runAnalyze({ repo: FIXTURE, cwd });

    const readback = openDatabase(dbPath, { mustExist: true, readonly: true });
    const counts = readback
      .prepare('SELECT rule, COUNT(*) AS n FROM finding GROUP BY rule ORDER BY rule')
      .all() as Array<{ rule: string; n: number }>;
    readback.close();

    // Two analyses, one set of findings. 42 files with history, capped at the
    // default top of 20 for the per-file rules.
    expect(counts).toEqual([
      { rule: 'bus-factor', n: 20 },
      { rule: 'hotspot', n: 20 },
      { rule: 'logical-coupling', n: 1 },
      { rule: 'package-cycle', n: 1 },
    ]);
  });
});

describe('runAnalyze degrading', () => {
  it('works on a run with facts and no history', () => {
    seedCycle();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.cycles).toHaveLength(1);
    expect(result.couplingStats).toBeNull();
    // Says why the section is absent, rather than omitting it silently.
    expect(stdout()).toMatch(/No history mined for this run/);
  });

  it('works on a run with history and no facts — the no-JDK case', () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.packages).toBe(0);
    expect(result.coupling).toHaveLength(1);
    // No cycle section at all, rather than "no cycles found" — which would
    // claim the static graph was checked and came back clean.
    expect(stdout()).not.toMatch(/package cycle/i);
  });

  it('does not claim "no dependency" when it never checked for one', () => {
    // With no extraction every pair has zero static edges — because nothing
    // was looked at, not because nothing connects them. Printing the usual
    // heading here would assert an absence that was never established, which
    // is the confidently-wrong failure this project exists to avoid.
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.staticGraph).toBe(false);
    expect(result.coupling[0]?.staticEdges).toBe(0);
    expect(stdout()).toMatch(/Files that change together \(top 20\)/);
    expect(stdout()).not.toMatch(/with no dependency between them/);
    expect(stdout()).toMatch(/none of these were checked for a dependency/);
  });

  it('says the same thing in the finding it stores, not only in the report', () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const { runId } = runAnalyze({ repo: FIXTURE, cwd });

    const readback = openDatabase(dbPath, { mustExist: true, readonly: true });
    const finding = readback
      .prepare(`SELECT title, detail FROM finding WHERE run_id = ? AND rule = 'logical-coupling'`)
      .get(runId) as { title: string; detail: string };
    readback.close();

    expect(finding.title).not.toMatch(/no dependency/);
    expect(finding.detail).toMatch(/no evidence was found either way/);
  });

  it('distinguishes "found nothing" from "could not look"', () => {
    // Two files that never change together. An empty section reads like a
    // clean repository unless it says what was examined.
    for (let i = 0; i < 8; i += 1) commit(['lonely-a.java']);
    for (let i = 0; i < 8; i += 1) commit(['lonely-b.java']);
    db.close();

    runAnalyze({ repo: FIXTURE, cwd });

    expect(stdout()).toMatch(/None\./);
    expect(stdout()).toMatch(/16 commits considered, 0 co-changing pairs seen/);
  });

  it('refuses a run holding neither facts nor history', () => {
    db.close();
    expect(() => runAnalyze({ repo: FIXTURE, cwd })).toThrow(AnalysisError);
    expect(() => runAnalyze({ repo: FIXTURE, cwd })).toThrow(/neither code facts nor history/);
  });

  it('refuses a store with no runs at all', () => {
    db.close();
    const empty = mkdtempSync(join(tmpdir(), 'stratigraph-analyze-'));
    runInit({ repo: FIXTURE, cwd: empty });
    expect(() => runAnalyze({ repo: FIXTURE, cwd: empty })).toThrow(/no runs in/);
  });
});

describe('runAnalyze thresholds', () => {
  it('takes maxFilesPerCommit from the config file', () => {
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({ history: { maxFilesPerCommit: 2 } }),
    );
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java', 'c.java']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd });

    expect(result.couplingStats).toMatchObject({ commitsCapped: 8 });
    expect(result.coupling).toEqual([]);
  });

  it('lets --max-files-per-commit win over the config file', () => {
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({ history: { maxFilesPerCommit: 2 } }),
    );
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java', 'c.java']);
    background();
    db.close();

    const result = runAnalyze({ repo: FIXTURE, cwd, maxFilesPerCommit: 10 });

    expect(result.couplingStats).toMatchObject({ commitsCapped: 0 });
    expect(result.coupling).toHaveLength(3);
  });
});
