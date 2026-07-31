import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';
import { setQuiet } from '../src/log.js';
import { buildC4Model, elementId, hostOf, type C4Diagram } from '../src/present/c4.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;
let runId: number;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-c4-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
});

afterEach(() => {
  if (db.open) db.close();
});

function seed(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

const JAVA_META = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };
const TS_META = { v: 1, type: 'meta', extractor: 'typescript', extractorVersion: '0.0.0' };

/**
 * A two-container repository: a Maven module with a package and an entity
 * mapped to a table, and an npm package with a service that calls it.
 */
function seedFullStack(): void {
  seed([
    JAVA_META,
    { v: 1, type: 'file', path: 'server/src/shop/OrderController.java', language: 'java' },
    { v: 1, type: 'file', path: 'server/src/shop/Order.java', language: 'java' },
    { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
    {
      v: 1,
      type: 'node',
      kind: 'package',
      fqn: 'shop',
      name: 'shop',
      parent: { kind: 'module', fqn: 'server' },
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'shop.OrderController',
      name: 'OrderController',
      parent: { kind: 'package', fqn: 'shop' },
      file: 'server/src/shop/OrderController.java',
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'shop.Order',
      name: 'Order',
      parent: { kind: 'package', fqn: 'shop' },
      file: 'server/src/shop/Order.java',
    },
    { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
    {
      v: 1,
      type: 'edge',
      kind: 'maps_to',
      src: { kind: 'class', fqn: 'shop.Order' },
      dst: { kind: 'table', fqn: 'orders' },
      file: 'server/src/shop/Order.java',
      line: 12,
    },
  ]);

  seed([
    TS_META,
    { v: 1, type: 'file', path: 'web/src/app/order.service.ts', language: 'typescript' },
    { v: 1, type: 'node', kind: 'module', fqn: 'web', name: 'web' },
    {
      v: 1,
      type: 'node',
      kind: 'package',
      fqn: 'web/src/app',
      name: 'app',
      parent: { kind: 'module', fqn: 'web' },
    },
    {
      v: 1,
      type: 'node',
      kind: 'service',
      fqn: 'web/src/app/order.service.ts#OrderService',
      name: 'OrderService',
      parent: { kind: 'package', fqn: 'web/src/app' },
      file: 'web/src/app/order.service.ts',
    },
  ]);
}

/** A method carrying observed HTTP call sites, the way the TS extractor writes them. */
function seedHttpCalls(calls: Array<{ method: string; url: string; line: number }>): void {
  seed([
    TS_META,
    {
      v: 1,
      type: 'node',
      kind: 'method',
      fqn: 'web/src/app/order.service.ts#OrderService.list',
      name: 'list',
      parent: { kind: 'service', fqn: 'web/src/app/order.service.ts#OrderService' },
      file: 'web/src/app/order.service.ts',
      attrs: { httpCalls: calls },
    },
  ]);
}

function diagramFor(top = 20): ReturnType<typeof buildC4Model> {
  return buildC4Model(db, runId, { top });
}

function names(diagram: C4Diagram): string[] {
  return diagram.elements.map((element) => `${element.kind}:${element.name}`);
}

describe('the context diagram', () => {
  it('draws the system and its data store, and never a person', () => {
    seedFullStack();
    const { context } = diagramFor();

    expect(names(context)).toEqual(['system:tiny-java', 'datastore:Database']);
    expect(context.elements.some((element) => element.kind === ('person' as never))).toBe(false);
    expect(context.notes[0]).toContain('No fact in this run identifies a person');
  });

  it('omits the data store when no table was observed, and says so', () => {
    seed([
      JAVA_META,
      { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
    ]);
    const { context } = diagramFor();

    expect(names(context)).toEqual(['system:tiny-java']);
    expect(context.notes.join('\n')).toContain('No table mapping was observed');
  });

  it('cites the table it drew the data store from', () => {
    seedFullStack();
    const { context } = diagramFor();
    const datastore = context.elements.find((element) => element.kind === 'datastore');

    expect(datastore?.description).toBe('1 table(s) observed');
    expect(datastore?.evidence).toEqual([
      { kind: 'node', label: 'orders', path: null, line: null },
    ]);
  });

  it('makes an absolute URL an external system, and a relative one nothing', () => {
    seedFullStack();
    seedHttpCalls([
      { method: 'GET', url: 'https://api.example.invalid/v1/rates', line: 8 },
      { method: 'GET', url: '/api/orders', line: 9 },
    ]);
    const { context } = diagramFor();

    expect(names(context)).toEqual([
      'system:tiny-java',
      'datastore:Database',
      'external:api.example.invalid',
    ]);
    const external = context.elements.find((element) => element.kind === 'external');
    expect(external?.description).toBe('1 call site(s) name this host');
    expect(external?.evidence).toEqual([
      {
        kind: 'node',
        label: 'GET https://api.example.invalid/v1/rates in web/src/app/order.service.ts#OrderService.list',
        path: 'web/src/app/order.service.ts',
        line: 8,
      },
    ]);
  });

  it('states that it found no external system when it found none', () => {
    seedFullStack();
    const { context } = diagramFor();
    expect(context.notes.join('\n')).toContain('No absolute URL appears in any literal');
  });

  it('calls the relationship to an external host observed, not inferred', () => {
    seedFullStack();
    seedHttpCalls([{ method: 'POST', url: 'https://api.example.invalid/v1/x', line: 3 }]);
    const { context } = diagramFor();
    const toExternal = context.relationships.find((r) => r.to.startsWith('external_'));

    expect(toExternal?.confidence).toBe('fact');
    expect(toExternal?.label).toBe('POST');
  });
});

describe('hostOf', () => {
  it('reads the host of an absolute URL and lowercases it', () => {
    expect(hostOf('https://API.Example.Invalid/v1')).toBe('api.example.invalid');
    expect(hostOf('http://localhost:8080/api')).toBe('localhost:8080');
  });

  it('refuses anything without a readable host', () => {
    expect(hostOf('/api/orders')).toBeNull();
    expect(hostOf('{}/{}')).toBeNull();
    // The extractor reduced the host itself to an interpolation, so there is
    // nothing to name and guessing one is exactly what ADR-0019 forbids.
    expect(hostOf('https://{}/v1/rates')).toBeNull();
  });
});

describe('the container diagram', () => {
  it('draws one container per build module, labelled with observed languages', () => {
    seedFullStack();
    const { container } = diagramFor();

    expect(names(container)).toEqual([
      'container:server',
      'container:web',
      'datastore:Database',
    ]);
    const server = container.elements.find((element) => element.name === 'server');
    expect(server?.technology).toBe('java');
    expect(server?.description).toBe('1 package(s), 2 type(s)');
    expect(container.elements.find((element) => element.name === 'web')?.technology).toBe(
      'typescript',
    );
  });

  it('connects a container to the data store with the edge kinds it observed', () => {
    seedFullStack();
    const { container } = diagramFor();
    const toStore = container.relationships.find((r) => r.to === 'datastore');

    expect(toStore?.from).toBe(elementId('container', 'server'));
    expect(toStore?.label).toBe('maps_to');
    expect(toStore?.count).toBe(1);
    expect(toStore?.evidence).toEqual([
      {
        kind: 'edge',
        label: 'maps_to → orders',
        path: 'server/src/shop/Order.java',
        line: 12,
      },
    ]);
  });

  it('keeps an inferred cross-stack call inferred, and separate from observed edges', () => {
    seedFullStack();
    seed([
      TS_META,
      {
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'service', fqn: 'web/src/app/order.service.ts#OrderService' },
        dst: { kind: 'class', fqn: 'shop.OrderController' },
        file: 'web/src/app/order.service.ts',
        line: 2,
      },
      {
        v: 1,
        type: 'edge',
        kind: 'http_calls',
        src: { kind: 'service', fqn: 'web/src/app/order.service.ts#OrderService' },
        dst: { kind: 'class', fqn: 'shop.OrderController' },
        file: 'web/src/app/order.service.ts',
        line: 9,
        confidence: 'inferred',
      },
    ]);

    const { container } = diagramFor();
    const webToServer = container.relationships.filter(
      (r) => r.from === elementId('container', 'web') && r.to === elementId('container', 'server'),
    );

    // Two lines, not one: an observed import and a guessed HTTP call are
    // different claims and must not merge into a single confident edge.
    expect(webToServer.map((r) => [r.label, r.confidence])).toEqual([
      ['imports', 'fact'],
      ['http_calls', 'inferred'],
    ]);
    expect(container.notes.join('\n')).toContain('1 relationship(s) are inferred');
  });

  it('says so when the repository is a single module', () => {
    seed([
      JAVA_META,
      { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
    ]);
    expect(diagramFor().container.notes.join('\n')).toContain('One container');
  });

  it('says so when nothing was extracted at all', () => {
    expect(diagramFor().container.notes.join('\n')).toContain('No build module was observed');
  });
});

describe('the component diagrams', () => {
  it('draws one per container, holding that container’s packages', () => {
    seedFullStack();
    const { components } = diagramFor();

    expect(components.map((diagram) => diagram.scope)).toEqual(['server', 'web']);
    expect(names(components[0] as C4Diagram)).toEqual(['component:shop']);
    expect(names(components[1] as C4Diagram)).toEqual(['component:web/src/app']);
  });

  it('carries the file and line of every edge behind a dependency', () => {
    seed([
      JAVA_META,
      { v: 1, type: 'file', path: 'server/src/a/A.java', language: 'java' },
      { v: 1, type: 'file', path: 'server/src/b/B.java', language: 'java' },
      { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
      {
        v: 1,
        type: 'node',
        kind: 'package',
        fqn: 'a',
        name: 'a',
        parent: { kind: 'module', fqn: 'server' },
      },
      {
        v: 1,
        type: 'node',
        kind: 'package',
        fqn: 'b',
        name: 'b',
        parent: { kind: 'module', fqn: 'server' },
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'a.A',
        name: 'A',
        parent: { kind: 'package', fqn: 'a' },
        file: 'server/src/a/A.java',
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B',
        name: 'B',
        parent: { kind: 'package', fqn: 'b' },
        file: 'server/src/b/B.java',
      },
      {
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: 'a.A' },
        dst: { kind: 'class', fqn: 'b.B' },
        file: 'server/src/a/A.java',
        line: 3,
      },
    ]);

    const [diagram] = diagramFor().components;
    expect(diagram?.relationships).toEqual([
      {
        from: elementId('component', 'a'),
        to: elementId('component', 'b'),
        label: 'imports',
        count: 1,
        confidence: 'fact',
        evidence: [
          {
            kind: 'edge',
            label: 'imports a.A → b.B',
            path: 'server/src/a/A.java',
            line: 3,
          },
        ],
      },
    ]);
  });

  it('caps the diagram and says what it left out', () => {
    const facts: object[] = [
      JAVA_META,
      { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
    ];
    for (let i = 0; i < 5; i += 1) {
      facts.push({
        v: 1,
        type: 'node',
        kind: 'package',
        fqn: `p${i}`,
        name: `p${i}`,
        parent: { kind: 'module', fqn: 'server' },
      });
    }
    seed(facts);

    const [diagram] = buildC4Model(db, runId, { top: 2 }).components;
    expect(diagram?.elements).toHaveLength(2);
    expect(diagram?.notes.join('\n')).toContain('Showing 2 of 5 packages');
  });

  it('marks a model-authored cluster name as inference, and an algorithmic one not', () => {
    seedFullStack();
    const packageId = (
      db.prepare(`SELECT id FROM node WHERE run_id = ? AND fqn = 'shop'`).get(runId) as {
        id: number;
      }
    ).id;
    const clusterId = Number(
      db
        .prepare(
          `INSERT INTO cluster (run_id, algorithm, label, name, authored_by, model)
           VALUES (?, 'louvain', 0, 'Ordering', 'model', 'claude-opus-5')`,
        )
        .run(runId).lastInsertRowid,
    );
    db.prepare(`INSERT INTO cluster_member (cluster_id, node_id) VALUES (?, ?)`).run(
      clusterId,
      packageId,
    );

    const [diagram] = diagramFor().components;
    expect(diagram?.elements[0]?.group).toBe('Ordering');
    expect(diagram?.elements[0]?.groupInference).toBe(true);
    expect(diagram?.notes.join('\n')).toContain('written by a model');
  });

  it('falls back to the algorithm’s own label when no model named the cluster', () => {
    seedFullStack();
    const packageId = (
      db.prepare(`SELECT id FROM node WHERE run_id = ? AND fqn = 'shop'`).get(runId) as {
        id: number;
      }
    ).id;
    const clusterId = Number(
      db
        .prepare(
          `INSERT INTO cluster (run_id, algorithm, label, authored_by) VALUES (?, 'louvain', 7, 'algorithm')`,
        )
        .run(runId).lastInsertRowid,
    );
    db.prepare(`INSERT INTO cluster_member (cluster_id, node_id) VALUES (?, ?)`).run(
      clusterId,
      packageId,
    );

    const [diagram] = diagramFor().components;
    expect(diagram?.elements[0]?.group).toBe('cluster 7');
    expect(diagram?.elements[0]?.groupInference).toBe(false);
  });
});

describe('elementId', () => {
  it('produces an identifier both diagram formats accept', () => {
    expect(elementId('component', 'com.shop.billing')).toBe('component_com_shop_billing');
    expect(elementId('component', 'web/src/app')).toBe('component_web_src_app');
    expect(elementId('external', 'api.example.invalid')).toBe('external_api_example_invalid');
  });

  it('keeps a module and a package of the same name apart', () => {
    expect(elementId('container', 'web')).not.toBe(elementId('component', 'web'));
  });
});
