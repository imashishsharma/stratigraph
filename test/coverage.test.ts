import { describe, expect, it } from 'vitest';

import { runCoverage } from '../src/analysis/coverage.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun, finishRun, recordExtractor } from '../src/db/run.js';

function store(): { db: Db; runId: number } {
  const db = openDatabase(':memory:');
  migrate(db);
  const runId = createRun(db, '/tmp/repo').id;
  finishRun(db, runId, 'ok');
  return { db, runId };
}

function roles(db: Db, runId: number, rows: Array<[string, string]>): void {
  const insert = db.prepare(
    `INSERT INTO file_role (run_id, path, role, rule) VALUES (?, ?, ?, 'test-fixture')`,
  );
  for (const [path, role] of rows) insert.run(runId, path, role);
}

function parsed(db: Db, runId: number, paths: string[]): void {
  const insert = db.prepare(
    `INSERT INTO source_file (run_id, path, language) VALUES (?, ?, 'x')`,
  );
  for (const path of paths) insert.run(runId, path);
}

/** A full-stack repository whose Java half was never read: the no-JDK case. */
function noJdk(): { db: Db; runId: number } {
  const { db, runId } = store();
  roles(db, runId, [
    ['api/src/main/java/A.java', 'source'],
    ['api/src/main/java/B.java', 'source'],
    ['api/src/main/java/C.kt', 'source'],
    ['api/src/test/java/ATest.java', 'test'],
    ['web/src/app.ts', 'source'],
    ['web/src/b.ts', 'source'],
    ['web/src/app.spec.ts', 'test'],
    ['package-lock.json', 'lockfile'],
    ['api/src/main/resources/db/changelog/0001.xml', 'migration'],
  ]);
  parsed(db, runId, ['web/src/app.ts', 'web/src/b.ts', 'web/src/app.spec.ts']);
  recordExtractor(db, runId, 'java', 'skipped', 'no JDK found. The Java extractor needs a JDK 17+.\nmore');
  recordExtractor(db, runId, 'typescript', 'ok', null);
  return { db, runId };
}

describe('runCoverage', () => {
  it('counts each extractor against the main source files it would parse', () => {
    const { db, runId } = noJdk();
    expect(runCoverage(db, runId).extractors).toEqual([
      {
        language: 'java',
        status: 'skipped',
        reason: 'no JDK found. The Java extractor needs a JDK 17+.\nmore',
        found: 3,
        parsed: 0,
        testsParsed: 0,
      },
      { language: 'typescript', status: 'ok', reason: null, found: 2, parsed: 2, testsParsed: 1 },
    ]);
  });

  it('withholds the architecture below threshold, and says which extractor did not run', () => {
    const { db, runId } = noJdk();
    const architecture = runCoverage(db, runId).views.architecture;

    expect(architecture).toMatchObject({
      numerator: 2,
      denominator: 5,
      ratio: 0.4,
      threshold: 0.5,
      withheld: true,
      statement:
        'Withheld: built from only 2 of 5 main source files parsed (40%), below the 50% this view needs.',
    });
    expect(architecture.reasons).toEqual([
      'Java/Kotlin: 0 of 3 main source files parsed — the java extractor did not run: ' +
        'no JDK found. The Java extractor needs a JDK 17+.',
      'TypeScript: 2 of 2 main source files parsed',
      '1 test file(s) were parsed and are left out of this view (ADR-0034).',
    ]);
  });

  it('takes the data model from the Java side only, and names unread migrations', () => {
    const { db, runId } = noJdk();
    const data = runCoverage(db, runId).views.data;
    expect(data).toMatchObject({ numerator: 0, denominator: 3, ratio: 0, withheld: true });
    expect(data.reasons.at(-1)).toMatch(/^1 migration file\(s\) are not read yet/);
  });

  it('lets a per-view threshold override the default', () => {
    const { db, runId } = noJdk();
    const coverage = runCoverage(db, runId, { minRatio: 0.5, views: { architecture: 0.4 } });
    expect(coverage.views.architecture).toMatchObject({ withheld: false, threshold: 0.4 });
    expect(coverage.views.architecture.statement).toBe(
      'Built from 2 of 5 main source files parsed (40%).',
    );
    expect(coverage.views.code.withheld).toBe(true);
  });

  it('floors the percentage, so a view just short of its threshold never prints the threshold', () => {
    const { db, runId } = store();
    const rows: Array<[string, string]> = [];
    for (let i = 0; i < 1000; i += 1) rows.push([`src/F${i}.java`, 'source']);
    roles(db, runId, rows);
    parsed(db, runId, rows.slice(0, 499).map(([path]) => path));
    recordExtractor(db, runId, 'java', 'ok', null);

    expect(runCoverage(db, runId).views.architecture.statement).toBe(
      'Withheld: built from only 499 of 1,000 main source files parsed (49%), below the 50% this view needs.',
    );
  });

  it('withholds hotspots when no history is stored, and says how to get it', () => {
    const { db, runId } = noJdk();
    const hotspots = runCoverage(db, runId).views.hotspots;
    expect(hotspots).toMatchObject({ numerator: 0, denominator: 5, withheld: true });
    expect(hotspots.reasons).toEqual([
      'No git history is stored for this run. Fix: `stratigraph history`.',
    ]);
  });

  it('counts hotspot coverage as source files with a complexity score', () => {
    const { db, runId } = noJdk();
    db.prepare(
      `INSERT INTO git_commit (run_id, sha, authored_at) VALUES (?, 'abc', '2026-01-01T00:00:00Z')`,
    ).run(runId);
    const metric = db.prepare(
      'INSERT INTO file_metric (run_id, path, commits, complexity) VALUES (?, ?, 1, ?)',
    );
    metric.run(runId, 'web/src/app.ts', 3);
    metric.run(runId, 'web/src/b.ts', null);
    metric.run(runId, 'package-lock.json', 9);

    const { hotspots, coupling } = runCoverage(db, runId).views;
    expect(hotspots).toMatchObject({ numerator: 1, denominator: 5, withheld: true });
    expect(hotspots.reasons).toEqual([
      '4 source file(s) have no complexity score (binary, too large or unreadable) and are ' +
        'left out of the ranking.',
    ]);
    expect(coupling).toMatchObject({ numerator: 2, denominator: 5 });
  });

  it('says coverage is unknown, rather than zero, for a run with no inventory', () => {
    const { db, runId } = store();
    parsed(db, runId, ['src/A.java']);
    const architecture = runCoverage(db, runId).views.architecture;
    expect(architecture).toMatchObject({ ratio: null, withheld: false });
    expect(architecture.statement).toMatch(/^Coverage unknown/);
  });

  it('has nothing to withhold in a repository with no source of either language', () => {
    const { db, runId } = store();
    roles(db, runId, [['README.md', 'docs']]);
    const architecture = runCoverage(db, runId).views.architecture;
    expect(architecture).toMatchObject({ ratio: null, withheld: false });
    expect(architecture.statement).toBe(
      'The repository has no Java, Kotlin or TypeScript source files to parse.',
    );
  });
});
