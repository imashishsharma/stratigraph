import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { PruneError, runPrune } from '../src/commands/prune.js';
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
let dbPath: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-prune-'));
  runInit({ repo: FIXTURE, cwd });
  dbPath = join(cwd, '.stratigraph', 'tiny-java.db');
  db = openDatabase(dbPath, { mustExist: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
});

/** A run carrying facts, history and analysis output, so a delete has work to do. */
function fullRun(): number {
  const runId = createRun(db, FIXTURE).id;
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of [
    { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' },
    { v: 1, type: 'file', path: 'src/a/A.java', language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'a.A',
      name: 'A',
      parent: { kind: 'package', fqn: 'a' },
      file: 'src/a/A.java',
    },
    { v: 1, type: 'node', kind: 'class', fqn: 'a.B', name: 'B', parent: { kind: 'package', fqn: 'a' } },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'a.A' },
      dst: { kind: 'class', fqn: 'a.B' },
      file: 'src/a/A.java',
      line: 3,
    },
  ]) {
    writer.write(parseFact(JSON.stringify(fact)) as Fact);
  }
  writer.close();

  db.prepare(
    `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
     VALUES (?, ?, 'A', 'a@example.com', '2026-01-01T00:00:00Z', 'a commit', 0)`,
  ).run(runId, `sha-${runId}`);

  const findingId = Number(
    db
      .prepare(
        `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
         VALUES (?, 'package-cycle', 'a cycle', 'detail', 'high', 'algorithm')`,
      )
      .run(runId).lastInsertRowid,
  );
  const edgeId = (db.prepare('SELECT id FROM edge WHERE run_id = ? LIMIT 1').get(runId) as {
    id: number;
  }).id;
  db.prepare(`INSERT INTO citation (finding_id, kind, edge_id) VALUES (?, 'edge', ?)`).run(
    findingId,
    edgeId,
  );

  const clusterId = Number(
    db
      .prepare(
        `INSERT INTO cluster (run_id, algorithm, label, authored_by)
         VALUES (?, 'louvain', 'c1', 'algorithm')`,
      )
      .run(runId).lastInsertRowid,
  );
  const nodeId = (db.prepare('SELECT id FROM node WHERE run_id = ? LIMIT 1').get(runId) as {
    id: number;
  }).id;
  db.prepare('INSERT INTO cluster_member (cluster_id, node_id) VALUES (?, ?)').run(
    clusterId,
    nodeId,
  );

  return runId;
}

/** A run with enough nodes for its pages to be worth reclaiming. */
function bulkRun(nodes: number): number {
  const runId = createRun(db, FIXTURE).id;
  const insert = db.prepare(
    `INSERT INTO node (run_id, kind, fqn, name, is_stub) VALUES (?, 'class', ?, ?, 0)`,
  );
  db.transaction(() => {
    for (let n = 0; n < nodes; n += 1) insert.run(runId, `pkg.Class${n}`, `Class${n}`);
  })();
  return runId;
}

function prune(options: { keep?: number; dryRun?: boolean } = {}) {
  return runPrune({ repo: FIXTURE, cwd, ...options });
}

