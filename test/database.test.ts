import { describe, expect, it } from 'vitest';

import { assertSchemaCurrent, currentVersion, migrate, openDatabase } from '../src/db/database.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/db/migrations/index.js';
import { createRun, finishRun, latestRun } from '../src/db/run.js';

function fresh() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function tableNames(db: ReturnType<typeof fresh>): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('migrations', () => {
  it('applies every migration and records the version', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    expect(result.applied).toHaveLength(MIGRATIONS.length);
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is idempotent', () => {
    const db = fresh();
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(SCHEMA_VERSION);
  });

  it('creates the full schema', () => {
    expect(tableNames(fresh())).toEqual([
      'citation',
      'cluster',
      'cluster_member',
      'commit_file',
      'diagnostic',
      'edge',
      'file_metric',
      'finding',
      'git_commit',
      'node',
      'run',
      'schema_migration',
      'source_file',
      'temporal_coupling',
    ]);
  });

  it('has unique, ordered migration versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('accepts a current database and rejects a future one', () => {
    const db = fresh();
    expect(() => assertSchemaCurrent(db)).not.toThrow();
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => assertSchemaCurrent(db)).toThrow(/newer than this build/);
  });
});

describe('schema constraints', () => {
  it('enforces foreign keys', () => {
    const db = fresh();
    expect(() =>
      db
        .prepare(`INSERT INTO source_file (run_id, path, language) VALUES (999, 'a.java', 'java')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects a citation that cites nothing', () => {
    const db = fresh();
    const run = createRun(db, '/tmp/repo');
    db.prepare(`INSERT INTO finding (run_id, rule, title) VALUES (?, 'x', 'y')`).run(run.id);
    expect(() =>
      db.prepare(`INSERT INTO citation (finding_id, kind) VALUES (1, 'node')`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown confidence value on an edge', () => {
    const db = fresh();
    const run = createRun(db, '/tmp/repo');
    db.prepare(
      `INSERT INTO node (run_id, kind, fqn, name) VALUES (?, 'class', 'a.A', 'A'), (?, 'class', 'b.B', 'B')`,
    ).run(run.id, run.id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO edge (run_id, kind, src_id, dst_id, confidence) VALUES (?, 'calls', 1, 2, 'maybe')`,
        )
        .run(run.id),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('runs', () => {
  it('records and closes a run', () => {
    const db = fresh();
    const run = createRun(db, '/tmp/repo');
    expect(latestRun(db)?.id).toBe(run.id);
    finishRun(db, run.id, 'ok');
    const row = db.prepare('SELECT status, finished_at FROM run WHERE id = ?').get(run.id) as {
      status: string;
      finished_at: string;
    };
    expect(row.status).toBe('ok');
    expect(row.finished_at).toBeTruthy();
  });

  it('returns null when there are no runs', () => {
    expect(latestRun(fresh())).toBeNull();
  });
});
