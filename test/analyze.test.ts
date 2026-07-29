import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalysisError, runAnalyze } from '../src/commands/analyze.js';
import type { ModelClient } from '../src/interpret/client.js';
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

/**
 * No test here may reach a model API. Tests that exercise interpretation inject
 * a client; every other test must find no credential, whatever the developer
 * running them happens to have exported.
 */
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-analyze-'));
  savedEnv = { ...process.env };
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  process.env['ANTHROPIC_CONFIG_DIR'] = join(cwd, 'no-credentials');
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
  process.env = savedEnv;
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
  it('reports cycles, coupling, hotspots and ownership together', async () => {
    seedCycle();
    for (let i = 0; i < 8; i += 1) commit(['OrderService.java', 'order-form.html']);
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

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

  it('prints the numbers a coupling claim rests on', async () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    await runAnalyze({ repo: FIXTURE, cwd });

    // strength, lift and both commit counts, so the reader can check the claim
    // without opening the database.
    expect(stdout()).toMatch(/8 shared commits — strength 1\.00, [\d.]+x chance \(8 and 8 commits/);
  });

  it('leaves a coupled pair with a dependency out of the report', async () => {
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

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.coupling).toEqual([]);
    expect(result.couplingStats?.stored).toBe(1);
    // Stored but not reported, and the report says so rather than looking empty.
    expect(stdout()).toMatch(/1 coupled pair\(s\) were found, but the static graph already/);
  });

  it('honours --top', async () => {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 8; j += 1) commit([`pair${i}-a.java`, `pair${i}-b.java`]);
    }
    background();
    db.close();

    expect((await runAnalyze({ repo: FIXTURE, cwd, top: 2 })).coupling).toHaveLength(2);
    // Showing 2 of 6 and saying nothing reads as "there are 2".
    expect(stdout()).toMatch(/Showing 2 of 6 pairs with no static dependency/);
  });

  it('counts pairs the static graph explains, not pairs it did not print', async () => {
    // The obvious arithmetic — stored minus shown — attributes every pair
    // beyond --top to "already has a dependency". On dubbo that turned 10
    // shown out of 4139 into a claim that 4129 were explained by imports.
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
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 8; j += 1) commit([`free${i}-a.java`, `free${i}-b.java`]);
    }
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, top: 1 });

    expect(result.couplingStats).toMatchObject({ stored: 4, withStaticDependency: 1 });
    expect(stdout()).toMatch(/Showing 1 of 3 pairs with no static dependency/);
    expect(stdout()).toMatch(/4 coupled pairs stored in total; 1 of them already/);
  });

  it('replaces its findings rather than appending across runs', async () => {
    seedCycle();
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    await runAnalyze({ repo: FIXTURE, cwd });
    await runAnalyze({ repo: FIXTURE, cwd });

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
  it('works on a run with facts and no history', async () => {
    seedCycle();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.cycles).toHaveLength(1);
    expect(result.couplingStats).toBeNull();
    // Says why the section is absent, rather than omitting it silently.
    expect(stdout()).toMatch(/No history mined for this run/);
  });

  it('works on a run with history and no facts — the no-JDK case', async () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.packages).toBe(0);
    expect(result.coupling).toHaveLength(1);
    // No cycle section at all, rather than "no cycles found" — which would
    // claim the static graph was checked and came back clean.
    expect(stdout()).not.toMatch(/package cycle/i);
  });

  it('does not claim "no dependency" when it never checked for one', async () => {
    // With no extraction every pair has zero static edges — because nothing
    // was looked at, not because nothing connects them. Printing the usual
    // heading here would assert an absence that was never established, which
    // is the confidently-wrong failure this project exists to avoid.
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.staticGraph).toBe(false);
    expect(result.coupling[0]?.staticEdges).toBe(0);
    expect(stdout()).toMatch(/Files that change together \(top 20\)/);
    expect(stdout()).not.toMatch(/with no dependency between them/);
    expect(stdout()).toMatch(/none of these were checked for a dependency/);
  });

  it('says the same thing in the finding it stores, not only in the report', async () => {
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java']);
    background();
    db.close();

    const { runId } = await runAnalyze({ repo: FIXTURE, cwd });

    const readback = openDatabase(dbPath, { mustExist: true, readonly: true });
    const finding = readback
      .prepare(`SELECT title, detail FROM finding WHERE run_id = ? AND rule = 'logical-coupling'`)
      .get(runId) as { title: string; detail: string };
    readback.close();

    expect(finding.title).not.toMatch(/no dependency/);
    expect(finding.detail).toMatch(/no evidence was found either way/);
  });

  it('distinguishes "found nothing" from "could not look"', async () => {
    // Two files that never change together. An empty section reads like a
    // clean repository unless it says what was examined.
    for (let i = 0; i < 8; i += 1) commit(['lonely-a.java']);
    for (let i = 0; i < 8; i += 1) commit(['lonely-b.java']);
    db.close();

    await runAnalyze({ repo: FIXTURE, cwd });

    expect(stdout()).toMatch(/None\./);
    expect(stdout()).toMatch(/16 commits considered, 0 co-changing pairs seen/);
  });

  it('refuses a run holding neither facts nor history', async () => {
    db.close();
    await expect(runAnalyze({ repo: FIXTURE, cwd })).rejects.toThrow(AnalysisError);
    await expect(runAnalyze({ repo: FIXTURE, cwd })).rejects.toThrow(/neither code facts nor history/);
  });

  it('refuses a store with no runs at all', async () => {
    db.close();
    const empty = mkdtempSync(join(tmpdir(), 'stratigraph-analyze-'));
    runInit({ repo: FIXTURE, cwd: empty });
    await expect(runAnalyze({ repo: FIXTURE, cwd: empty })).rejects.toThrow(/no runs in/);
  });
});

