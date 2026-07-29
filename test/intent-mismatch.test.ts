import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectClusters } from '../src/analysis/clusters.js';
import { detectIntentMismatches, RULE } from '../src/analysis/intent-mismatch.js';
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
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-intent-'));
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

function path(pkg: string): string {
  return `src/${pkg.replaceAll('.', '/')}/A.java`;
}

function type(pkg: string): object[] {
  return [
    { v: 1, type: 'file', path: path(pkg), language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: pkg, name: pkg },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: `${pkg}.A`,
      name: 'A',
      parent: { kind: 'package', fqn: pkg },
      file: path(pkg),
    },
  ];
}

function imports(fromPkg: string, toPkg: string, line = 1): object {
  return {
    v: 1,
    type: 'edge',
    kind: 'imports',
    src: { kind: 'class', fqn: `${fromPkg}.A` },
    dst: { kind: 'class', fqn: `${toPkg}.A` },
    file: path(fromPkg),
    line,
  };
}

/** Fully connect a list of packages, so they cluster together. */
function clique(packages: string[], startLine = 1): object[] {
  const edges: object[] = [];
  let line = startLine;
  for (let i = 0; i < packages.length; i += 1) {
    for (let j = i + 1; j < packages.length; j += 1) {
      edges.push(imports(packages[i] as string, packages[j] as string, line));
      line += 1;
    }
  }
  return edges;
}

function cluster(couplingWeight = 1) {
  return detectClusters(db, runId, { couplingWeight });
}

function citations(findingId: number): Array<{ kind: string }> {
  return db
    .prepare('SELECT kind FROM citation WHERE finding_id = ? ORDER BY kind, id')
    .all(findingId) as Array<{ kind: string }>;
}

/**
 * Four billing packages and four admin ones, except `billing.report` is wired
 * into admin instead of into billing.
 */
function seedStrayPackage(): void {
  const billing = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
  const admin = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];
  seed([
    META,
    ...[...billing, ...admin, 'shop.billing.report'].flatMap((pkg) => type(pkg)),
    ...clique(billing, 1),
    ...clique(admin, 100),
    // The stray: named under billing, wired into admin.
    ...clique(['shop.billing.report', ...admin], 200),
  ]);
}

