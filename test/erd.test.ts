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
import { buildClassDiagrams } from '../src/present/classes.js';
import { buildErModel, shortType } from '../src/present/erd.js';
import { toClassMermaid, toErMermaid } from '../src/present/mermaid.js';
import { buildHttpSurface, buildDependencyMatrix } from '../src/present/surface.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;
let runId: number;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-erd-'));
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

const META = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

function classNode(fqn: string, name: string, file = 'src/Shop.java'): object {
  return {
    v: 1,
    type: 'node',
    kind: 'class',
    fqn,
    name,
    parent: { kind: 'package', fqn: 'shop' },
    file,
    startLine: 5,
  };
}

function field(owner: string, name: string, attrs: object, line = 10): object {
  return {
    v: 1,
    type: 'node',
    kind: 'field',
    fqn: `${owner}#${name}`,
    name,
    parent: { kind: 'class', fqn: owner },
    file: 'src/Shop.java',
    startLine: line,
    attrs,
  };
}

function edge(kind: string, src: [string, string], dst: [string, string], line = 3): object {
  return {
    v: 1,
    type: 'edge',
    kind,
    src: { kind: src[0], fqn: src[1] },
    dst: { kind: dst[0], fqn: dst[1] },
    file: 'src/Shop.java',
    line,
  };
}

