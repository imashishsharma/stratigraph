import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

// tsx's loader, resolved to an absolute path from the repo rather than by bare
// specifier — the subprocess runs in a temp directory where `tsx` is not
// resolvable.
const TSX_LOADER = pathToFileURL(
  createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx'),
).href;

/**
 * Run the CLI as a real subprocess. Invoking node with tsx's loader rather than
 * `node_modules/.bin/tsx` because on Windows that shim is a `.cmd`, which
 * spawnSync cannot execute without a shell.
 *
 * The credential environment is stripped deliberately. Without it a developer
 * who happens to have ANTHROPIC_API_KEY exported would have `npm test` making
 * real API calls, which is neither hermetic nor free.
 */
function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_CONFIG_DIR: join(cwd, 'no-credentials'),
    STRATIGRAPH_CONFIG_HOME: join(cwd, 'no-user-config'),
  };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  try {
    const stdout = execFileSync(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-cli-'));
}

describe('stratigraph init', () => {
  it('creates a database with the full schema and exits zero', () => {
    // The M0 acceptance criterion, run the way a user would run it.
    const dir = scratch();
    const { status } = runCli(['init', '--repo', FIXTURE], dir);
    expect(status).toBe(0);

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
    const { status, stderr } = runCli(['init', '--repo', join(dir, 'nope')], dir);
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

describe('stratigraph analyze', () => {
  /** A three-package cycle, written the way an extractor would emit it. */
  function seed(dir: string): string {
    const factsPath = join(dir, 'facts.ndjson');
    const facts: object[] = [
      { v: 1, type: 'meta', extractor: 'test', extractorVersion: '0.0.0' },
    ];
    for (const name of ['web', 'service', 'repo']) {
      facts.push(
        { v: 1, type: 'file', path: `src/${name}/C.java`, language: 'java' },
        { v: 1, type: 'node', kind: 'package', fqn: `com.example.${name}`, name },
        {
          v: 1,
          type: 'node',
          kind: 'class',
          fqn: `com.example.${name}.C`,
          name: 'C',
          parent: { kind: 'package', fqn: `com.example.${name}` },
          file: `src/${name}/C.java`,
        },
      );
    }
    const ring = [
      ['web', 'service'],
      ['service', 'repo'],
      ['repo', 'web'],
    ];
    for (const [from, to] of ring) {
      facts.push({
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: `com.example.${from}.C` },
        dst: { kind: 'class', fqn: `com.example.${to}.C` },
        file: `src/${from}/C.java`,
        line: 3,
      });
    }
    writeFileSync(factsPath, facts.map((f) => JSON.stringify(f)).join('\n'));
    return factsPath;
  }

  it('reports a cycle on stdout with a file and line for every hop', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    await runIngest({ repo: FIXTURE, cwd: dir, from: seed(dir) });

    const { status, stdout } = runCli(['analyze', '--repo', FIXTURE], dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/1 package cycle:/);
    expect(stdout).toMatch(/com\.example\.repo → com\.example\.web → com\.example\.service/);
    // Every hop must be checkable against the source, not merely asserted.
    expect(stdout.match(/src\/\w+\/C\.java:3/g)).toHaveLength(3);
  });

  it('exits non-zero with a readable message when there are no facts yet', () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    const { status, stderr } = runCli(['analyze', '--repo', FIXTURE], dir);
    expect(status).toBe(2);
    // Both routes into the store are named: with M2 there are two, and a
    // message that mentions only `extract` sends a user with no JDK nowhere.
    expect(stderr).toMatch(/no runs in/);
    expect(stderr).toMatch(/stratigraph extract` or `stratigraph history/);
  });

  it('rejects a --run that is not a positive integer', () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    const { status, stderr } = runCli(['analyze', '--repo', FIXTURE, '--run', 'x'], dir);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--run must be a positive integer/);
  });
});

describe('stratigraph doctor', () => {
  it('reports on the toolchain without failing when a JDK is missing', () => {
    const dir = scratch();
    const checks = runDoctor({ repo: FIXTURE, cwd: dir });
    const names = checks.map((c) => c.name);
    expect(names).toEqual([
      'stratigraph',
      'node',
      'git',
      'java',
      'extractor',
      'config',
      'model',
      'history',
      'database',
    ]);
    // A missing or old JDK limits one extractor; it is never a hard failure.
    expect(checks.every((c) => c.status !== 'ok' || c.detail.length > 0)).toBe(true);
    expect(checks.find((c) => c.name === 'database')?.status).toBe('missing');
  });
});
