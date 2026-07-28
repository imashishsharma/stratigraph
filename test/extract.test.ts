import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runExtract } from '../src/commands/extract.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase } from '../src/db/database.js';
import { setQuiet } from '../src/log.js';
import {
  findExtractorJar,
  JAR_ENV_VAR,
  missingJarMessage,
} from '../src/toolchain/extractor-jar.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-extract-'));
}

/**
 * A stand-in extractor: a Node script that prints canned NDJSON.
 *
 * The protocol is the whole contract between the core and an extractor
 * (ADR-0003), so the core's half of it can — and should — be tested without a
 * JVM anywhere near it. This suite runs on the same three-OS, three-Node matrix
 * as everything else, where no JDK is guaranteed.
 */
function fakeExtractor(dir: string, script: string): (repo: string, args: string[]) => ReturnType<typeof spawn> {
  const path = join(dir, 'fake-extractor.mjs');
  writeFileSync(path, script);
  return (_repo, args) =>
    spawn(process.execPath, [path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const GOOD_FACTS = `
const facts = [
  { v: 1, type: 'meta', extractor: 'fake', extractorVersion: '0.0.0' },
  { v: 1, type: 'file', path: 'src/A.java', language: 'java', loc: 10 },
  { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
  { v: 1, type: 'node', kind: 'class', fqn: 'a.A', name: 'A', parent: { kind: 'package', fqn: 'a' }, file: 'src/A.java' },
  { v: 1, type: 'diagnostic', level: 'warn', message: 'could not resolve Foo', file: 'src/A.java', line: 3 },
];
console.error('discovered 1 java sources');
for (const fact of facts) console.log(JSON.stringify(fact));
`;

describe('runExtract', () => {
  it('stores what the extractor emits and marks the run ok', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });

    const result = await runExtract({
      repo: FIXTURE,
      cwd: dir,
      spawnExtractor: fakeExtractor(dir, GOOD_FACTS),
    });

    expect(result).toMatchObject({ files: 1, nodes: 2, edges: 0, diagnostics: 1 });

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    expect(db.prepare('SELECT status FROM run WHERE id = ?').get(result.runId)).toEqual({
      status: 'ok',
    });
    db.close();
  });

  it('passes the configured excludes and includes to the extractor', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });
    writeFileSync(
      join(dir, 'stratigraph.config.json'),
      JSON.stringify({ exclude: ['generated'], include: ['src/main'] }),
    );

    // Echo the arguments back as a diagnostic so the test can read them.
    const script = `
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ v: 1, type: 'meta', extractor: 'fake', extractorVersion: '0' }));
      console.log(JSON.stringify({ v: 1, type: 'diagnostic', level: 'info', message: args.join(' ') }));
    `;
    const result = await runExtract({
      repo: FIXTURE,
      cwd: dir,
      spawnExtractor: fakeExtractor(dir, script),
    });

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    const { message } = db
      .prepare('SELECT message FROM diagnostic WHERE run_id = ?')
      .get(result.runId) as { message: string };
    db.close();

    expect(message).toContain('--exclude generated');
    expect(message).toContain('--include src/main');
    expect(message).toContain(`--repo ${FIXTURE}`);
  });

  it('marks the run failed when the extractor exits non-zero, even after clean output', async () => {
    // The dangerous case: a well-formed fact stream that stops early because
    // the extractor died. Recording that as a successful run would silently
    // under-report the repository.
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });

    const script = `
      console.log(JSON.stringify({ v: 1, type: 'meta', extractor: 'fake', extractorVersion: '0' }));
      console.log(JSON.stringify({ v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' }));
      console.error('boom');
      process.exit(3);
    `;

    await expect(
      runExtract({ repo: FIXTURE, cwd: dir, spawnExtractor: fakeExtractor(dir, script) }),
    ).rejects.toThrow(/exited with status 3/);

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    expect(db.prepare('SELECT status FROM run ORDER BY id DESC LIMIT 1').get()).toEqual({
      status: 'failed',
    });
    db.close();
  });

  it('rejects a malformed fact rather than storing a partial lie as complete', async () => {
    const dir = scratch();
    runInit({ repo: FIXTURE, cwd: dir });

    const script = `
      console.log(JSON.stringify({ v: 1, type: 'meta', extractor: 'fake', extractorVersion: '0' }));
      console.log('{"v":1,"type":"node","kind":"nonsense","fqn":"a","name":"a"}');
    `;

    await expect(
      runExtract({ repo: FIXTURE, cwd: dir, spawnExtractor: fakeExtractor(dir, script) }),
    ).rejects.toThrow(/line 2/);

    const db = openDatabase(join(dir, '.stratigraph', 'tiny-java.db'), { mustExist: true, readonly: true });
    expect(db.prepare('SELECT status FROM run ORDER BY id DESC LIMIT 1').get()).toEqual({
      status: 'failed',
    });
    db.close();
  });

  it('refuses to extract into a database that does not exist yet', async () => {
    const dir = scratch();
    await expect(
      runExtract({ repo: FIXTURE, cwd: dir, spawnExtractor: fakeExtractor(dir, GOOD_FACTS) }),
    ).rejects.toThrow();
  });
});

describe('findExtractorJar', () => {
  it('prefers the flag over the environment', () => {
    const dir = scratch();
    const flagJar = join(dir, 'flag.jar');
    const envJar = join(dir, 'env.jar');
    writeFileSync(flagJar, '');
    writeFileSync(envJar, '');

    expect(findExtractorJar({ jar: flagJar, env: { [JAR_ENV_VAR]: envJar } })).toEqual({
      path: flagJar,
      source: 'flag',
    });
    expect(findExtractorJar({ env: { [JAR_ENV_VAR]: envJar } })).toEqual({
      path: envJar,
      source: 'env',
    });
  });

  it('falls through a path that does not exist rather than returning it', () => {
    const dir = scratch();
    const real = join(dir, 'real.jar');
    writeFileSync(real, '');
    expect(
      findExtractorJar({ jar: join(dir, 'missing.jar'), configJar: real, env: {} }),
    ).toEqual({ path: real, source: 'config' });
  });

  it('returns null when nothing is anywhere', () => {
    expect(
      findExtractorJar({ env: {}, buildOutput: join(scratch(), 'nope.jar') }),
    ).toBeNull();
  });

  it('names every place it looked, and how to build one', () => {
    // "extractor not found" without a list is a dead end for the reader.
    const message = missingJarMessage({
      jar: '/tmp/given.jar',
      env: { [JAR_ENV_VAR]: '/tmp/from-env.jar' },
      buildOutput: '/tmp/built.jar',
    });
    expect(message).toContain('/tmp/given.jar');
    expect(message).toContain('/tmp/from-env.jar');
    expect(message).toContain('/tmp/built.jar');
    expect(message).toContain('./mvnw package');
  });
});