describe('runAnalyze thresholds', () => {
  it('takes maxFilesPerCommit from the config file', async () => {
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({ history: { maxFilesPerCommit: 2 } }),
    );
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java', 'c.java']);
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.couplingStats).toMatchObject({ commitsCapped: 8 });
    expect(result.coupling).toEqual([]);
  });

  it('lets --max-files-per-commit win over the config file', async () => {
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({ history: { maxFilesPerCommit: 2 } }),
    );
    for (let i = 0; i < 8; i += 1) commit(['a.java', 'b.java', 'c.java']);
    background();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, maxFilesPerCommit: 10 });

    expect(result.couplingStats).toMatchObject({ commitsCapped: 0 });
    expect(result.coupling).toHaveLength(3);
  });
});

/** Two groups of three packages, plus a stray named with one and wired to the other. */
function seedTwoGroups(): void {
    const path = (pkg: string) => `src/${pkg.replaceAll('.', '/')}/A.java`;
    const declare = (pkg: string) => [
      { v: 1, type: 'file', path: path(pkg), language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: pkg, name: pkg },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: `${pkg}.A`,
        name: 'A',
        parent: { kind: 'package', fqn: pkg },
        file: path(pkg),
      },
    ];
    const link = (from: string, to: string, line: number) => ({
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: `${from}.A` },
      dst: { kind: 'class', fqn: `${to}.A` },
      file: path(from),
      line,
    });
    const clique = (packages: string[], start: number) => {
      const out: object[] = [];
      let line = start;
      for (let i = 0; i < packages.length; i += 1) {
        for (let j = i + 1; j < packages.length; j += 1) {
          out.push(link(packages[i] as string, packages[j] as string, line));
          line += 1;
        }
      }
      return out;
    };

    const billing = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
    const admin = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];
    seedFacts([
      META,
      ...[...billing, ...admin, 'shop.billing.report'].flatMap(declare),
      ...clique(billing, 1),
      ...clique(admin, 100),
      ...clique(['shop.billing.report', ...admin], 200),
    ]);
  }

