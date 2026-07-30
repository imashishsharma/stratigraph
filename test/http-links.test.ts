import { beforeEach, describe, expect, it } from 'vitest';

import { linkHttpCalls, summariseLinks } from '../src/analysis/http-links.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';

/**
 * Cross-stack matching, and every case where it refuses (ADR-0018).
 *
 * These edges are the most valuable thing the tool produces on a full-stack
 * monolith and the least trusted, because no parser ever saw the connection.
 * The tests are weighted accordingly: what it declines to link matters more
 * than what it does.
 */

let db: Db;
const RUN = 1;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO run (id, repo_path, tool_version, started_at, status)
     VALUES (?, '/repo', '0', '2026-07-31T00:00:00Z', 'ok')`,
  ).run(RUN);
});

/** Write facts through the real writer, so identity and stubs behave as usual. */
function write(facts: Fact[]): void {
  const writer = new SqliteFactWriter(db, RUN);
  for (const fact of facts) writer.write(fact);
  writer.close();
}

function endpoint(fqn: string): Fact {
  return { v: 1, type: 'node', kind: 'endpoint', fqn, name: fqn };
}

/** An Angular method carrying the call sites the extractor observed. */
function caller(
  fqn: string,
  calls: Array<{ method: string; url: string; line: number }>,
): Fact[] {
  return [
    { v: 1, type: 'file', path: 'src/app/orders.service.ts', language: 'typescript' },
    {
      v: 1,
      type: 'node',
      kind: 'method',
      fqn,
      name: 'call',
      file: 'src/app/orders.service.ts',
      attrs: { httpCalls: calls },
    },
  ];
}

function edges(): Array<{ kind: string; confidence: string; attrs: string | null }> {
  return db
    .prepare(`SELECT kind, confidence, attrs FROM edge WHERE run_id = ?`)
    .all(RUN) as Array<{ kind: string; confidence: string; attrs: string | null }>;
}

function diagnostics(): string[] {
  return (
    db.prepare(`SELECT message FROM diagnostic WHERE run_id = ?`).all(RUN) as Array<{
      message: string;
    }>
  ).map((row) => row.message);
}

describe('linkHttpCalls', () => {
  it('matches a path variable to an interpolated segment, and marks it inferred', () => {
    write([
      endpoint('GET /api/orders/{id}'),
      ...caller('src/app/orders.service:Api#findOne()', [
        { method: 'GET', url: '/api/orders/{}', line: 12 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.linked).toBe(1);

    const [edge] = edges();
    expect(edge?.kind).toBe('http_calls');
    // The whole point of ADR-0018. A fact-confidence edge here would let a
    // package cycle be assembled out of two strings that happen to look alike.
    expect(edge?.confidence).toBe('inferred');
    expect(JSON.parse(edge?.attrs ?? '{}')).toEqual({
      observed: 'GET /api/orders/{}',
      endpoint: 'GET /api/orders/{id}',
      matchedBy: 'url-pattern',
    });
  });

  it('prefers the literal endpoint over the wildcard one', () => {
    // Spring's own AntPathMatcher resolves this the same way at runtime, so the
    // tool agrees with the framework rather than inventing a policy.
    write([
      endpoint('GET /api/orders/{id}'),
      endpoint('GET /api/orders/summary'),
      ...caller('src/app/orders.service:Api#summary()', [
        { method: 'GET', url: '/api/orders/summary', line: 20 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.linked).toBe(1);
    expect(result.calls[0]?.endpoint).toBe('GET /api/orders/summary');
    expect(result.ambiguous).toBe(0);
  });

  it('refuses a genuine tie and names both candidates', () => {
    // Two endpoints equally specific for one URL. Emitting both would assert
    // two dependencies where there is one; either alone is a coin toss.
    // A generic count endpoint alongside a by-id one — both one wildcard deep,
    // both matching `/api/users/count`, and only Spring's registration order
    // decides which actually serves it at runtime.
    write([
      endpoint('GET /api/users/{id}'),
      endpoint('GET /api/{entity}/count'),
      ...caller('src/app/users.service:Api#count()', [
        { method: 'GET', url: '/api/users/count', line: 30 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.linked).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(edges()).toEqual([]);

    const [message] = diagnostics();
    expect(message).toContain('GET /api/users/{id}');
    expect(message).toContain('GET /api/{entity}/count');
    expect(message).toContain('no http_calls edge recorded');
  });

  it('does not match across a segment boundary', () => {
    write([
      endpoint('GET /api/orders/{id}'),
      ...caller('src/app/orders.service:Api#lines()', [
        { method: 'GET', url: '/api/orders/1/lines', line: 40 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.linked).toBe(0);
    expect(result.unmatched).toBe(1);
  });

  it('matches the verb, not only the path', () => {
    write([
      endpoint('GET /api/orders'),
      ...caller('src/app/orders.service:Api#create()', [
        { method: 'POST', url: '/api/orders', line: 50 },
      ]),
    ]);
    expect(linkHttpCalls(db, RUN).unmatched).toBe(1);
  });

  it('lets an ANY endpoint match every verb', () => {
    // What the Java extractor emits for `@RequestMapping` with no method
    // element; the endpoint really does serve them all.
    write([
      endpoint('ANY /reports/index'),
      ...caller('src/app/reports.service:Api#post()', [
        { method: 'POST', url: '/reports/index', line: 60 },
      ]),
    ]);
    expect(linkHttpCalls(db, RUN).linked).toBe(1);
  });

  it('ignores a query string and a trailing slash', () => {
    write([
      endpoint('GET /api/orders'),
      ...caller('src/app/orders.service:Api#search()', [
        { method: 'GET', url: '/api/orders/?page=2', line: 70 },
      ]),
    ]);
    expect(linkHttpCalls(db, RUN).linked).toBe(1);
  });

  it('says nothing at all about a URL that matches nothing', () => {
    // Almost always a third-party service. Not a defect, and a diagnostic per
    // occurrence would drown the ones that mean something.
    write([
      endpoint('GET /api/orders'),
      ...caller('src/app/telemetry.service:Api#ping()', [
        { method: 'GET', url: 'https://telemetry.example.com/ping', line: 80 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.unmatched).toBe(1);
    expect(diagnostics()).toEqual([]);
  });

  it('distinguishes "no endpoints to match against" from "nothing matched"', () => {
    // The distinction the whole project turns on: nothing found, versus nothing
    // looked at. A run with only the Angular half must not read as a backend
    // with no endpoints.
    write([
      ...caller('src/app/orders.service:Api#findOne()', [
        { method: 'GET', url: '/api/orders', line: 90 },
      ]),
    ]);

    const result = linkHttpCalls(db, RUN);
    expect(result.noEndpoints).toBe(true);
    expect(summariseLinks(result)).toContain('no endpoints to match them against');
  });

  it('is idempotent across repeated analyze runs', () => {
    write([
      endpoint('GET /api/orders'),
      ...caller('src/app/orders.service:Api#list()', [
        { method: 'GET', url: '/api/orders', line: 100 },
      ]),
    ]);

    linkHttpCalls(db, RUN);
    linkHttpCalls(db, RUN);

    expect(edges()).toHaveLength(1);
    const [row] = db
      .prepare(`SELECT weight FROM edge WHERE run_id = ?`)
      .all(RUN) as Array<{ weight: number }>;
    expect(row?.weight).toBe(2);
  });

  it('keeps inferred edges out of the package graph', async () => {
    // Checked here rather than trusted: `buildPackageGraph` filters on
    // confidence, so a cycle can never be assembled out of a string match.
    const { buildPackageGraph } = await import('../src/analysis/package-graph.js');
    write([
      { v: 1, type: 'node', kind: 'package', fqn: 'src/app', name: 'app' },
      { v: 1, type: 'node', kind: 'package', fqn: 'com.example.web', name: 'web' },
      {
        v: 1,
        type: 'node',
        kind: 'endpoint',
        fqn: 'GET /api/orders',
        name: 'orders',
        parent: { kind: 'package', fqn: 'com.example.web' },
      },
      { v: 1, type: 'file', path: 'src/app/orders.service.ts', language: 'typescript' },
      {
        v: 1,
        type: 'node',
        kind: 'method',
        fqn: 'src/app/orders.service:Api#list()',
        name: 'list',
        parent: { kind: 'package', fqn: 'src/app' },
        file: 'src/app/orders.service.ts',
        attrs: { httpCalls: [{ method: 'GET', url: '/api/orders', line: 110 }] },
      },
    ]);

    expect(linkHttpCalls(db, RUN).linked).toBe(1);
    expect(buildPackageGraph(db, RUN).dependencies).toEqual([]);
  });
});
