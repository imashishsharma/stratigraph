import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runDoctor } from '../src/commands/doctor.js';
import { runIngest } from '../src/commands/ingest.js';
import { runInit } from '../src/commands/init.js';
import { assertSchemaCurrent, openDatabase } from '../src/db/database.js';
import { SCHEMA_VERSION } from '../src/db/migrations/index.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-cli-'));
}

describe('stratigraph init', () => {
  it('creates a database with the full schema and exits zero', () => {
    // The M0 acceptance criterion, run the way a user would run it.
    const dir = scratch();
    const output = execFileSync(TSX, [join(REPO_ROOT, 'src', 'cli.ts'), 'init', '--repo', FIXTURE], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void output;

    const dbPath = join(dir, '.stratigraph', 'tiny-java.db');
    expect(existsSync(dbPath)).toBe(true);

    const db = openDatabase(dbPath, { mustExist: true, readonly: true });
    expect(() => assertSchemaCurrent(db)).not.toThrow();
    db.close();
  });

  it('reports the schema version and applied migrations', () => {
    const dir = scratch();
    const result = runInit({ repo: FIXTURE, cwd: dir });
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.applied).toEqual([1]);
    expect(result.dbPath).toBe(join(dir, '.stratigraph', 'tiny-java.db'));
  });

  it('is safe to run twice', () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    const second = runInit({ repo: FIXTURE, cwd: dir });
    expect(second.applied).toEqual([]);
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('exits non-zero with a readable message on a bad repo path', () => {
    const dir = scratch();
    let status = 0;
    let stderr = '';
    try {
      execFileSync(TSX, [join(REPO_ROOT, 'src', 'cli.ts'), 'init', '--repo', join(dir, 'nope')], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/repository path does not exist/);
  });
});

describe('stratigraph ingest', () => {
  it('reads NDJSON from a file into the fact store', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });

    const factsPath = join(dir, 'facts.ndjson');
    writeFileSync(
      factsPath,
      [
        { v: 1, type: 'meta', extractor: 'test', extractorVersion: '0.0.0' },
        { v: 1, type: 'file', path: 'src/A.java', language: 'java', loc: 12 },
        { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
        {
          v: 1,
          type: 'node',
          kind: 'class',
          fqn: 'a.A',
          name: 'A',
          parent: { kind: 'package', fqn: 'a' },
          file: 'src/A.java',
        },
        {
          v: 1,
          type: 'edge',
          kind: 'calls',
          src: { kind: 'class', fqn: 'a.A' },
          dst: { kind: 'class', fqn: 'b.B' },
          file: 'src/A.java',
          line: 4,
        },
      ]
        .map((f) => JSON.stringify(f))
        .join('\n'),
    );

    const result = await runIngest({ repo: FIXTURE, cwd: dir, from: factsPath });
    expect(result).toMatchObject({ files: 1, nodes: 2, edges: 1, stubs: 1 });

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    expect(db.prepare('SELECT status FROM run WHERE id = ?').get(result.runId)).toEqual({
      status: 'ok',
    });
    db.close();
  });

  it('marks the run failed and rejects the batch when a fact is malformed', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    const factsPath = join(dir, 'bad.ndjson');
    writeFileSync(factsPath, ['{"v":1,"type":"node","kind":"class"}'].join('\n'));

    await expect(runIngest({ repo: FIXTURE, cwd: dir, from: factsPath })).rejects.toThrow(
      /line 1/,
    );

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    expect(db.prepare('SELECT status FROM run ORDER BY id DESC LIMIT 1').get()).toEqual({
      status: 'failed',
    });
    db.close();
  });

  it('refuses to ingest into a database that does not exist yet', async () => {
    const dir = scratch();
    await expect(runIngest({ repo: FIXTURE, cwd: dir })).rejects.toThrow();
  });
});

describe('stratigraph doctor', () => {
  it('reports on the toolchain without failing when a JDK is missing', () => {
    const dir = scratch();
    const checks = runDoctor({ repo: FIXTURE, cwd: dir });
    const names = checks.map((c) => c.name);
    expect(names).toEqual(['stratigraph', 'node', 'git', 'java', 'config', 'database']);
    // A missing or old JDK limits one extractor; it is never a hard failure.
    expect(checks.every((c) => c.status !== 'ok' || c.detail.length > 0)).toBe(true);
    expect(checks.find((c) => c.name === 'database')?.status).toBe('missing');
  });
});
