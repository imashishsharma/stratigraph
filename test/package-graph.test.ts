import { beforeEach, describe, expect, it } from 'vitest';

import { detectPackageCycles, RULE } from '../src/analysis/cycles.js';
import { buildPackageGraph } from '../src/analysis/package-graph.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';

let db: Db;
let runId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  runId = createRun(db, '/tmp/repo').id;
});

function ingest(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

const meta = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

function pkg(fqn: string) {
  return { v: 1, type: 'node', kind: 'package', fqn, name: fqn.split('.').pop() };
}

function cls(fqn: string, file: string) {
  const parent = fqn.slice(0, fqn.lastIndexOf('.'));
  return {
    v: 1,
    type: 'node',
    kind: 'class',
    fqn,
    name: fqn.split('.').pop(),
    parent: { kind: 'package', fqn: parent },
    file,
  };
}

function imports(src: string, dst: string, file: string, line: number, extra = {}) {
  return {
    v: 1,
    type: 'edge',
    kind: 'imports',
    src: { kind: 'class', fqn: src },
    dst: { kind: 'class', fqn: dst },
    file,
    line,
    ...extra,
  };
}

/** web → service → repo → web, with util depended on by all and depending on none. */
function seedCycle(): void {
  ingest([
    meta,
    { v: 1, type: 'file', path: 'src/Controller.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/Service.java', language: 'java' },
    { v: 1, type: 'file', path: 'src/Repo.java', language: 'java' },
    pkg('com.example.web'),
    pkg('com.example.service'),
    pkg('com.example.repo'),
    pkg('com.example.util'),
    cls('com.example.web.Controller', 'src/Controller.java'),
    cls('com.example.service.Service', 'src/Service.java'),
    cls('com.example.repo.Repo', 'src/Repo.java'),
    cls('com.example.util.Util', 'src/Util.java'),
    imports('com.example.web.Controller', 'com.example.service.Service', 'src/Controller.java', 3),
    imports('com.example.service.Service', 'com.example.repo.Repo', 'src/Service.java', 4),
    imports('com.example.repo.Repo', 'com.example.web.Controller', 'src/Repo.java', 5),
    imports('com.example.web.Controller', 'com.example.util.Util', 'src/Controller.java', 6),
    imports('com.example.service.Service', 'com.example.util.Util', 'src/Service.java', 7),
  ]);
}

describe('buildPackageGraph', () => {
  it('aggregates class edges to package level', () => {
    seedCycle();
    const graph = buildPackageGraph(db, runId);

    expect(graph.packages.size).toBe(4);
    const pairs = graph.dependencies
      .map((d) => `${graph.packages.get(d.src)?.fqn} -> ${graph.packages.get(d.dst)?.fqn}`)
      .sort();
    expect(pairs).toEqual([
      'com.example.repo -> com.example.web',
      'com.example.service -> com.example.repo',
      'com.example.service -> com.example.util',
      'com.example.web -> com.example.service',
      'com.example.web -> com.example.util',
    ]);
  });

  it('sums weights rather than counting rows', () => {
    ingest([
      meta,
      pkg('a'),
      pkg('b'),
      cls('a.A', 'src/A.java'),
      cls('b.B', 'src/B.java'),
      // Same call site seen twice becomes one edge of weight 2 (see the writer),
      // plus a second, distinct site.
      { v: 1, type: 'edge', kind: 'calls', src: { kind: 'class', fqn: 'a.A' }, dst: { kind: 'class', fqn: 'b.B' }, file: 'src/A.java', line: 10 },
      { v: 1, type: 'edge', kind: 'calls', src: { kind: 'class', fqn: 'a.A' }, dst: { kind: 'class', fqn: 'b.B' }, file: 'src/A.java', line: 10 },
      { v: 1, type: 'edge', kind: 'calls', src: { kind: 'class', fqn: 'a.A' }, dst: { kind: 'class', fqn: 'b.B' }, file: 'src/A.java', line: 20 },
    ]);
    expect(buildPackageGraph(db, runId).dependencies).toEqual([
      expect.objectContaining({ weight: 3 }),
    ]);
  });

  it('resolves a method to its package through nested classes', () => {
    ingest([
      meta,
      pkg('a'),
      pkg('b'),
      cls('a.Outer', 'src/Outer.java'),
      { v: 1, type: 'node', kind: 'class', fqn: 'a.Outer$Inner', name: 'Inner', parent: { kind: 'class', fqn: 'a.Outer' } },
      { v: 1, type: 'node', kind: 'method', fqn: 'a.Outer$Inner#run()', name: 'run', parent: { kind: 'class', fqn: 'a.Outer$Inner' } },
      cls('b.B', 'src/B.java'),
      { v: 1, type: 'node', kind: 'method', fqn: 'b.B#go()', name: 'go', parent: { kind: 'class', fqn: 'b.B' } },
      { v: 1, type: 'edge', kind: 'calls', src: { kind: 'method', fqn: 'a.Outer$Inner#run()' }, dst: { kind: 'method', fqn: 'b.B#go()' } },
    ]);
    const graph = buildPackageGraph(db, runId);
    expect(graph.dependencies).toHaveLength(1);
    expect(graph.packages.get(graph.dependencies[0]!.src)?.fqn).toBe('a');
    expect(graph.packages.get(graph.dependencies[0]!.dst)?.fqn).toBe('b');
  });

  it('ignores edges into code no extractor parsed', () => {
    // org.slf4j.Logger is a stub with no parent: we did not read that jar and
    // will not invent a package for it.
    ingest([
      meta,
      pkg('a'),
      cls('a.A', 'src/A.java'),
      { v: 1, type: 'edge', kind: 'calls', src: { kind: 'class', fqn: 'a.A' }, dst: { kind: 'class', fqn: 'org.slf4j.Logger' } },
    ]);
    expect(buildPackageGraph(db, runId).dependencies).toEqual([]);
  });

  it('ignores inferred edges', () => {
    // A cycle assembled partly from inference is an inference, not structure.
    seedCycle();
    ingest([
      pkg('com.example.extra'),
      cls('com.example.extra.Extra', 'src/Extra.java'),
      imports('com.example.util.Util', 'com.example.extra.Extra', 'src/Util.java', 2, {
        confidence: 'inferred',
      }),
    ]);
    const graph = buildPackageGraph(db, runId);
    expect(
      graph.dependencies.some((d) => graph.packages.get(d.src)?.fqn === 'com.example.util'),
    ).toBe(false);
  });

  it('does not emit a package edge to itself', () => {
    ingest([
      meta,
      pkg('a'),
      cls('a.A', 'src/A.java'),
      cls('a.B', 'src/B.java'),
      { v: 1, type: 'edge', kind: 'imports', src: { kind: 'class', fqn: 'a.A' }, dst: { kind: 'class', fqn: 'a.B' } },
    ]);
    expect(buildPackageGraph(db, runId).dependencies).toEqual([]);
  });
});

describe('detectPackageCycles', () => {
  it('reports the cycle as an ordered path with cited evidence', () => {
    seedCycle();
    const cycles = detectPackageCycles(db, runId);

    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle.componentSize).toBe(3);
    expect(cycle.severity).toBe('high');
    // Starts at the alphabetically first package, and follows real edges.
    expect(cycle.path).toEqual([
      'com.example.repo',
      'com.example.web',
      'com.example.service',
    ]);
    expect(cycle.hops.map((h) => `${h.from}->${h.to}`)).toEqual([
      'com.example.repo->com.example.web',
      'com.example.web->com.example.service',
      'com.example.service->com.example.repo',
    ]);
    for (const hop of cycle.hops) {
      expect(hop.evidence.length).toBeGreaterThan(0);
      for (const edge of hop.evidence) {
        expect(edge.path).toMatch(/\.java$/);
        expect(edge.line).toBeGreaterThan(0);
      }
    }
  });

  it('leaves util out of the cycle', () => {
    seedCycle();
    const [cycle] = detectPackageCycles(db, runId);
    expect(cycle!.path).not.toContain('com.example.util');
  });

  it('writes a finding with a citation per cited edge', () => {
    seedCycle();
    const [cycle] = detectPackageCycles(db, runId);

    const finding = db
      .prepare('SELECT rule, severity, authored_by, model, title FROM finding WHERE id = ?')
      .get(cycle!.findingId) as Record<string, unknown>;
    expect(finding).toMatchObject({
      rule: RULE,
      severity: 'high',
      authored_by: 'algorithm',
      model: null,
    });
    expect(finding['title']).toContain('→');

    const citations = db
      .prepare(
        `SELECT c.kind, e.kind AS edge_kind FROM citation c
           JOIN edge e ON e.id = c.edge_id WHERE c.finding_id = ?`,
      )
      .all(cycle!.findingId) as Array<{ kind: string; edge_kind: string }>;
    const cited = cycle!.hops.reduce((n, h) => n + h.evidence.length, 0);
    expect(citations).toHaveLength(cited);
    expect(citations.every((c) => c.kind === 'edge')).toBe(true);
  });

  it('replaces previous findings rather than accumulating them', () => {
    seedCycle();
    detectPackageCycles(db, runId);
    detectPackageCycles(db, runId);
    detectPackageCycles(db, runId);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM finding WHERE rule = ?').get(RULE),
    ).toEqual({ n: 1 });
    // Citations went with them; none are orphaned.
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM citation WHERE finding_id NOT IN (SELECT id FROM finding)',
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('finds nothing in an acyclic graph', () => {
    ingest([
      meta,
      pkg('a'),
      pkg('b'),
      cls('a.A', 'src/A.java'),
      cls('b.B', 'src/B.java'),
      imports('a.A', 'b.B', 'src/A.java', 3),
    ]);
    expect(detectPackageCycles(db, runId)).toEqual([]);
  });

  it('reports the shortest cycle but names the whole component', () => {
    // a ⇄ b is the short cycle; c and d are dragged into the same SCC.
    ingest([
      meta,
      pkg('a'),
      pkg('b'),
      pkg('c'),
      pkg('d'),
      cls('a.A', 'src/A.java'),
      cls('b.B', 'src/B.java'),
      cls('c.C', 'src/C.java'),
      cls('d.D', 'src/D.java'),
      imports('a.A', 'b.B', 'src/A.java', 1),
      imports('b.B', 'a.A', 'src/B.java', 1),
      imports('b.B', 'c.C', 'src/B.java', 2),
      imports('c.C', 'd.D', 'src/C.java', 1),
      imports('d.D', 'a.A', 'src/D.java', 1),
    ]);
    const [cycle] = detectPackageCycles(db, runId);
    expect(cycle!.path).toEqual(['a', 'b']);
    expect(cycle!.componentSize).toBe(4);

    const detail = (
      db.prepare('SELECT detail FROM finding WHERE id = ?').get(cycle!.findingId) as {
        detail: string;
      }
    ).detail;
    expect(detail).toContain('strongly connected component of 4 packages');
    expect(detail).toContain('c, d');
  });

  it('ranks the largest tangle first', () => {
    ingest([
      meta,
      ...['a', 'b', 'c', 'x', 'y'].map(pkg),
      ...['a.A', 'b.B', 'c.C', 'x.X', 'y.Y'].map((f) => cls(f, `src/${f}.java`)),
      imports('a.A', 'b.B', 'src/a.A.java', 1),
      imports('b.B', 'c.C', 'src/b.B.java', 1),
      imports('c.C', 'a.A', 'src/c.C.java', 1),
      imports('x.X', 'y.Y', 'src/x.X.java', 1),
      imports('y.Y', 'x.X', 'src/y.Y.java', 1),
    ]);
    const cycles = detectPackageCycles(db, runId);
    expect(cycles.map((c) => c.componentSize)).toEqual([3, 2]);
    expect(cycles.map((c) => c.severity)).toEqual(['high', 'medium']);
  });
});
