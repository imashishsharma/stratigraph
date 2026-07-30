import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import type { Fact } from '../src/facts/types.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import { setQuiet } from '../src/log.js';
import {
  checkCycle,
  describeModule,
  describeRun,
  findCallers,
  findHotspots,
  findNode,
  listEndpoints,
  queryDependencies,
  traceToTable,
} from '../src/mcp/queries.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let db: Db;
let runId: number;

beforeEach(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-mcp-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
});

afterEach(() => {
  if (db.open) db.close();
});

const META = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

function seed(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

/**
 * A three-package shop: a controller that injects a service, a service that
 * reads an entity, and an entity mapped to a table. Small enough to assert
 * exactly, shaped like the thing the tools are for.
 */
function seedShop(): void {
  seed([
    META,
    { v: 1, type: 'file', path: 'src/shop/web/OrderController.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/shop/service/OrderService.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/shop/domain/Order.java', language: 'java' },

    { v: 1, type: 'node', kind: 'package', fqn: 'shop.web', name: 'shop.web' },
    { v: 1, type: 'node', kind: 'package', fqn: 'shop.service', name: 'shop.service' },
    { v: 1, type: 'node', kind: 'package', fqn: 'shop.domain', name: 'shop.domain' },

    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'shop.web.OrderController',
      name: 'OrderController',
      parent: { kind: 'package', fqn: 'shop.web' },
      file: 'src/shop/web/OrderController.java',
      startLine: 10,
    },
    {
      v: 1,
      type: 'node',
      kind: 'method',
      fqn: 'shop.web.OrderController#list()',
      name: 'list',
      parent: { kind: 'class', fqn: 'shop.web.OrderController' },
      file: 'src/shop/web/OrderController.java',
      startLine: 20,
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'shop.service.OrderService',
      name: 'OrderService',
      parent: { kind: 'package', fqn: 'shop.service' },
      file: 'src/shop/service/OrderService.java',
      startLine: 8,
    },
    {
      v: 1,
      type: 'node',
      kind: 'method',
      fqn: 'shop.service.OrderService#findAll()',
      name: 'findAll',
      parent: { kind: 'class', fqn: 'shop.service.OrderService' },
      file: 'src/shop/service/OrderService.java',
      startLine: 15,
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'shop.domain.Order',
      name: 'Order',
      parent: { kind: 'package', fqn: 'shop.domain' },
      file: 'src/shop/domain/Order.java',
      startLine: 5,
    },
    { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'Orders' },
    {
      v: 1,
      type: 'node',
      kind: 'endpoint',
      fqn: 'GET /api/orders',
      name: 'GET /api/orders',
      file: 'src/shop/web/OrderController.java',
      startLine: 19,
      attrs: { framework: 'spring-mvc' },
    },

    edge('injects', 'class:shop.web.OrderController', 'class:shop.service.OrderService', 'src/shop/web/OrderController.java', 12),
    edge('calls', 'method:shop.web.OrderController#list()', 'method:shop.service.OrderService#findAll()', 'src/shop/web/OrderController.java', 21),
    edge('imports', 'class:shop.service.OrderService', 'class:shop.domain.Order', 'src/shop/service/OrderService.java', 3),
    edge('maps_to', 'class:shop.domain.Order', 'table:orders', 'src/shop/domain/Order.java', 6),
    edge('handles', 'method:shop.web.OrderController#list()', 'endpoint:GET /api/orders', 'src/shop/web/OrderController.java', 19),
  ]);
}

function edge(
  kind: string,
  from: string,
  to: string,
  file: string,
  line: number,
): object {
  return {
    v: 1,
    type: 'edge',
    kind,
    src: ref(from),
    dst: ref(to),
    file,
    line,
  };
}

function ref(spec: string): { kind: string; fqn: string } {
  const colon = spec.indexOf(':');
  return { kind: spec.slice(0, colon), fqn: spec.slice(colon + 1) };
}

/** `shop.domain` importing back into `shop.web` closes a two-package cycle. */
function seedCycle(): void {
  seed([
    META,
    edge('imports', 'class:shop.domain.Order', 'class:shop.web.OrderController', 'src/shop/domain/Order.java', 9),
  ]);
}