describe('detectIntentMismatches', () => {
  it('reports a package named with one group and clustered with another', () => {
    seedStrayPackage();
    const found = detectIntentMismatches(db, runId, cluster().clusters);

    expect(found).toHaveLength(1);
    const [mismatch] = found;
    expect(mismatch?.fqn).toBe('shop.billing.report');
    expect(mismatch?.parent).toBe('shop.billing');
    expect(mismatch?.nameGroup).toEqual([
      'shop.billing.invoice',
      'shop.billing.ledger',
      'shop.billing.payment',
    ]);
    expect(mismatch?.expectedPrefix).toBe('shop.billing');
    expect(mismatch?.actualPrefix).toBe('shop.admin');
    expect(mismatch?.severity).toBe('high');
    expect(mismatch?.unanimous).toBe(true);
    expect(mismatch?.pulledBy).toEqual([
      'shop.admin.audit',
      'shop.admin.role',
      'shop.admin.user',
    ]);
  });

  it('cites the edges that connect it and the siblings it left behind', () => {
    seedStrayPackage();
    const [mismatch] = detectIntentMismatches(db, runId, cluster().clusters);
    const kinds = citations(mismatch?.findingId as number);

    expect(kinds.filter((row) => row.kind === 'edge').length).toBeGreaterThan(0);
    // One node citation per sibling that went elsewhere.
    expect(kinds.filter((row) => row.kind === 'node')).toHaveLength(3);

    const detail = db
      .prepare('SELECT title, detail, severity, authored_by FROM finding WHERE id = ?')
      .get(mismatch?.findingId as number) as {
      title: string;
      detail: string;
      severity: string;
      authored_by: string;
    };
    expect(detail.authored_by).toBe('algorithm');
    expect(detail.title).toContain('shop.billing.report');
    expect(detail.detail).toContain('shop.billing.invoice');
    expect(detail.detail).toMatch(
      /imports shop\.billing\.report\.A → shop\.admin\.\w+\.A \(src\/.+:\d+\)/,
    );
  });

  it('says nothing when a package sits where its name says it should', () => {
    const billing = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
    const admin = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];
    seed([
      META,
      ...[...billing, ...admin].flatMap((pkg) => type(pkg)),
      ...clique(billing, 1),
      ...clique(admin, 100),
    ]);

    expect(detectIntentMismatches(db, runId, cluster().clusters)).toEqual([]);
  });

  it('needs a name group of at least two to make a claim', () => {
    // Only one sibling: a pair disagreeing says nothing about which is wrong.
    const admin = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];
    seed([
      META,
      ...['shop.billing.invoice', 'shop.billing.report', ...admin].flatMap((pkg) => type(pkg)),
      ...clique(admin, 100),
      ...clique(['shop.billing.report', ...admin], 200),
    ]);

    expect(detectIntentMismatches(db, runId, cluster().clusters)).toEqual([]);
  });

  it('needs a strict majority, not a plurality', () => {
    // Four siblings split 2 / 1 / 1: nothing they collectively left.
    seed([
      META,
      ...[
        'shop.thing.one',
        'shop.thing.two',
        'shop.thing.three',
        'shop.thing.four',
        'shop.thing.five',
        'shop.other.a',
        'shop.other.b',
      ].flatMap((pkg) => type(pkg)),
      ...clique(['shop.thing.one', 'shop.thing.two'], 1),
      ...clique(['shop.thing.three', 'shop.other.a'], 100),
      ...clique(['shop.thing.four', 'shop.other.b'], 200),
    ]);

    const found = detectIntentMismatches(db, runId, cluster().clusters);
    expect(found.map((mismatch) => mismatch.fqn)).not.toContain('shop.thing.five');
  });

  it('ignores top-level packages, which have no declared neighbourhood', () => {
    seed([
      META,
      ...['alpha', 'beta', 'gamma', 'delta'].flatMap((pkg) => type(pkg)),
      ...clique(['alpha', 'beta', 'gamma'], 1),
    ]);

    expect(detectIntentMismatches(db, runId, cluster().clusters)).toEqual([]);
  });

  it('reports a stray with no edges at all, and says the absence was checked', () => {
    const billing = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
    seed([
      META,
      ...[...billing, 'shop.billing.report'].flatMap((pkg) => type(pkg)),
      ...clique(billing, 1),
    ]);

    const found = detectIntentMismatches(db, runId, cluster().clusters);
    expect(found.map((mismatch) => mismatch.fqn)).toEqual(['shop.billing.report']);
    expect(found[0]?.pulledBy).toEqual([]);

    const { detail } = db
      .prepare('SELECT detail FROM finding WHERE id = ?')
      .get(found[0]?.findingId as number) as { detail: string };
    expect(detail).toContain('an absence we looked for, not one we assumed');
  });

  it('cites the commits when history rather than code pulled it across', () => {
    const billing = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
    const admin = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];
    seed([
      META,
      ...[...billing, ...admin, 'shop.billing.report'].flatMap((pkg) => type(pkg)),
      ...clique(billing, 1),
      ...clique(admin, 100),
    ]);
    for (const other of admin) {
      db.prepare(
        `INSERT INTO temporal_coupling
           (run_id, path_a, path_b, shared, commits_a, commits_b, strength, static_edges)
         VALUES (?, ?, ?, 30, 32, 33, 0.95, 0)`,
      ).run(runId, path('shop.billing.report'), path(other));
    }
    const commitId = Number(
      db
        .prepare(
          `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, is_merge)
           VALUES (?, 'abc1234', 'ada', 'ada@example.invalid', '2024-01-01T00:00:00.000Z', 0)`,
        )
        .run(runId).lastInsertRowid,
    );
    for (const file of [path('shop.billing.report'), path('shop.admin.user')]) {
      db.prepare(
        `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions)
         VALUES (?, ?, ?, ?, 5, 5)`,
      ).run(runId, commitId, file, file);
    }

    const found = detectIntentMismatches(db, runId, cluster(3).clusters);
    const stray = found.find((mismatch) => mismatch.fqn === 'shop.billing.report');
    expect(stray).toBeDefined();
    expect(stray?.pulledBy.length).toBeGreaterThan(0);

    const kinds = citations(stray?.findingId as number).map((row) => row.kind);
    expect(kinds).toContain('commit');

    const { detail } = db
      .prepare('SELECT detail FROM finding WHERE id = ?')
      .get(stray?.findingId as number) as { detail: string };
    expect(detail).toContain('changes with');
  });

  it('replaces findings from a previous analysis rather than appending', () => {
    seedStrayPackage();
    detectIntentMismatches(db, runId, cluster().clusters);
    const second = detectIntentMismatches(db, runId, cluster().clusters);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM finding WHERE run_id = ? AND rule = ?')
      .get(runId, RULE) as { n: number };
    expect(count.n).toBe(second.length);
  });
});
