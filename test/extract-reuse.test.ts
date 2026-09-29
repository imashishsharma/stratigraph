import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { runExtract, type SpawnExtractor } from '../src/commands/extract.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase } from '../src/db/database.js';
import { inputFingerprint } from '../src/facts/reuse.js';
import { setQuiet } from '../src/log.js';
import { createServer } from '../src/mcp/server.js';

setQuiet(true);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-reuse-'));
}

function fullStack(): string {
  const repo = scratch();
  mkdirSync(join(repo, 'backend'), { recursive: true });
  mkdirSync(join(repo, 'frontend'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'App.java'), 'class App {}');
  writeFileSync(join(repo, 'frontend', 'app.ts'), 'export class App {}');
  writeFileSync(join(repo, 'README.md'), '# app');
  return repo;
}

/**
 * Emits facts derived from the files it would read, and leaves a mark in
 * `calls/` each time it is started, so a test can tell a reuse from a run.
 */
function countingExtractor(dir: string): SpawnExtractor {
  const calls = join(dir, 'calls');
  mkdirSync(calls, { recursive: true });
  const path = join(dir, 'extractor.mjs');
  writeFileSync(
    path,
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const language = process.argv.find((a) => a.startsWith('--language=')).slice(11);
    const repo = process.argv[process.argv.indexOf('--repo') + 1];
    writeFileSync(join(${JSON.stringify(calls)}, language + '-' + process.hrtime.bigint()), '');
    const file = language === 'java' ? 'backend/App.java' : 'frontend/app.ts';
    const text = readFileSync(join(repo, file), 'utf8');
    const name = /class (\\w+)/.exec(text)[1];
    console.log(JSON.stringify({ v: 1, type: 'meta', extractor: language, extractorVersion: '0' }));
    console.log(JSON.stringify({ v: 1, type: 'file', path: file, language, loc: 1 }));
    console.log(JSON.stringify({ v: 1, type: 'node', kind: 'package', fqn: language, name: language }));
    console.log(JSON.stringify({ v: 1, type: 'node', kind: 'class', fqn: language + '.' + name, name,
      parent: { kind: 'package', fqn: language }, file }));
    `,
  );
  return (language, _repo, args) =>
    spawn(process.execPath, [path, `--language=${language}`, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function calls(dir: string): string[] {
  return readdirSync(join(dir, 'calls'))
    .map((name) => name.split('-')[0] as string)
    .sort();
}

function setup(identity = 'v1') {
  const repo = fullStack();
  const dir = scratch();
  runInit({ repo, cwd: dir });
  const spawnExtractor = countingExtractor(dir);
  const extract = (extra: { reuse?: boolean; identity?: string } = {}) =>
    runExtract({
      repo,
      cwd: dir,
      spawnExtractor,
      extractorIdentity: (language) => [language, extra.identity ?? identity],
      ...(extra.reuse === undefined ? {} : { reuse: extra.reuse }),
    });
  const db = () =>
    openDatabase(join(dir, '.stratigraph', `${basename(repo)}.db`), { mustExist: true, readonly: true });
  return { repo, dir, extract, db };
}

/** A run's facts with the per-run ids taken out, so two runs can be compared. */
function facts(db: ReturnType<ReturnType<typeof setup>['db']>, runId: number) {
  return {
    nodes: db
      .prepare(
        `SELECT n.kind, n.fqn, n.name, n.is_stub, n.extractor, p.fqn AS parent, f.path AS file
           FROM node n LEFT JOIN node p ON p.id = n.parent_id LEFT JOIN source_file f ON f.id = n.file_id
          WHERE n.run_id = ? ORDER BY n.kind, n.fqn`,
      )
      .all(runId),
    files: db.prepare('SELECT path, language, loc FROM source_file WHERE run_id = ? ORDER BY path').all(runId),
  };
}

describe('extract reuses an extractor whose inputs are unchanged (ADR-0046)', () => {
  it('replays the stored facts instead of running the extractor again', async () => {
    const { extract, dir, db } = setup();
    const first = await extract();
    const second = await extract();

    expect(calls(dir)).toEqual(['java', 'typescript']);
    expect(second.reused).toEqual(['java', 'typescript']);
    expect(second.languages).toEqual(['java', 'typescript']);

    const store = db();
    // Byte-identical input into the same writer: the same facts.
    expect(facts(store, second.runId)).toEqual(facts(store, first.runId));
    const reasons = store
      .prepare('SELECT language, status, reason FROM extractor_run WHERE run_id = ? ORDER BY language')
      .all(second.runId) as Array<{ language: string; status: string; reason: string }>;
    expect(reasons.map((row) => row.status)).toEqual(['ok', 'ok']);
    for (const row of reasons) {
      expect(row.reason).toContain(`reused from run ${first.runId}`);
    }
  });

  it('re-runs only the extractor whose files changed', async () => {
    const { extract, repo, dir, db } = setup();
    await extract();
    writeFileSync(join(repo, 'backend', 'App.java'), 'class Renamed {}');
    const second = await extract();

    expect(calls(dir)).toEqual(['java', 'java', 'typescript']);
    expect(second.reused).toEqual(['typescript']);
    const fqns = db()
      .prepare(`SELECT fqn FROM node WHERE run_id = ? AND kind = 'class' ORDER BY fqn`)
      .pluck()
      .all(second.runId);
    expect(fqns).toEqual(['java.Renamed', 'typescript.App']);
  });

  it('does not re-run anything for a file no extractor reads', async () => {
    const { extract, repo, dir } = setup();
    await extract();
    writeFileSync(join(repo, 'README.md'), '# app, documented');
    const second = await extract();
    expect(calls(dir)).toEqual(['java', 'typescript']);
    expect(second.reused).toEqual(['java', 'typescript']);
  });

  it('re-runs when the extractor itself changed', async () => {
    const { extract, dir } = setup();
    await extract();
    const second = await extract({ identity: 'v2' });
    expect(calls(dir)).toEqual(['java', 'java', 'typescript', 'typescript']);
    expect(second.reused).toEqual([]);
  });

  it('re-runs everything when reuse is turned off', async () => {
    const { extract, dir } = setup();
    await extract();
    const second = await extract({ reuse: false });
    expect(calls(dir)).toEqual(['java', 'java', 'typescript', 'typescript']);
    expect(second.reused).toEqual([]);
  });

  it('never reuses an extractor with no stated identity', async () => {
    const repo = fullStack();
    const dir = scratch();
    runInit({ repo, cwd: dir });
    const spawnExtractor = countingExtractor(dir);
    await runExtract({ repo, cwd: dir, spawnExtractor });
    const second = await runExtract({ repo, cwd: dir, spawnExtractor });
    expect(calls(dir)).toEqual(['java', 'java', 'typescript', 'typescript']);
    expect(second.reused).toEqual([]);
  });

  it('stores nothing from a failed extractor', async () => {
    const repo = fullStack();
    const dir = scratch();
    runInit({ repo, cwd: dir });
    const failing = join(dir, 'failing.mjs');
    writeFileSync(
      failing,
      `console.log(JSON.stringify({ v: 1, type: 'meta', extractor: 'x', extractorVersion: '0' }));
       process.exit(3);`,
    );
    const spawnExtractor: SpawnExtractor = (_language, _repo, args) =>
      spawn(process.execPath, [failing, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    await expect(
      runExtract({ repo, cwd: dir, spawnExtractor, extractorIdentity: () => ['x'], languages: new Set(['java']) }),
    ).rejects.toThrow(/status 3/);

    const good = countingExtractor(dir);
    const next = await runExtract({
      repo,
      cwd: dir,
      spawnExtractor: good,
      extractorIdentity: () => ['x'],
      languages: new Set(['java']),
    });
    expect(next.reused).toEqual([]);
    expect(calls(dir)).toEqual(['java']);
  });
});

describe('inputFingerprint', () => {
  it('covers the installed dependency tree the TypeScript compiler resolves types from', () => {
    const repo = fullStack();
    mkdirSync(join(repo, 'frontend', 'node_modules', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'frontend', 'node_modules', '.package-lock.json'), '{"v":1}');
    const before = inputFingerprint(repo, 'typescript', ['id']);
    writeFileSync(join(repo, 'frontend', 'node_modules', '.package-lock.json'), '{"v":2}');
    const after = inputFingerprint(repo, 'typescript', ['id']);
    expect(after.key).not.toEqual(before.key);
    // Java does not read node_modules.
    expect(inputFingerprint(repo, 'java', ['id']).key).toEqual(inputFingerprint(repo, 'java', ['id']).key);
  });

  it('reads untracked files too, as the extractors do', () => {
    const repo = fullStack();
    const before = inputFingerprint(repo, 'java', ['id']);
    writeFileSync(join(repo, 'backend', 'New.java'), 'class New {}');
    expect(inputFingerprint(repo, 'java', ['id']).key).not.toEqual(before.key);
    expect(inputFingerprint(repo, 'java', ['id']).files).toBe(before.files + 1);
  });

  it('skips the directories every extractor skips', () => {
    const repo = fullStack();
    const before = inputFingerprint(repo, 'java', ['id']);
    mkdirSync(join(repo, 'backend', 'target'), { recursive: true });
    writeFileSync(join(repo, 'backend', 'target', 'Gen.java'), 'class Gen {}');
    expect(inputFingerprint(repo, 'java', ['id']).key).toEqual(before.key);
    expect(readFileSync(join(repo, 'backend', 'target', 'Gen.java'), 'utf8')).toContain('Gen');
  });
});

describe('the MCP server follows new runs and states drift (ADR-0046)', () => {
  type Answer = {
    content: Array<{ text: string }>;
    structuredContent?: {
      drift?: { changed: string[]; added: string[]; removed: string[] };
      runChanged?: { runId: number };
    };
  };

  async function serve(repo: string, dir: string, runId: number, follow: boolean) {
    const store = openDatabase(join(dir, '.stratigraph', `${basename(repo)}.db`), {
      mustExist: true,
      readonly: true,
    });
    const server = createServer({
      db: store,
      runId,
      minCommits: 5,
      follow,
      dbPath: join(dir, '.stratigraph', `${basename(repo)}.db`),
      repoPath: repo,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const ask = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as Answer;
    return { ask, close: async () => { await client.close(); store.close(); } };
  }

  it('names the files changed since the run, then moves to the next run and says so', async () => {
    const { extract, repo, dir } = setup();
    const first = await extract();
    const server = await serve(repo, dir, first.runId, true);

    const fresh = await server.ask('find_node', { query: 'App' });
    expect(fresh.content[0]?.text).not.toContain('Stale');
    expect(fresh.structuredContent?.drift).toBeUndefined();

    writeFileSync(join(repo, 'backend', 'App.java'), 'class Renamed {}');
    writeFileSync(join(repo, 'backend', 'Extra.java'), 'class Extra {}');
    // Past the re-measure interval, as a session would be between edits.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const stale = await server.ask('find_node', { query: 'App' });
      expect(stale.content[0]?.text).toMatch(/Stale: 2 file\(s\) changed on disk since run \d+/);
      expect(stale.content[0]?.text).toContain('backend/App.java (changed)');
      expect(stale.content[0]?.text).toContain('backend/Extra.java (new)');
      expect(stale.structuredContent?.drift).toEqual({
        changed: ['backend/App.java'],
        added: ['backend/Extra.java'],
        removed: [],
      });

      const second = await extract();
      const moved = await server.ask('find_node', { query: 'Renamed' });
      expect(moved.content[0]?.text).toMatch(
        new RegExp(`^Note: run ${second.runId} .*earlier answers in this session came from run ${first.runId}`),
      );
      expect(moved.content[0]?.text).toContain('java.Renamed');
      expect(moved.content[0]?.text).not.toContain('Stale');
      expect(moved.structuredContent?.runChanged).toEqual(expect.objectContaining({ runId: second.runId }));

      // Said once, not on every answer after.
      const after = await server.ask('find_node', { query: 'Renamed' });
      expect(after.content[0]?.text).not.toContain('Note: run');
    } finally {
      Date.now = realNow;
      await server.close();
    }
  });

  it('stays on a pinned run, and says drift cannot be measured once a later run replaced the record', async () => {
    const { extract, repo, dir } = setup();
    const first = await extract();
    await extract();
    const server = await serve(repo, dir, first.runId, false);
    try {
      const answer = await server.ask('describe_run');
      expect(answer.content[0]?.text).toContain(`run ${first.runId} of`);
      expect(answer.content[0]?.text).not.toContain('Note: run');
      expect(answer.content[0]?.text).toContain('Whether files changed since this run cannot be told for: java, typescript');
    } finally {
      await server.close();
    }
  });
});