function rows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('stratigraph prune', () => {
  it('keeps the newest runs and deletes the rest', () => {
    const ids = [fullRun(), fullRun(), fullRun(), fullRun(), fullRun()];
    db.close();

    const result = prune({ keep: 2 });

    expect(result.kept).toEqual([ids[4], ids[3]]);
    expect(result.deleted.map((run) => run.id)).toEqual([ids[2], ids[1], ids[0]]);

    db = openDatabase(dbPath, { mustExist: true });
    expect(
      (db.prepare('SELECT id FROM run ORDER BY id').all() as Array<{ id: number }>).map(
        (row) => row.id,
      ),
    ).toEqual([ids[3], ids[4]]);
  });

  it('takes every row of a deleted run with it, and leaves no orphan behind', () => {
    fullRun();
    const survivor = fullRun();
    db.close();

    prune({ keep: 1 });

    db = openDatabase(dbPath, { mustExist: true });
    for (const table of ['node', 'edge', 'source_file', 'git_commit', 'finding', 'cluster']) {
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id <> ?`).get(survivor) as {
            n: number;
          }
        ).n,
      ).toBe(0);
    }
    // The tables that hang off a finding or a cluster rather than off the run.
    expect(rows('citation')).toBe(1);
    expect(rows('cluster_member')).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('gives the disk back rather than only free-listing the pages', () => {
    // Enough rows that the freed pages are more than a rounding error: the
    // complaint this command answers is a store that grows every CI run, and
    // a delete without VACUUM leaves the file exactly as large as it was.
    bulkRun(4000);
    bulkRun(4000);
    const survivor = bulkRun(10);
    db.close();

    const before = statSync(dbPath).size;
    const result = prune({ keep: 1 });

    expect(result.kept).toEqual([survivor]);
    expect(result.bytesAfter).toBeLessThan(before);
    expect(statSync(dbPath).size).toBe(result.bytesAfter);

    db = openDatabase(dbPath, { mustExist: true });
    // What VACUUM buys over a bare DELETE: no pages left on the free list.
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('deletes nothing under --dry-run, and says what it would have taken', () => {
    const ids = [fullRun(), fullRun(), fullRun()];
    db.close();

    const result = prune({ keep: 1, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deleted.map((run) => run.id)).toEqual([ids[1], ids[0]]);
    expect(result.bytesAfter).toBe(result.bytesBefore);

    db = openDatabase(dbPath, { mustExist: true });
    expect(rows('run')).toBe(3);
  });

  it('does nothing when every run is within --keep', () => {
    fullRun();
    fullRun();
    db.close();

    const result = prune({ keep: 5 });

    expect(result.deleted).toEqual([]);
    expect(result.bytesAfter).toBe(result.bytesBefore);

    db = openDatabase(dbPath, { mustExist: true });
    expect(rows('run')).toBe(2);
  });

  it('reports what each run holds, so a wrong --keep is visible before it lands', () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    fullRun();
    fullRun();
    db.close();

    prune({ keep: 1, dryRun: true });

    const out = lines.join('');
    expect(out).toMatch(/run 1\s+\S+\s+3 nodes\s+1 commits\s+would delete/);
    expect(out).toMatch(/run 2\s+\S+\s+3 nodes\s+1 commits\s+keep/);
  });

  it('warns when the runs being deleted are the only ones holding git history', () => {
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    setQuiet(false);
    try {
      fullRun(); // the run history was mined into
      bulkRun(5); // two bare extracts on top of it
      bulkRun(5);
      db.close();
      prune({ keep: 2, dryRun: true });
    } finally {
      setQuiet(true);
    }

    expect(warnings.join('')).toMatch(/every run being deleted carries the git history/);
    expect(warnings.join('')).toMatch(/stratigraph history/);
  });

  it('stays quiet about history when a kept run still has some', () => {
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    setQuiet(false);
    try {
      fullRun();
      fullRun();
      db.close();
      prune({ keep: 1, dryRun: true });
    } finally {
      setQuiet(true);
    }

    expect(warnings.join('')).not.toMatch(/carries the git history/);
  });

  it('refuses to keep fewer than one run', () => {
    fullRun();
    db.close();

    expect(() => prune({ keep: 0 })).toThrow(PruneError);
    expect(() => prune({ keep: 0 })).toThrow(/at least 1/);
  });

  it('refuses when there is no store, naming the commands that make one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stratigraph-prune-empty-'));
    expect(() => runPrune({ repo: FIXTURE, cwd: empty })).toThrow(/no fact store at/);
    expect(() => runPrune({ repo: FIXTURE, cwd: empty })).toThrow(/stratigraph init/);
  });

  it('refuses when the store exists but holds no runs', () => {
    db.close();
    expect(() => prune()).toThrow(/nothing to prune/);
  });
});