function seedHistory(): void {
  const commit = db.prepare(
    `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
     VALUES (?, ?, ?, ?, ?, 'subject', 0)`,
  );
  const file = db.prepare(
    `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions, change_type)
     VALUES (?, ?, ?, ?, 4, 2, 'M')`,
  );
  const metric = db.prepare(
    `INSERT INTO file_metric (run_id, path, commits, churn, complexity, authors, top_author_share, first_change_at, last_change_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')`,
  );

  for (const [n, path] of [
    'src/shop/web/OrderController.java',
    'src/shop/service/OrderService.java',
  ].entries()) {
    const id = Number(
      commit.run(
        runId,
        `sha${n}`,
        'ada',
        'ada@example.invalid',
        `2024-01-0${n + 1}T00:00:00.000Z`,
      ).lastInsertRowid,
    );
    file.run(runId, id, path, path);
  }
  metric.run(runId, 'src/shop/web/OrderController.java', 40, 900, 12, 1, 1);
  metric.run(runId, 'src/shop/service/OrderService.java', 5, 30, 3, 3, 0.4);
}

describe('describeRun', () => {
  it('reports what the run holds and what is missing from it', () => {
    seedShop();

    const summary = describeRun(db, runId);

    expect(summary?.counts).toMatchObject({
      packages: 3,
      types: 3,
      endpoints: 1,
      tables: 1,
      commits: 0,
      clusters: 0,
    });
    expect(summary?.extractors).toEqual(['java']);
    expect(summary?.languages).toEqual(['java']);
    expect(summary?.coverage).toEqual({
      facts: true,
      staticGraph: true,
      history: false,
      metrics: false,
      interpretation: false,
    });
    // The gaps are the point: an agent must be able to see that hotspots are
    // unavailable before it concludes this codebase has none.
    expect(summary?.gaps.join(' ')).toContain('stratigraph history');
    expect(summary?.gaps.join(' ')).toContain('stratigraph analyze');
  });

  it('says an empty run is empty rather than reporting a clean codebase', () => {
    const summary = describeRun(db, runId);

    expect(summary?.coverage.facts).toBe(false);
    expect(summary?.gaps[0]).toContain('nothing was parsed, not because nothing is there');
  });

  it('returns null for a run id that does not exist', () => {
    expect(describeRun(db, runId + 99)).toBeNull();
  });
});

describe('findNode', () => {
  beforeEach(seedShop);

  it('finds a type by its simple name and cites where it is declared', () => {
    const result = findNode(db, runId, { query: 'OrderService' });

    expect(result.total).toBe(2); // the class and its method
    expect(result.nodes[0]).toEqual({
      fqn: 'shop.service.OrderService',
      kind: 'class',
      name: 'OrderService',
      file: 'src/shop/service/OrderService.java',
      line: 8,
      declared: true,
    });
  });

  it('puts an exact match first', () => {
    const result = findNode(db, runId, { query: 'shop.web.OrderController' });
    expect(result.nodes[0]?.fqn).toBe('shop.web.OrderController');
  });

  it('filters by kind', () => {
    const result = findNode(db, runId, { query: 'shop', kind: 'package' });
    expect(result.nodes.map((node) => node.fqn)).toEqual([
      'shop.web',
      'shop.domain',
      'shop.service',
    ]);
  });

  it('treats % and _ in a query as literal characters', () => {
    expect(findNode(db, runId, { query: '%' }).total).toBe(0);
  });

  it('reports coverage so that no match is not read as no such thing', () => {
    const empty = openDatabase(':memory:');
    expect(findNode(db, runId, { query: 'Nonexistent' })).toEqual({
      covered: true,
      total: 0,
      nodes: [],
    });
    empty.close();
  });
});

describe('queryDependencies', () => {
  beforeEach(seedShop);

  it('aggregates a package to its neighbours, with edges to check it by', () => {
    const result = queryDependencies(db, runId, { fqn: 'shop.web' });

    expect(result.found).toBe(true);
    expect(result.granularity).toBe('package');
    expect(result.dependsOn).toHaveLength(1);
    expect(result.dependsOn[0]).toMatchObject({
      fqn: 'shop.service',
      kind: 'package',
      weight: 2,
      edgeKinds: ['calls', 'injects'],
    });
    expect(result.dependsOn[0]?.examples[0]).toEqual({
      kind: 'injects',
      from: 'shop.web.OrderController',
      to: 'shop.service.OrderService',
      file: 'src/shop/web/OrderController.java',
      line: 12,
    });
    expect(result.dependedOnBy).toEqual([]);
  });

  it('rolls a type up to the types it depends on, methods included', () => {
    const result = queryDependencies(db, runId, { fqn: 'shop.web.OrderController' });

    expect(result.granularity).toBe('type');
    expect(result.dependsOn).toHaveLength(1);
    expect(result.dependsOn[0]).toMatchObject({
      fqn: 'shop.service.OrderService',
      kind: 'class',
      weight: 2,
      edgeKinds: ['calls', 'injects'],
    });
    // The call is on a method of the controller, so a type-level answer that
    // only looked at the class node would miss it.
    expect(result.dependsOn[0]?.examples.map((e) => e.kind).sort()).toEqual([
      'calls',
      'injects',
    ]);
  });

  it('says the subject is absent rather than returning an empty answer', () => {
    const result = queryDependencies(db, runId, { fqn: 'shop.nope.Missing' });
    expect(result).toMatchObject({ found: false, covered: true, dependsOn: [] });
  });
});