describe('runAnalyze clustering', () => {
  it('clusters and reports mismatches with no model involved', async () => {
    seedTwoGroups();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, llm: false });

    expect(result.clusters?.clusters).toHaveLength(2);
    expect(result.mismatches.map((mismatch) => mismatch.fqn)).toEqual([
      'shop.billing.report',
    ]);

    const out = stdout();
    expect(out).toContain('2 package clusters');
    expect(out).toContain('coupling weight 1');
    expect(out).toContain('Packages whose name and edges disagree');
    expect(out).toContain('shop.billing.report is named under shop.billing');
    expect(out).toContain('Interpretation is off (--no-llm)');
    expect(result.interpretation).toBeNull();
    expect(result.interpretationSkipped).toBe('disabled');
  });

  it('honours --coupling-weight 0, which clusters on structure alone', async () => {
    seedTwoGroups();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, llm: false, couplingWeight: 0 });

    expect(stdout()).toContain('coupling weight 0');
    expect(result.clusters?.clusters).toHaveLength(2);
  });

  it('says plainly that a history-only run has nothing to cluster', async () => {
    commit(['a.java', 'b.java']);
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, llm: false });

    expect(result.clusters).toBeNull();
    expect(result.mismatches).toEqual([]);
    // No partition is printed, invented or otherwise.
    expect(stdout()).not.toContain('package clusters');
  });
});

describe('runAnalyze interpretation', () => {
  /** Answers whatever the pack asked, citing its first item. */
  function client(): ModelClient & { calls: number } {
    return {
      calls: 0,
      async complete(request) {
        this.calls += 1;
        const id = /\n {2}(n1) {2}/.exec(request.prompt)?.[1] ?? 'n1';
        return {
          model: 'claude-opus-5',
          refusal: null,
          output: {
            name: 'Order handling',
            responsibility: [{ text: 'Groups packages that reference each other.', cites: [id] }],
            mismatch: null,
            adrCandidates: [
              {
                title: 'These packages form one unit',
                decision: { text: 'They reference each other directly.', cites: [id] },
                evidence: { text: 'The edges connect them.', cites: [id] },
                question: 'Was this grouping intended?',
              },
            ],
          },
        };
      },
    };
  }

  it('names clusters and prints ADR candidates, marked as inference', async () => {
    seedTwoGroups();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd, client: client() });

    expect(result.interpretation?.described).toBe(2);
    expect(result.adrCandidates).toHaveLength(2);
    expect(result.clusters?.clusters.every((c) => c.name === 'Order handling')).toBe(true);

    const out = stdout();
    expect(out).toContain('Order handling (');
    expect(out).toContain('Interpretation by claude-opus-5 — 2 of 2 clusters described.');
    expect(out).toContain('Names and descriptions above this line are inference, not observation.');
    expect(out).toContain('ADR candidates (2) — proposals, not findings:');
    expect(out).toContain('Question for the team: Was this grouping intended?');
  });

  it('reports rejected descriptions rather than quietly dropping them', async () => {
    seedTwoGroups();
    db.close();

    const liar: ModelClient = {
      async complete() {
        return {
          model: 'claude-opus-5',
          refusal: null,
          output: {
            name: 'Order handling',
            responsibility: [
              { text: 'com.invented.Thing does the work.', cites: ['n1'] },
            ],
            mismatch: null,
            adrCandidates: [],
          },
        };
      },
    };

    const result = await runAnalyze({ repo: FIXTURE, cwd, client: liar });

    expect(result.interpretation?.described).toBe(0);
    expect(result.interpretation?.rejected).toBe(2);
    expect(stdout()).toContain('2 description(s) failed the citation check and were discarded');
  });

  it('says why it skipped when there is no credential', async () => {
    seedTwoGroups();
    db.close();

    const result = await runAnalyze({ repo: FIXTURE, cwd });

    expect(result.interpretationSkipped).toBe('no-credential');
    expect(stdout()).toContain('Interpretation skipped: no model credential found');
  });
});
