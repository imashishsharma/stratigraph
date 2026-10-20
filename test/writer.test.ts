import { beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { lastSegment, SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';

let db: Db;
let runId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  runId = createRun(db, '/tmp/repo').id;
});

function ingest(facts: object[]) {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) {
    writer.write(parseFact(JSON.stringify(fact)) as Fact);
  }
  return writer.close();
}

const meta = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

describe('SqliteFactWriter', () => {
  it('writes files, nodes and edges with provenance', () => {
    const stats = ingest([
      meta,
      { v: 1, type: 'file', path: 'src/A.java', language: 'java', loc: 20 },
      { v: 1, type: 'node', kind: 'package', fqn: 'com.example', name: 'example' },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'com.example.A',
        name: 'A',
        parent: { kind: 'package', fqn: 'com.example' },
        file: 'src/A.java',
        startLine: 3,
        endLine: 20,
        attrs: { visibility: 'public' },
      },
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'class', fqn: 'com.example.A' },
        dst: { kind: 'class', fqn: 'com.example.B' },
        file: 'src/A.java',
        line: 12,
      },
    ]);

    expect(stats).toMatchObject({ files: 1, nodes: 2, edges: 1, stubs: 1 });

    const row = db
      .prepare(
        `SELECT n.name, n.start_line, n.extractor, n.attrs, p.fqn AS parent_fqn, f.path
           FROM node n
           LEFT JOIN node p ON p.id = n.parent_id
           LEFT JOIN source_file f ON f.id = n.file_id
          WHERE n.fqn = 'com.example.A'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      name: 'A',
      start_line: 3,
      extractor: 'java',
      parent_fqn: 'com.example',
      path: 'src/A.java',
    });
    expect(JSON.parse(row['attrs'] as string)).toEqual({ visibility: 'public' });

    const edge = db
      .prepare(
        `SELECT e.line, e.confidence, f.path FROM edge e
           LEFT JOIN source_file f ON f.id = e.file_id`,
      )
      .get() as { line: number; confidence: string; path: string };
    expect(edge).toEqual({ line: 12, confidence: 'fact', path: 'src/A.java' });
  });

  it('creates a stub for a node nobody declared, and marks it as such', () => {
    ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'class', fqn: 'com.example.A' },
        dst: { kind: 'class', fqn: 'java.util.List' },
      },
    ]);
    const stubs = db
      .prepare('SELECT fqn, name, is_stub FROM node ORDER BY fqn')
      .all() as Array<{ fqn: string; name: string; is_stub: number }>;
    expect(stubs).toEqual([
      { fqn: 'com.example.A', name: 'A', is_stub: 1 },
      { fqn: 'java.util.List', name: 'List', is_stub: 1 },
    ]);
  });

  it('upgrades a stub in place when the real declaration arrives later', () => {
    const stats = ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'extends',
        src: { kind: 'class', fqn: 'com.example.A' },
        dst: { kind: 'class', fqn: 'com.example.Base' },
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'com.example.Base',
        name: 'Base',
        file: 'src/Base.java',
        startLine: 5,
      },
    ]);

    expect(stats.stubs).toBe(1); // only com.example.A remains a stub
    const base = db
      .prepare(`SELECT is_stub, start_line FROM node WHERE fqn = 'com.example.Base'`)
      .get() as { is_stub: number; start_line: number };
    expect(base).toEqual({ is_stub: 0, start_line: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM node').get()).toEqual({ n: 2 });
  });

  it('backfills language when a file fact arrives after a node referenced the file', () => {
    ingest([
      meta,
      { v: 1, type: 'node', kind: 'class', fqn: 'a.A', name: 'A', file: 'src/A.java' },
      { v: 1, type: 'file', path: 'src/A.java', language: 'java', loc: 10 },
    ]);
    expect(
      db.prepare(`SELECT language, loc FROM source_file WHERE path = 'src/A.java'`).get(),
    ).toEqual({ language: 'java', loc: 10 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_file').get()).toEqual({ n: 1 });
  });

  it('counts a repeated identical edge as weight instead of duplicating it', () => {
    const edge = {
      v: 1,
      type: 'edge',
      kind: 'calls',
      src: { kind: 'method', fqn: 'a.A#run()' },
      dst: { kind: 'method', fqn: 'b.B#go()' },
      file: 'src/A.java',
      line: 9,
    };
    const stats = ingest([meta, edge, edge, edge]);
    expect(stats.edges).toBe(1);
    expect(db.prepare('SELECT weight FROM edge').get()).toEqual({ weight: 3 });
  });

  it('deduplicates a derived edge that has no file or line', () => {
    // SQLite treats every NULL as distinct in a UNIQUE constraint, so this only
    // works because the identity index coalesces the nullable columns.
    const edge = {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'package', fqn: 'a' },
      dst: { kind: 'package', fqn: 'b' },
    };
    const stats = ingest([meta, edge, edge]);
    expect(stats.edges).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(weight) AS w FROM edge').get()).toEqual({
      n: 1,
      w: 2,
    });
  });

  it('keeps calls from different lines as separate edges', () => {
    ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'method', fqn: 'a.A#run()' },
        dst: { kind: 'method', fqn: 'b.B#go()' },
        file: 'src/A.java',
        line: 9,
      },
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'method', fqn: 'a.A#run()' },
        dst: { kind: 'method', fqn: 'b.B#go()' },
        file: 'src/A.java',
        line: 14,
      },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM edge').get()).toEqual({ n: 2 });
  });

  it('preserves an inferred edge as inferred', () => {
    ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'http_calls',
        src: { kind: 'service', fqn: 'app.UserService' },
        dst: { kind: 'endpoint', fqn: 'GET /api/users/{id}' },
        confidence: 'inferred',
        attrs: { matchedOn: 'url-pattern' },
      },
    ]);
    expect(db.prepare('SELECT confidence FROM edge').get()).toEqual({
      confidence: 'inferred',
    });
  });

  it('stores diagnostics against their file', () => {
    const stats = ingest([
      meta,
      { v: 1, type: 'file', path: 'src/A.java', language: 'java' },
      {
        v: 1,
        type: 'diagnostic',
        level: 'warn',
        message: 'unresolved type Foo',
        file: 'src/A.java',
        line: 3,
      },
    ]);
    expect(stats.diagnostics).toBe(1);
    expect(
      db
        .prepare(
          `SELECT d.level, d.message, f.path FROM diagnostic d JOIN source_file f ON f.id = d.file_id`,
        )
        .get(),
    ).toEqual({ level: 'warn', message: 'unresolved type Foo', path: 'src/A.java' });
  });

  it('maps an entity to a table', () => {
    ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'maps_to',
        src: { kind: 'class', fqn: 'com.example.shop.domain.Order' },
        dst: { kind: 'table', fqn: 'orders' },
        file: 'src/Order.java',
        line: 9,
        attrs: { resolution: 'import' },
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT e.kind, e.confidence, s.fqn AS src, d.fqn AS dst, d.kind AS dst_kind
             FROM edge e JOIN node s ON s.id = e.src_id JOIN node d ON d.id = e.dst_id`,
        )
        .get(),
    ).toEqual({
      kind: 'maps_to',
      confidence: 'fact',
      src: 'com.example.shop.domain.Order',
      dst: 'orders',
      dst_kind: 'table',
    });
  });

  it('refuses to write after close', () => {
    const writer = new SqliteFactWriter(db, runId);
    writer.close();
    expect(() =>
      writer.write(parseFact('{"v":1,"type":"file","path":"a","language":"java"}')),
    ).toThrow(/closed/);
  });

  it('names a stubbed method sensibly', () => {
    // Every call into a third-party jar creates one of these, so the name it
    // gets is what a report will actually print.
    ingest([
      meta,
      {
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'method', fqn: 'com.example.A#run()' },
        dst: { kind: 'method', fqn: 'org.slf4j.Logger#info(java.lang.String)' },
      },
    ]);
    expect(
      db.prepare(`SELECT name, is_stub FROM node WHERE fqn LIKE 'org.slf4j%'`).get(),
    ).toEqual({ name: 'info', is_stub: 1 });
  });
});