describe('findCallers', () => {
  beforeEach(seedShop);

  it('finds calls into a method with the line of the call site', () => {
    const result = findCallers(db, runId, { fqn: 'shop.service.OrderService#findAll()' });

    expect(result.total).toBe(1);
    expect(result.callers[0]).toEqual({
      caller: 'shop.web.OrderController#list()',
      callerKind: 'method',
      callee: 'shop.service.OrderService#findAll()',
      file: 'src/shop/web/OrderController.java',
      line: 21,
      edgeKind: 'calls',
    });
  });

  it('counts a type as called when anything it declares is called, and counts injection', () => {
    const result = findCallers(db, runId, { fqn: 'shop.service.OrderService' });

    expect(result.callers.map((row) => row.edgeKind).sort()).toEqual(['calls', 'injects']);
  });

  it('does not report a type as calling itself', () => {
    const result = findCallers(db, runId, { fqn: 'shop.web.OrderController' });
    expect(result.callers).toEqual([]);
    expect(result.covered).toBe(true);
  });
});

describe('listEndpoints', () => {
  beforeEach(seedShop);

  it('lists the HTTP surface with the method that serves it', () => {
    const result = listEndpoints(db, runId, {});

    expect(result.covered).toBe(true);
    expect(result.endpoints).toEqual([
      {
        fqn: 'GET /api/orders',
        httpMethod: 'GET',
        path: '/api/orders',
        framework: 'spring-mvc',
        handler: 'shop.web.OrderController#list()',
        file: 'src/shop/web/OrderController.java',
        line: 19,
      },
    ]);
  });

  it('filters by path fragment and by verb', () => {
    expect(listEndpoints(db, runId, { contains: '/api/orders' }).total).toBe(1);
    expect(listEndpoints(db, runId, { contains: '/api/users' }).total).toBe(0);
    expect(listEndpoints(db, runId, { httpMethod: 'get' }).total).toBe(1);
    expect(listEndpoints(db, runId, { httpMethod: 'POST' }).total).toBe(0);
  });

  it('says nothing was extracted rather than reporting no endpoints', () => {
    const result = listEndpoints(db, runId + 99, {});
    expect(result.covered).toBe(false);
    expect(result.note).toContain('No endpoints were extracted');
  });
});

describe('describeModule', () => {
  beforeEach(() => {
    seedShop();
    seedHistory();
  });

  it('assembles members, endpoints, dependencies and history for a package', () => {
    const result = describeModule(db, runId, { fqn: 'shop.web' });

    expect(result.found).toBe(true);
    expect(result.members.map((member) => member.fqn)).toEqual(['shop.web.OrderController']);
    expect(result.endpoints[0]?.fqn).toBe('GET /api/orders');
    expect(result.dependsOn[0]?.fqn).toBe('shop.service');
    expect(result.history).toEqual({
      files: 1,
      commits: 40,
      churn: 900,
      authors: 1,
      lastChangeAt: '2024-02-01T00:00:00.000Z',
    });
  });

  it('reports the table a package maps, with the line that declares it', () => {
    const result = describeModule(db, runId, { fqn: 'shop.domain' });

    expect(result.tables).toEqual([
      {
        table: 'orders',
        mappedBy: 'shop.domain.Order',
        file: 'src/shop/domain/Order.java',
        line: 6,
      },
    ]);
  });

  it('keeps a model-authored cluster name out of the structural answer', () => {
    const clusterId = Number(
      db
        .prepare(
          `INSERT INTO cluster (run_id, algorithm, label, name, description, authored_by, model)
           VALUES (?, 'louvain', 0, 'Ordering', 'Handles orders', 'model', 'claude-opus-5')`,
        )
        .run(runId).lastInsertRowid,
    );
    for (const fqn of ['shop.web', 'shop.service']) {
      db.prepare(
        `INSERT INTO cluster_member (cluster_id, node_id)
         SELECT ?, id FROM node WHERE run_id = ? AND kind = 'package' AND fqn = ?`,
      ).run(clusterId, runId, fqn);
    }

    const result = describeModule(db, runId, { fqn: 'shop.web' });

    expect(result.cluster).toEqual({
      clusterId,
      label: 0,
      memberCount: 2,
      siblings: ['shop.service'],
      interpretation: {
        name: 'Ordering',
        description: 'Handles orders',
        authoredBy: 'model',
        model: 'claude-opus-5',
      },
    });
  });

  it('refuses a type and says which tool to use instead', () => {
    const result = describeModule(db, runId, { fqn: 'shop.web.OrderController' });

    expect(result.found).toBe(false);
    expect(result.note).toContain('is a class, not a package');
  });

  it('returns no history rather than zeroes when none was mined', () => {
    const result = describeModule(db, runId, { fqn: 'shop.domain' });
    expect(result.history).toBeNull();
  });
});

