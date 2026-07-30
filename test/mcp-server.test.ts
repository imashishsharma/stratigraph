import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { McpError, runMcp } from '../src/commands/mcp.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import type { Fact } from '../src/facts/types.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import { setQuiet } from '../src/log.js';
import { createServer } from '../src/mcp/server.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

/** Every tool the milestone promised, plus the two enablers of ADR-0015. */
const TOOLS = [
  'check_cycle',
  'describe_module',
  'describe_run',
  'find_callers',
  'find_hotspots',
  'find_node',
  'list_endpoints',
  'query_dependencies',
  'trace_to_table',
];

let cwd: string;
let dbPath: string;
let db: Db;
let runId: number;
let client: Client;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-mcpsrv-'));
  runInit({ repo: FIXTURE, cwd });
  dbPath = join(cwd, '.stratigraph', 'tiny-java.db');
  db = openDatabase(dbPath, { mustExist: true });
  runId = createRun(db, FIXTURE).id;
  seed();

  const server = createServer({ db, runId, minCommits: 5 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  if (db.open) db.close();
  vi.restoreAllMocks();
});

function seed(): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of [
    { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' },
    { v: 1, type: 'file', path: 'src/shop/web/OrderController.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/shop/service/OrderService.java', language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: 'shop.web', name: 'shop.web' },
    { v: 1, type: 'node', kind: 'package', fqn: 'shop.service', name: 'shop.service' },
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
      kind: 'endpoint',
      fqn: 'GET /api/orders',
      name: 'GET /api/orders',
      file: 'src/shop/web/OrderController.java',
      startLine: 19,
      attrs: { framework: 'spring-mvc' },
    },
    {
      v: 1,
      type: 'edge',
      kind: 'injects',
      src: { kind: 'class', fqn: 'shop.web.OrderController' },
      dst: { kind: 'class', fqn: 'shop.service.OrderService' },
      file: 'src/shop/web/OrderController.java',
      line: 12,
    },
    {
      v: 1,
      type: 'edge',
      kind: 'handles',
      src: { kind: 'class', fqn: 'shop.web.OrderController' },
      dst: { kind: 'endpoint', fqn: 'GET /api/orders' },
      file: 'src/shop/web/OrderController.java',
      line: 19,
    },
  ]) {
    writer.write(parseFact(JSON.stringify(fact)) as Fact);
  }
  writer.close();
}

async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(result.isError ?? false).toBe(false);
  return result.content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('\n');
}

describe('the MCP server', () => {
  it('advertises every tool, all of them read-only', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    // The database is opened read-only (ADR-0015); a tool that claimed
    // otherwise would invite a client to ask permission it never needs.
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description ?? '').not.toBe('');
    }
  });

  it('answers describe_run with the commit the facts came from', async () => {
    const text = await callText('describe_run');

    expect(text).toContain(`run ${runId}`);
    expect(text).toContain('answers describe this commit, not your working tree');
    expect(text).toContain('2 packages');
    // The gaps are load-bearing: this run has no history, and an agent must
    // learn that here rather than inferring it from an empty hotspot list.
    expect(text).toContain('stratigraph history');
  });

  it('carries a file and line on every structural claim', async () => {
    expect(await callText('find_node', { query: 'OrderService' })).toContain(
      'src/shop/service/OrderService.java:8',
    );
    expect(await callText('query_dependencies', { fqn: 'shop.web' })).toContain(
      'src/shop/web/OrderController.java:12',
    );
    expect(await callText('list_endpoints')).toContain(
      'src/shop/web/OrderController.java:19',
    );
  });

  it('returns the same data as structuredContent for clients that use it', async () => {
    const result = (await client.callTool({
      name: 'query_dependencies',
      arguments: { fqn: 'shop.web' },
    })) as { structuredContent?: { dependsOn?: Array<{ fqn: string }> } };

    expect(result.structuredContent?.dependsOn?.[0]?.fqn).toBe('shop.service');
  });

  it('says a name was not found rather than answering about nothing', async () => {
    const text = await callText('find_callers', { fqn: 'shop.web.Missing' });

    expect(text).toContain('No node with the fqn "shop.web.Missing" is in this run');
    expect(text).toContain('find_node');
  });

  it('distinguishes "nothing calls this" from "nothing was looked at"', async () => {
    const text = await callText('find_callers', { fqn: 'shop.web.OrderController' });

    expect(text).toContain('Nothing in this run calls or injects');
    expect(text).toContain('absence rather than a gap');
  });

  it('says history was never mined instead of reporting no hotspots', async () => {
    const text = await callText('find_hotspots');

    expect(text).toContain('No history has been mined');
    expect(text).toContain('stratigraph history');
  });

  it('states what a table trace is not', async () => {
    const text = await callText('trace_to_table', { table: 'orders' });

    expect(text).toContain('No table mappings were extracted in this run at all');
  });

  it('labels a model-authored cluster name as inference', async () => {
    const clusterId = Number(
      db
        .prepare(
          `INSERT INTO cluster (run_id, algorithm, label, name, description, authored_by, model)
           VALUES (?, 'louvain', 0, 'Ordering', 'Serves order routes', 'model', 'claude-opus-5')`,
        )
        .run(runId).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO cluster_member (cluster_id, node_id)
       SELECT ?, id FROM node WHERE run_id = ? AND kind = 'package' AND fqn = 'shop.web'`,
    ).run(clusterId, runId);

    const text = await callText('describe_module', { fqn: 'shop.web' });

    expect(text).toContain('inference (claude-opus-5-authored, not observed)');
    expect(text).toContain('"Ordering"');
  });

  it('rejects a call with a missing required argument', async () => {
    // The SDK validates against the input schema and hands the client a tool
    // error rather than a protocol failure, so the agent can correct itself.
    const result = (await client.callTool({
      name: 'check_cycle',
      arguments: { from: 'shop.web' },
    })) as { isError?: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/to/);
  });
});

describe('stratigraph mcp', () => {
  it('refuses to create a fact store, because it only ever reads one', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'stratigraph-mcpmissing-'));

    await expect(runMcp({ repo: FIXTURE, cwd: empty })).rejects.toThrow(McpError);
    await expect(runMcp({ repo: FIXTURE, cwd: empty })).rejects.toThrow(
      /only reads, it never extracts/,
    );
  });

  it('refuses a run id that is not in the store', async () => {
    await expect(runMcp({ repo: FIXTURE, cwd, run: runId + 99 })).rejects.toThrow(
      /is not in/,
    );
  });

  it('opens the store read-only, so a bug here cannot corrupt the facts', async () => {
    db.close();
    const readonly = openDatabase(dbPath, { mustExist: true, readonly: true });

    expect(() =>
      readonly.prepare('DELETE FROM node WHERE run_id = ?').run(runId),
    ).toThrow(/readonly/i);

    readonly.close();
    db = openDatabase(dbPath, { mustExist: true });
  });

  it('writes nothing to stdout, which belongs to the protocol', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    // The whole command, short of the transport: config, run pinning, the
    // read-only open and the log line that says which run is being served.
    await expect(runMcp({ repo: FIXTURE, cwd, run: runId + 99 })).rejects.toThrow();
    for (const name of TOOLS) await callText(name === 'describe_run' ? name : 'describe_run');

    expect(written.join('')).toBe('');
  });
});
