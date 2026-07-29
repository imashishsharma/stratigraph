import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commonPrefix, detectClusters, loadClusters } from '../src/analysis/clusters.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import type { Fact } from '../src/facts/types.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let db: Db;
let runId: number;

beforeEach(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-clusters-'));
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

function type(pkg: string, name: string): object[] {
  const path = `src/${pkg.replaceAll('.', '/')}/${name}.java`;
  return [
    { v: 1, type: 'file', path, language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: pkg, name: pkg },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: `${pkg}.${name}`,
      name,
      parent: { kind: 'package', fqn: pkg },
      file: path,
    },
  ];
}

function imports(from: string, to: string, line: number): object {
  const pkg = from.slice(0, from.lastIndexOf('.'));
  const name = from.slice(from.lastIndexOf('.') + 1);
  return {
    v: 1,
    type: 'edge',
    kind: 'imports',
    src: { kind: 'class', fqn: from },
    dst: { kind: 'class', fqn: to },
    file: `src/${pkg.replaceAll('.', '/')}/${name}.java`,
    line,
  };
}

/**
 * Two tightly-bound groups of three packages, joined by a single import.
 * Louvain should find the two groups.
 */
function seedTwoGroups(): void {
  seed([
    META,
    ...['billing.invoice', 'billing.payment', 'billing.ledger'].flatMap((pkg) =>
      type(pkg, 'A'),
    ),
    ...['admin.user', 'admin.role', 'admin.audit'].flatMap((pkg) => type(pkg, 'A')),
    imports('billing.invoice.A', 'billing.payment.A', 1),
    imports('billing.payment.A', 'billing.ledger.A', 1),
    imports('billing.ledger.A', 'billing.invoice.A', 1),
    imports('admin.user.A', 'admin.role.A', 1),
    imports('admin.role.A', 'admin.audit.A', 1),
    imports('admin.audit.A', 'admin.user.A', 1),
    imports('billing.invoice.A', 'admin.user.A', 2),
  ]);
}

function shape(clusters: ReturnType<typeof loadClusters>): Array<[string, string[]]> {
  return clusters.map((cluster) => [
    cluster.prefix,
    cluster.members.map((member) => member.fqn),
  ]);
}

describe('detectClusters', () => {
  it('partitions packages and labels each cluster by its common prefix', () => {
    seedTwoGroups();
    const result = detectClusters(db, runId, { couplingWeight: 1 });

    expect(shape(result.clusters)).toEqual([
      ['admin', ['admin.audit', 'admin.role', 'admin.user']],
      ['billing', ['billing.invoice', 'billing.ledger', 'billing.payment']],
    ]);
    expect(result.modularity).toBeGreaterThan(0);
    expect(result.singletons).toBe(0);
  });

  it('leaves name and description for the model to write', () => {
    seedTwoGroups();
    const result = detectClusters(db, runId, { couplingWeight: 1 });

    expect(result.clusters.every((cluster) => cluster.name === null)).toBe(true);
    expect(result.clusters.every((cluster) => cluster.description === null)).toBe(true);

    const authored = db
      .prepare('SELECT DISTINCT authored_by FROM cluster WHERE run_id = ?')
      .all(runId);
    expect(authored).toEqual([{ authored_by: 'algorithm' }]);
  });

  it('replaces a previous partition rather than appending to it', () => {
    seedTwoGroups();
    const first = detectClusters(db, runId, { couplingWeight: 1 });
    const second = detectClusters(db, runId, { couplingWeight: 1 });

    expect(shape(second.clusters)).toEqual(shape(first.clusters));
    expect(countRows('cluster')).toBe(second.clusters.length);
    expect(countRows('cluster_member')).toBe(6);
  });

  it('is reproducible: the same facts give the same clusters and numbering', () => {
    seedTwoGroups();
    const first = shape(detectClusters(db, runId, { couplingWeight: 1 }).clusters);
    const second = shape(detectClusters(db, runId, { couplingWeight: 1 }).clusters);
    expect(second).toEqual(first);
  });

  it('lets history move a package into the group it actually changes with', () => {
    // This is the point of combining the two layers at all (ADR-0012): the
    // static graph puts billing.payment with billing, and the history says it
    // moves with admin.role instead.
    seedTwoGroups();
    db.prepare(
      `INSERT INTO temporal_coupling
         (run_id, path_a, path_b, shared, commits_a, commits_b, strength, static_edges)
       VALUES (?, 'src/billing/payment/A.java', 'src/admin/role/A.java', 30, 32, 33, 0.95, 0)`,
    ).run(runId);

    const structural = detectClusters(db, runId, { couplingWeight: 0 });
    expect(shape(structural.clusters).map(([, members]) => members)).toEqual([
      ['admin.audit', 'admin.role', 'admin.user'],
      ['billing.invoice', 'billing.ledger', 'billing.payment'],
    ]);

    const combined = detectClusters(db, runId, { couplingWeight: 3 });
    expect(shape(combined.clusters).map(([, members]) => members)).toEqual([
      ['admin.audit', 'admin.user'],
      ['admin.role', 'billing.payment'],
      ['billing.invoice', 'billing.ledger'],
    ]);
    // The two packages nothing in the code connects are now the same cluster,
    // and the prefix label says so honestly: they share no package prefix.
    expect(combined.clusters[1]?.prefix).toBe('admin.role');
  });

  it('keeps a package that groups with nothing as a cluster of one', () => {
    seed([
      META,
      ...['a.one', 'a.two'].flatMap((pkg) => type(pkg, 'A')),
      ...type('lonely', 'A'),
      imports('a.one.A', 'a.two.A', 1),
    ]);
    const result = detectClusters(db, runId, { couplingWeight: 1 });

    expect(result.singletons).toBe(1);
    expect(shape(result.clusters)).toEqual([
      ['a', ['a.one', 'a.two']],
      ['lonely', ['lonely']],
    ]);
  });

  it('produces nothing when the run has no packages', () => {
    const result = detectClusters(db, runId, { couplingWeight: 1 });
    expect(result.clusters).toEqual([]);
    expect(result.modularity).toBe(0);
  });
});

describe('loadClusters', () => {
  it('reads back what detectClusters wrote, model columns included', () => {
    seedTwoGroups();
    const written = detectClusters(db, runId, { couplingWeight: 1 });
    const clusterId = written.clusters[0]?.clusterId as number;
    db.prepare(
      `UPDATE cluster SET name = 'Administration', description = 'd',
              authored_by = 'model', model = 'claude-opus-5' WHERE id = ?`,
    ).run(clusterId);

    const loaded = loadClusters(db, runId);
    expect(shape(loaded)).toEqual(shape(written.clusters));
    expect(loaded[0]?.name).toBe('Administration');
    expect(loaded[1]?.name).toBeNull();
  });
});

describe('commonPrefix', () => {
  it.each([
    [['com.foo.billing.invoice', 'com.foo.billing.payment'], 'com.foo.billing'],
    [['com.foo.billing'], 'com.foo.billing'],
    // Segment-wise, not character-wise: `bill` is not a package.
    [['com.foo.billing', 'com.foo.billfold'], 'com.foo'],
    // Nothing shared, so the first member stands in rather than an empty label.
    [['alpha.one', 'beta.two'], 'alpha.one'],
    [['zeta.one', 'alpha.two'], 'alpha.two'],
    [[], ''],
  ])('%j -> %s', (fqns, expected) => {
    expect(commonPrefix(fqns)).toBe(expected);
  });
});

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