describe('findHotspots', () => {
  it('ranks by churn x complexity and carries the ownership numbers', () => {
    seedShop();
    seedHistory();

    const result = findHotspots(db, runId, {});

    expect(result.covered).toBe(true);
    expect(result.files[0]).toMatchObject({
      path: 'src/shop/web/OrderController.java',
      commits: 40,
      churn: 900,
      complexity: 12,
      score: 10800,
      busFactor: 1,
      topAuthor: 'ada@example.invalid',
    });
  });

  it('ranks bus factor separately', () => {
    seedShop();
    seedHistory();

    const result = findHotspots(db, runId, { ranking: 'bus-factor', minCommits: 5 });

    expect(result.files.map((file) => file.path)).toEqual([
      'src/shop/web/OrderController.java',
      'src/shop/service/OrderService.java',
    ]);
  });

  it('says no history was mined rather than reporting no hotspots', () => {
    seedShop();

    const result = findHotspots(db, runId, {});

    expect(result).toMatchObject({ covered: false, files: [] });
    expect(result.note).toContain('stratigraph history');
  });
});

describe('traceToTable', () => {
  beforeEach(seedShop);

  it('reports the declared mapping and one citable hop out from it', () => {
    const result = traceToTable(db, runId, { table: 'Orders' });

    expect(result.found).toBe(true);
    expect(result.mappedBy).toEqual([
      { fqn: 'shop.domain.Order', file: 'src/shop/domain/Order.java', line: 6 },
    ]);
    // `imports` is not a call, so nothing reaches the entity by calling it —
    // and the tool says so rather than chaining edges until it can.
    expect(result.reachedFrom).toEqual([]);
    expect(result.limits).toContain('nothing here claims that a query ran');
  });

  it('finds a table by its declared spelling as well as its lower-cased fqn', () => {
    expect(traceToTable(db, runId, { table: 'orders' }).found).toBe(true);
    expect(traceToTable(db, runId, { table: ' ORDERS ' }).found).toBe(true);
  });

  it('says the table is absent rather than returning an empty trace', () => {
    const result = traceToTable(db, runId, { table: 'invoices' });
    expect(result).toMatchObject({ found: false, table: null, mappedBy: [] });
  });
});

describe('checkCycle', () => {
  it('finds a path each way and cites the edges that make each hop', () => {
    seedShop();
    seedCycle();

    const result = checkCycle(db, runId, { from: 'shop.web', to: 'shop.domain' });

    expect(result.cyclic).toBe(true);
    expect(result.forward?.path).toEqual(['shop.web', 'shop.service', 'shop.domain']);
    expect(result.backward?.path).toEqual(['shop.domain', 'shop.web']);
    expect(result.backward?.hops[0]?.evidence[0]).toMatchObject({
      kind: 'imports',
      srcFqn: 'shop.domain.Order',
      dstFqn: 'shop.web.OrderController',
      path: 'src/shop/domain/Order.java',
      line: 9,
    });
  });

  it('reports a one-way dependency as not cyclic', () => {
    seedShop();

    const result = checkCycle(db, runId, { from: 'shop.web', to: 'shop.domain' });

    expect(result.cyclic).toBe(false);
    expect(result.forward?.path).toEqual(['shop.web', 'shop.service', 'shop.domain']);
    expect(result.backward).toBeNull();
  });

  it('names which package it could not resolve', () => {
    seedShop();

    const result = checkCycle(db, runId, { from: 'shop.web', to: 'shop.nope' });

    expect(result).toMatchObject({ found: false, missing: ['shop.nope'], cyclic: false });
  });

  it('says the graph is empty rather than reporting independence', () => {
    const result = checkCycle(db, runId, { from: 'a', to: 'b' });

    expect(result.covered).toBe(false);
    expect(result.note).toContain('nothing was extracted');
  });
});
