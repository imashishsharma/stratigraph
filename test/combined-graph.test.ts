import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCombinedGraph, type CombinedGraph } from '../src/analysis/combined-graph.js';
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
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-combined-'));
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

/** One class in package `pkg`, declared in `path`. */
function type(pkg: string, name: string, path: string): object[] {
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

function imports(from: string, to: string, path: string, line: number): object {
  return {
    v: 1,
    type: 'edge',
    kind: 'imports',
    src: { kind: 'class', fqn: from },
    dst: { kind: 'class', fqn: to },
    file: path,
    line,
  };
}

function couple(pathA: string, pathB: string, strength: number): void {
  db.prepare(
    `INSERT INTO temporal_coupling
       (run_id, path_a, path_b, shared, commits_a, commits_b, strength, static_edges)
     VALUES (?, ?, ?, 10, 20, 20, ?, 0)`,
  ).run(runId, pathA, pathB, strength);
}

function edgeWeights(graph: CombinedGraph): Record<string, number> {
  const fqn = new Map(graph.nodes.map((node) => [node.id, node.key]));
  return Object.fromEntries(
    graph.edges.map((edge) => [
      [fqn.get(edge.a), fqn.get(edge.b)].sort().join('|'),
      Number(edge.weight.toFixed(6)),
    ]),
  );
}

/** Three packages: a and b import each other's types, c is imported by neither. */
function seedThreePackages(): void {
  seed([
    META,
    ...type('a', 'A', 'src/a/A.java'),
    ...type('b', 'B', 'src/b/B.java'),
    ...type('c', 'C', 'src/c/C.java'),
    imports('a.A', 'b.B', 'src/a/A.java', 3),
    imports('a.A', 'b.B', 'src/a/A.java', 4),
    imports('b.B', 'a.A', 'src/b/B.java', 3),
  ]);
}

describe('buildCombinedGraph', () => {
  it('includes every non-stub package as a node, edges or not', () => {
    seedThreePackages();
    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    expect(graph.nodes.map((node) => node.key).sort()).toEqual(['a', 'b', 'c']);
    expect(graph.stats.packages).toBe(3);
  });

  it('folds the two directions of a dependency into one undirected edge', () => {
    seedThreePackages();
    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    // a → b twice and b → a once: one pair, and it is the only one, so it
    // normalises to exactly 1.
    expect(edgeWeights(graph)).toEqual({ 'a|b': 1 });
    expect(graph.stats.staticPairs).toBe(1);
    expect(graph.stats.maxReferences).toBe(3);
  });

  it('reproduces the static graph exactly at couplingWeight 0', () => {
    seedThreePackages();
    couple('src/a/A.java', 'src/c/C.java', 0.9);

    const withHistory = buildCombinedGraph(db, runId, { couplingWeight: 1 });
    const withoutHistory = buildCombinedGraph(db, runId, { couplingWeight: 0 });

    expect(edgeWeights(withHistory)).toEqual({ 'a|b': 1, 'a|c': 1 });
    expect(edgeWeights(withoutHistory)).toEqual({ 'a|b': 1 });
    // The coupling is still counted and reported either way; only its weight
    // in the partition is zero.
    expect(withoutHistory.stats.temporalPairs).toBe(1);
  });

  it('scales a coupling edge by couplingWeight', () => {
    seedThreePackages();
    couple('src/a/A.java', 'src/c/C.java', 0.9);

    expect(edgeWeights(buildCombinedGraph(db, runId, { couplingWeight: 0.25 }))).toEqual({
      'a|b': 1,
      'a|c': 0.25,
    });
  });

  it('sums the strengths of several file pairs onto one package pair', () => {
    seed([
      META,
      ...type('a', 'A', 'src/a/A.java'),
      ...type('a', 'A2', 'src/a/A2.java'),
      ...type('c', 'C', 'src/c/C.java'),
      ...type('c', 'C2', 'src/c/C2.java'),
      ...type('d', 'D', 'src/d/D.java'),
      ...type('e', 'E', 'src/e/E.java'),
    ]);
    couple('src/a/A.java', 'src/c/C.java', 0.4);
    couple('src/a/A2.java', 'src/c/C2.java', 0.4);
    couple('src/d/D.java', 'src/e/E.java', 0.4);

    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    // a|c has two coupled file pairs and d|e has one, so a|c is the heavier
    // pair and sets the scale.
    expect(edgeWeights(graph)).toEqual({ 'a|c': 1, 'd|e': 0.5 });
    expect(graph.stats.maxCoupling).toBeCloseTo(0.8, 10);
  });

  it('drops a coupling pair whose files no extractor parsed, and says how many', () => {
    seedThreePackages();
    couple('src/a/A.java', 'pom.xml', 0.9);
    couple('pom.xml', 'db/changelog.xml', 0.9);
    couple('src/a/A.java', 'src/c/C.java', 0.5);

    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    expect(edgeWeights(graph)).toEqual({ 'a|b': 1, 'a|c': 1 });
    expect(graph.stats.couplingRows).toBe(3);
    expect(graph.stats.couplingRowsPlaced).toBe(1);
  });

  it('drops a coupling pair whose files sit in the same package', () => {
    seed([
      META,
      ...type('a', 'A', 'src/a/A.java'),
      ...type('a', 'A2', 'src/a/A2.java'),
    ]);
    couple('src/a/A.java', 'src/a/A2.java', 0.9);

    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    expect(graph.edges).toEqual([]);
    expect(graph.stats.couplingRows).toBe(1);
    expect(graph.stats.couplingRowsPlaced).toBe(0);
  });

  it('resolves a nested class to the package of its outer class', () => {
    seed([
      META,
      ...type('a', 'A', 'src/a/A.java'),
      ...type('c', 'C', 'src/c/C.java'),
      { v: 1, type: 'file', path: 'src/b/B.java', language: 'java' },
      { v: 1, type: 'node', kind: 'package', fqn: 'b', name: 'b' },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B',
        name: 'B',
        parent: { kind: 'package', fqn: 'b' },
        file: 'src/b/B.java',
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B$Inner',
        name: 'Inner',
        parent: { kind: 'class', fqn: 'b.B' },
        file: 'src/b/B.java',
      },
    ]);
    couple('src/b/B.java', 'src/c/C.java', 0.9);

    expect(edgeWeights(buildCombinedGraph(db, runId, { couplingWeight: 1 }))).toEqual({
      'b|c': 1,
    });
  });

  it('returns an empty graph rather than failing when there are no facts', () => {
    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats.couplingRows).toBe(0);
  });

  it('builds from history alone with no packages to place it in', () => {
    couple('a.md', 'b.md', 0.9);
    const graph = buildCombinedGraph(db, runId, { couplingWeight: 1 });

    expect(graph.nodes).toEqual([]);
    expect(graph.stats.couplingRows).toBe(1);
    expect(graph.stats.couplingRowsPlaced).toBe(0);
  });
});