describe('lastSegment', () => {
  it.each([
    // ADR-0007 identity scheme.
    ['com.example.shop.service.OrderService#findOne(java.lang.Long)', 'findOne'],
    ['com.example.Order#<init>(java.lang.String)', '<init>'],
    ['com.example.Order#customerRef', 'customerRef'],
    ['com.example.shop.web.OrderController', 'OrderController'],
    ['com.example.Outer$Inner', 'Inner'],
    ['com.example.shop.web', 'web'],
    ['com.example:shop-web', 'shop-web'],
    ['<default>', '<default>'],
    ['orders', 'orders'],
    ['GET /api/orders/{id}', 'GET /api/orders/{id}'],
  ])('%s -> %s', (fqn, expected) => {
    expect(lastSegment(fqn)).toBe(expected);
  });
});

describe('a type referenced with the wrong kind (source-only extraction)', () => {
  // Without a classpath the Java extractor cannot tell an imported enum or
  // interface from a class, and refers to it as `class`. Found on a real
  // Gradle JHipster app: 17 imports of three enums landed on parentless
  // `class` stubs beside the declared `enum` nodes, the package graph lost
  // them, and an analysis reported the enums' package as connected to nothing.
  const pkg = { v: 1, type: 'node', kind: 'package', fqn: 'pay.enumeration', name: 'enumeration' };
  const user = { v: 1, type: 'node', kind: 'class', fqn: 'core.Hospital', name: 'Hospital' };
  const declared = {
    v: 1,
    type: 'node',
    kind: 'enum',
    fqn: 'pay.enumeration.Status',
    name: 'Status',
    parent: { kind: 'package', fqn: 'pay.enumeration' },
  };
  const importAsClass = {
    v: 1,
    type: 'edge',
    kind: 'imports',
    src: { kind: 'class', fqn: 'core.Hospital' },
    dst: { kind: 'class', fqn: 'pay.enumeration.Status' },
    file: 'src/core/Hospital.java',
    line: 3,
  };

  function importTargets() {
    return db
      .prepare(
        `SELECT d.kind, d.is_stub AS isStub, p.fqn AS parent FROM edge e
           JOIN node d ON d.id = e.dst_id LEFT JOIN node p ON p.id = d.parent_id
          WHERE e.run_id = ? AND e.kind = 'imports'`,
      )
      .all(runId);
  }

  function typeNodes() {
    return db
      .prepare(`SELECT kind, is_stub AS isStub FROM node WHERE run_id = ? AND fqn = 'pay.enumeration.Status' ORDER BY kind`)
      .all(runId);
  }

  it('lands on the declared enum when the declaration came first', () => {
    const stats = ingest([meta, pkg, user, declared, importAsClass]);
    expect(importTargets()).toEqual([{ kind: 'enum', isStub: 0, parent: 'pay.enumeration' }]);
    expect(typeNodes()).toEqual([{ kind: 'enum', isStub: 0 }]);
    expect(stats.stubs).toBe(0);
  });

  it('moves the edges from the stub to the declaration when the reference came first', () => {
    const stats = ingest([meta, user, importAsClass, pkg, declared]);
    expect(importTargets()).toEqual([{ kind: 'enum', isStub: 0, parent: 'pay.enumeration' }]);
    expect(typeNodes()).toEqual([{ kind: 'enum', isStub: 0 }]);
    expect(stats.stubs).toBe(0);
    // The cache follows the merge: a later reference reaches the same node.
    ingest([meta, { ...importAsClass, line: 9 }]);
    expect(typeNodes()).toEqual([{ kind: 'enum', isStub: 0 }]);
  });

  it('keeps distinct kinds apart when neither is a type (a table is not a class)', () => {
    ingest([
      meta,
      { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
      { v: 1, type: 'edge', kind: 'reads_table', src: { kind: 'class', fqn: 'core.Hospital' }, dst: { kind: 'class', fqn: 'orders' } },
    ]);
    const kinds = db.prepare(`SELECT kind FROM node WHERE run_id = ? AND fqn = 'orders' ORDER BY kind`).pluck().all(runId);
    expect(kinds).toEqual(['class', 'table']);
  });
});