/** Two entities, one inherited primary key, one readable collection association. */
function seedSchema(): void {
  seed([
    META,
    { v: 1, type: 'file', path: 'src/Shop.java', language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
    classNode('shop.BaseEntity', 'BaseEntity'),
    classNode('shop.Order', 'Order'),
    classNode('shop.OrderLine', 'OrderLine'),
    { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
    { v: 1, type: 'node', kind: 'table', fqn: 'order_lines', name: 'order_lines' },

    field('shop.BaseEntity', 'id', { type: 'java.lang.Long', modifiers: ['private'], id: true }, 6),
    field('shop.Order', 'customerRef', {
      type: 'java.lang.String',
      modifiers: ['private'],
      column: 'customer_ref',
    }),
    field('shop.Order', 'lines', {
      type: 'java.util.List',
      typeArguments: ['shop.OrderLine'],
      modifiers: ['private'],
    }),
    field('shop.OrderLine', 'quantity', { type: 'int', modifiers: ['private'] }),

    edge('extends', ['class', 'shop.Order'], ['class', 'shop.BaseEntity']),
    edge('extends', ['class', 'shop.OrderLine'], ['class', 'shop.BaseEntity']),
    edge('maps_to', ['class', 'shop.Order'], ['table', 'orders'], 4),
    edge('maps_to', ['class', 'shop.OrderLine'], ['table', 'order_lines'], 4),
    edge(
      'annotated_with',
      ['field', 'shop.Order#lines'],
      ['annotation', 'jakarta.persistence.OneToMany'],
    ),
    edge('annotated_with', ['field', 'shop.BaseEntity#id'], ['annotation', 'jakarta.persistence.Id']),
  ]);
}

describe('the ER model', () => {
  it('makes a table the entity, and names the class that maps to it', () => {
    seedSchema();
    const model = buildErModel(db, runId);

    expect(model.entities.map((entity) => [entity.table, entity.className])).toEqual([
      ['order_lines', 'shop.OrderLine'],
      ['orders', 'shop.Order'],
    ]);
  });

  it('carries inherited columns into the table they are mapped into', () => {
    // JPA maps a mapped-superclass chain into the subclass's table, so an
    // entity whose `id` is declared on a base class still has that column.
    seedSchema();
    const orders = buildErModel(db, runId).entities.find((e) => e.table === 'orders');

    expect(orders?.columns).toEqual([
      {
        name: 'customer_ref',
        field: 'customerRef',
        type: 'String',
        primaryKey: false,
        inherited: false,
        path: 'src/Shop.java',
        line: 10,
      },
      {
        name: 'id',
        field: 'id',
        type: 'Long',
        primaryKey: true,
        inherited: true,
        path: 'src/Shop.java',
        line: 6,
      },
    ]);
  });

  it('prefers the column name the mapping states over the field name', () => {
    seedSchema();
    const orders = buildErModel(db, runId).entities.find((e) => e.table === 'orders');
    const column = orders?.columns.find((c) => c.field === 'customerRef');
    expect(column?.name).toBe('customer_ref');
  });

  it('reads a collection association through the recorded type argument', () => {
    // The whole reason the extractor records them: `List<OrderLine>` erases to
    // `java.util.List`, and without the argument this relationship is a dead end.
    seedSchema();
    expect(buildErModel(db, runId).relationships).toEqual([
      {
        fromTable: 'orders',
        toTable: 'order_lines',
        cardinality: 'one-to-many',
        via: 'lines',
        path: 'src/Shop.java',
        line: 10,
      },
    ]);
  });

  it('reads a direct association from the field’s own type', () => {
    seedSchema();
    seed([
      classNode('shop.Customer', 'Customer'),
      { v: 1, type: 'node', kind: 'table', fqn: 'customers', name: 'customers' },
      edge('maps_to', ['class', 'shop.Customer'], ['table', 'customers'], 4),
      field('shop.Order', 'customer', { type: 'shop.Customer', modifiers: ['private'] }, 12),
      edge(
        'annotated_with',
        ['field', 'shop.Order#customer'],
        ['annotation', 'jakarta.persistence.ManyToOne'],
      ),
    ]);

    const relationship = buildErModel(db, runId).relationships.find((r) => r.via === 'customer');
    expect(relationship).toMatchObject({
      fromTable: 'orders',
      toTable: 'customers',
      cardinality: 'many-to-one',
    });
  });

  it('refuses to guess a target it cannot read, and says why', () => {
    seed([
      META,
      { v: 1, type: 'file', path: 'src/Shop.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.Order', 'Order'),
      { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
      edge('maps_to', ['class', 'shop.Order'], ['table', 'orders'], 4),
      // A collection whose element type nobody could attribute.
      field('shop.Order', 'lines', { type: 'java.util.List', modifiers: ['private'] }, 14),
      edge(
        'annotated_with',
        ['field', 'shop.Order#lines'],
        ['annotation', 'jakarta.persistence.OneToMany'],
      ),
    ]);

    const model = buildErModel(db, runId);
    expect(model.relationships).toEqual([]);
    expect(model.unreadable).toEqual([
      {
        fromTable: 'orders',
        via: 'lines',
        cardinality: 'one-to-many',
        declaredType: 'java.util.List',
        reason: 'the declared type erases to List and no type argument was attributed',
        path: 'src/Shop.java',
        line: 14,
      },
    ]);
    expect(model.notes.join('\n')).toContain('could not be drawn');
  });

  it('keeps an association out of the column list', () => {
    // A foreign key is the line between two tables, not a scalar column in one.
    seedSchema();
    const orders = buildErModel(db, runId).entities.find((e) => e.table === 'orders');
    expect(orders?.columns.some((column) => column.field === 'lines')).toBe(false);
  });

  it('omits a transient field entirely', () => {
    seedSchema();
    seed([
      field('shop.Order', 'cached', { type: 'java.lang.String', modifiers: ['private'] }, 20),
      edge(
        'annotated_with',
        ['field', 'shop.Order#cached'],
        ['annotation', 'jakarta.persistence.Transient'],
      ),
    ]);
    const orders = buildErModel(db, runId).entities.find((e) => e.table === 'orders');
    expect(orders?.columns.some((column) => column.field === 'cached')).toBe(false);
  });

  it('says the schema is unreadable rather than empty when nothing is mapped', () => {
    seed([META, { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' }]);
    const model = buildErModel(db, runId);
    expect(model.entities).toEqual([]);
    expect(model.notes.join('\n')).toContain('No class in this run is mapped to a table');
    expect(model.notes.join('\n')).toContain('invisible to a source parser');
  });

  it('survives an inheritance cycle rather than looping on it', () => {
    // Impossible in valid Java, perfectly possible in a fact table built from
    // a repository that does not compile.
    seed([
      META,
      { v: 1, type: 'file', path: 'src/Shop.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.A', 'A'),
      classNode('shop.B', 'B'),
      { v: 1, type: 'node', kind: 'table', fqn: 'a_table', name: 'a_table' },
      edge('maps_to', ['class', 'shop.A'], ['table', 'a_table'], 4),
      edge('extends', ['class', 'shop.A'], ['class', 'shop.B']),
      edge('extends', ['class', 'shop.B'], ['class', 'shop.A']),
    ]);
    expect(buildErModel(db, runId).entities).toHaveLength(1);
  });

  it('renders a Mermaid erDiagram with the primary key marked', () => {
    seedSchema();
    const mermaid = toErMermaid(buildErModel(db, runId));

    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('  orders {');
    expect(mermaid).toContain('Long id PK "inherited"');
    expect(mermaid).toContain('  orders ||--o{ order_lines : "lines"');
  });

  it('puts an undrawable association in a comment, not a line to a guess', () => {
    seed([
      META,
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.Order', 'Order'),
      { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
      edge('maps_to', ['class', 'shop.Order'], ['table', 'orders'], 4),
      field('shop.Order', 'lines', { type: 'java.util.List', modifiers: ['private'] }, 14),
      edge(
        'annotated_with',
        ['field', 'shop.Order#lines'],
        ['annotation', 'jakarta.persistence.OneToMany'],
      ),
    ]);

    const mermaid = toErMermaid(buildErModel(db, runId));
    expect(mermaid).toContain('%% orders.lines declares a one-to-many relationship, not drawn');
    expect(mermaid).not.toMatch(/orders \|\|--o\{/);
  });
});

describe('shortType', () => {
  it('drops the packages nobody reads in a column list', () => {
    expect(shortType('java.lang.String')).toBe('String');
    expect(shortType('java.time.LocalDate')).toBe('LocalDate');
    expect(shortType('com.example.shop.Order')).toBe('Order');
    expect(shortType('int')).toBe('int');
  });
});

describe('class diagrams', () => {
  function seedTypes(): void {
    seed([
      META,
      { v: 1, type: 'file', path: 'src/Shop.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.BaseEntity', 'BaseEntity'),
      classNode('shop.Order', 'Order'),
      {
        v: 1,
        type: 'node',
        kind: 'interface',
        fqn: 'shop.Auditable',
        name: 'Auditable',
        parent: { kind: 'package', fqn: 'shop' },
        file: 'src/Shop.java',
        startLine: 2,
      },
      field('shop.Order', 'total', { type: 'java.math.BigDecimal', modifiers: ['private'] }),
      field('shop.Order', 'base', { type: 'shop.BaseEntity', modifiers: ['private'] }, 11),
      {
        v: 1,
        type: 'node',
        kind: 'method',
        fqn: 'shop.Order#total()',
        name: 'total',
        parent: { kind: 'class', fqn: 'shop.Order' },
        file: 'src/Shop.java',
        startLine: 20,
        attrs: { modifiers: ['public'], returns: 'java.math.BigDecimal' },
      },
      edge('extends', ['class', 'shop.Order'], ['class', 'shop.BaseEntity']),
      edge('implements', ['class', 'shop.Order'], ['interface', 'shop.Auditable']),
      edge('annotated_with', ['class', 'shop.Order'], ['annotation', 'jakarta.persistence.Entity']),
    ]);
  }

  it('draws one diagram per package, with members as declared', () => {
    seedTypes();
    const { diagrams } = buildClassDiagrams(db, runId, { top: 10, maxDiagrams: 5 });

    expect(diagrams).toHaveLength(1);
    const order = diagrams[0]?.classes.find((box) => box.name === 'Order');
    expect(order?.stereotype).toBe('entity');
    expect(order?.fields.map((f) => f.text)).toEqual(['-total: BigDecimal', '-base: BaseEntity']);
    expect(order?.methods.map((m) => m.text)).toEqual(['+total(): BigDecimal']);
  });

  it('distinguishes extends, implements and association', () => {
    seedTypes();
    const [diagram] = buildClassDiagrams(db, runId, { top: 10, maxDiagrams: 5 }).diagrams;

    // Sorted by source, then target, then kind — so the Auditable link comes
    // first, and the two links to BaseEntity are ordered by their own kind.
    expect(diagram?.links.map((link) => [link.kind, link.via])).toEqual([
      ['implements', null],
      ['association', 'base'],
      ['extends', null],
    ]);
  });

  it('renders UML arrows in the Mermaid class diagram', () => {
    seedTypes();
    const [diagram] = buildClassDiagrams(db, runId, { top: 10, maxDiagrams: 5 }).diagrams;
    const mermaid = toClassMermaid(diagram as NonNullable<typeof diagram>);

    expect(mermaid).toContain('classDiagram');
    expect(mermaid).toContain('    <<entity>>');
    expect(mermaid).toContain('  BaseEntity <|-- Order');
    expect(mermaid).toContain('  Auditable <|.. Order');
    expect(mermaid).toContain('  Order --> BaseEntity : base');
  });

  it('caps the types drawn and says how many it left out', () => {
    const facts: object[] = [
      META,
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
    ];
    for (let n = 0; n < 6; n += 1) facts.push(classNode(`shop.C${n}`, `C${n}`));
    seed(facts);

    const [diagram] = buildClassDiagrams(db, runId, { top: 2, maxDiagrams: 5 }).diagrams;
    expect(diagram?.classes).toHaveLength(2);
    expect(diagram?.notes.join('\n')).toContain('Showing 2 of 6 types');
  });

  it('counts the package diagrams it did not produce', () => {
    seed([
      META,
      { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
      { v: 1, type: 'node', kind: 'package', fqn: 'b', name: 'b' },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'a.A',
        name: 'A',
        parent: { kind: 'package', fqn: 'a' },
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B',
        name: 'B',
        parent: { kind: 'package', fqn: 'b' },
      },
    ]);

    const { diagrams, skipped } = buildClassDiagrams(db, runId, { top: 10, maxDiagrams: 1 });
    expect(diagrams).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('marks a supertype declared outside the package rather than dropping it', () => {
    seed([
      META,
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.Repo', 'Repo'),
      edge('extends', ['class', 'shop.Repo'], ['class', 'org.springframework.JpaRepository']),
    ]);

    const [diagram] = buildClassDiagrams(db, runId, { top: 10, maxDiagrams: 5 }).diagrams;
    expect(diagram?.links[0]).toMatchObject({ external: true, toFqn: 'org.springframework.JpaRepository' });
    expect(diagram?.notes.join('\n')).toContain('declared outside this package');
  });
});

describe('the HTTP surface', () => {
  it('pairs every endpoint with the method that handles it', () => {
    seed([
      META,
      { v: 1, type: 'file', path: 'src/Api.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'shop', name: 'shop' },
      classNode('shop.Api', 'Api', 'src/Api.java'),
      {
        v: 1,
        type: 'node',
        kind: 'method',
        fqn: 'shop.Api#list()',
        name: 'list',
        parent: { kind: 'class', fqn: 'shop.Api' },
        file: 'src/Api.java',
      },
      {
        v: 1,
        type: 'node',
        kind: 'endpoint',
        fqn: 'GET /orders',
        name: 'GET /orders',
        attrs: { method: 'GET', path: '/orders', framework: 'spring-mvc' },
      },
      {
        v: 1,
        type: 'edge',
        kind: 'handles',
        src: { kind: 'method', fqn: 'shop.Api#list()' },
        dst: { kind: 'endpoint', fqn: 'GET /orders' },
        file: 'src/Api.java',
        line: 18,
      },
    ]);

    const surface = buildHttpSurface(db, runId);
    expect(surface.endpoints).toEqual([
      {
        method: 'GET',
        path: '/orders',
        handler: 'shop.Api#list()',
        file: 'src/Api.java',
        line: 18,
        framework: 'spring-mvc',
      },
    ]);
    expect(surface.unhandled).toBe(0);
  });

  it('counts an endpoint nothing claims to serve', () => {
    seed([
      META,
      {
        v: 1,
        type: 'node',
        kind: 'endpoint',
        fqn: 'GET /orphan',
        name: 'GET /orphan',
        attrs: { method: 'GET', path: '/orphan' },
      },
    ]);
    const surface = buildHttpSurface(db, runId);
    expect(surface.unhandled).toBe(1);
    expect(surface.notes.join('\n')).toContain('no method recorded as handling them');
  });

  it('says an empty surface is about what it could read, not what exists', () => {
    seed([META]);
    expect(buildHttpSurface(db, runId).notes.join('\n')).toContain(
      'not about whether the application serves any',
    );
  });
});

describe('the dependency matrix', () => {
  it('puts references from rows into columns, and finds a cycle on both sides', () => {
    seed([
      META,
      { v: 1, type: 'file', path: 'src/X.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
      { v: 1, type: 'node', kind: 'package', fqn: 'b', name: 'b' },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'a.A',
        name: 'A',
        parent: { kind: 'package', fqn: 'a' },
        file: 'src/X.java',
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B',
        name: 'B',
        parent: { kind: 'package', fqn: 'b' },
        file: 'src/X.java',
      },
      edge('imports', ['class', 'a.A'], ['class', 'b.B'], 3),
      edge('imports', ['class', 'b.B'], ['class', 'a.A'], 4),
    ]);

    const matrix = buildDependencyMatrix(db, runId, 10);
    expect(matrix.packages.sort()).toEqual(['a', 'b']);
    expect(matrix.mutual).toHaveLength(1);
    // Both off-diagonal cells carry a count, which is what makes the cycle
    // visible without running an algorithm over it.
    expect((matrix.cells[0] as number[])[1]).toBeGreaterThan(0);
    expect((matrix.cells[1] as number[])[0]).toBeGreaterThan(0);
  });

  it('is empty for a run with no packages', () => {
    expect(buildDependencyMatrix(db, runId, 10).packages).toEqual([]);
  });
});
