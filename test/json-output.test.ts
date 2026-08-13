import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';
import { setFormat, setQuiet } from '../src/log.js';
import {
  evaluateGate,
  rankFindings,
  isGateSeverity,
  GATE_SEVERITIES,
} from '../src/present/findings.js';
import { analyzeDocument, findingsDocument, JSON_FORMAT_VERSION } from '../src/present/json.js';
import { describeRun } from '../src/mcp/queries.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;
let runId: number;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-json-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  setFormat('text');
  if (db.open) db.close();
});

function seedRepository(): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of [
    { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' },
    { v: 1, type: 'file', path: 'src/a/A.java', language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: 'a', name: 'a' },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'a.A',
      name: 'A',
      parent: { kind: 'package', fqn: 'a' },
      file: 'src/a/A.java',
    },
    { v: 1, type: 'node', kind: 'class', fqn: 'a.B', name: 'B', parent: { kind: 'package', fqn: 'a' } },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'a.A' },
      dst: { kind: 'class', fqn: 'a.B' },
      file: 'src/a/A.java',
      line: 3,
    },
  ]) {
    writer.write(parseFact(JSON.stringify(fact)) as Fact);
  }
  writer.close();
}

function finding(severity: string, cited = true): void {
  const id = Number(
    db
      .prepare(
        `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
         VALUES (?, 'package-cycle', ?, 'detail', ?, 'algorithm')`,
      )
      .run(runId, `a ${severity} finding`, severity).lastInsertRowid,
  );
  if (!cited) return;
  const edgeId = (db.prepare('SELECT id FROM edge WHERE run_id = ? LIMIT 1').get(runId) as {
    id: number;
  }).id;
  db.prepare(`INSERT INTO citation (finding_id, kind, edge_id) VALUES (?, 'edge', ?)`).run(
    id,
    edgeId,
  );
}

function ranked() {
  return rankFindings(db, runId, { top: 20 });
}

describe('the --fail-on gate', () => {
  beforeEach(seedRepository);

  it('counts a finding at the threshold and above it, never below', () => {
    finding('high');
    finding('medium');
    finding('low');

    expect(evaluateGate(ranked(), 'high').offending).toBe(1);
    expect(evaluateGate(ranked(), 'medium').offending).toBe(2);
    expect(evaluateGate(ranked(), 'low').offending).toBe(3);
    expect(evaluateGate(ranked(), 'info').offending).toBe(3);
  });

  it('does not fail a run whose worst finding is below the threshold', () => {
    finding('low');
    const gate = evaluateGate(ranked(), 'high');
    expect(gate.failed).toBe(false);
    expect(gate.offending).toBe(0);
  });

  it('passes on a run with no findings at all', () => {
    expect(evaluateGate(ranked(), 'info').failed).toBe(false);
  });

  it('ignores a finding nothing can check, exactly as the report does', () => {
    // ADR-0021: an uncited finding is not publishable. A gate that failed a
    // build on one would fail it on a claim the report refuses to show.
    finding('high', false);
    expect(evaluateGate(ranked(), 'high').failed).toBe(false);
    expect(ranked().uncited).toBe(1);
  });

  it('reports the breakdown strongest first, for a one-line CI message', () => {
    finding('medium');
    finding('high');
    finding('medium');
    expect(evaluateGate(ranked(), 'medium').bySeverity).toEqual([
      { severity: 'high', count: 1 },
      { severity: 'medium', count: 2 },
    ]);
  });

  it('accepts exactly the severities the CLI offers', () => {
    expect(GATE_SEVERITIES.every((severity) => isGateSeverity(severity))).toBe(true);
    expect(isGateSeverity('critical')).toBe(false);
  });
});

describe('the JSON contract', () => {
  beforeEach(seedRepository);

  it('carries a version a consumer can branch on', () => {
    const document = analyzeDocument({
      run: describeRun(db, runId)!,
      packages: 1,
      dependencies: 0,
      ranked: ranked(),
      gate: null,
      interpretation: null,
      interpretationSkipped: 'disabled',
    });

    expect(document['stratigraph']).toMatch(/^\d+\.\d+\.\d+/);
    expect(document['format']).toBe(JSON_FORMAT_VERSION);
    expect(document['command']).toBe('analyze');
  });

  it('travels with what the run could not see', () => {
    const document = analyzeDocument({
      run: describeRun(db, runId)!,
      packages: 1,
      dependencies: 0,
      ranked: ranked(),
      gate: null,
      interpretation: null,
      interpretationSkipped: null,
    });

    // The same reason the report has a limits tab (ADR-0026): an empty findings
    // array and a clean repository are indistinguishable without this.
    const run = document['run'] as Record<string, unknown>;
    expect(run['coverage']).toMatchObject({ history: false });
    expect((run['gaps'] as string[]).join(' ')).toMatch(/stratigraph history/);
  });

  it('says when the item list is capped rather than letting the totals not add up', () => {
    for (let n = 0; n < 5; n += 1) finding('medium');

    const all = findingsDocument(rankFindings(db, runId, { top: 20 }));
    expect(all['shown']).toBe(5);
    expect(all['truncated']).toBe(false);

    const capped = findingsDocument(rankFindings(db, runId, { top: 2 }));
    expect(capped['total']).toBe(5);
    expect(capped['shown']).toBe(2);
    expect(capped['truncated']).toBe(true);
  });

  it('counts withheld findings separately from published ones', () => {
    finding('high');
    finding('high', false);

    const document = findingsDocument(ranked());
    expect(document['total']).toBe(2);
    expect(document['published']).toBe(1);
    expect(document['unpublishable']).toBe(1);
  });

  it('marks every item as observation or inference', () => {
    finding('high');
    const items = findingsDocument(ranked())['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['authoredBy']).toBe('algorithm');
    expect(items[0]?.['evidence']).toHaveLength(1);
  });

  it('reports a skipped interpretation as skipped, not as a run that found nothing', () => {
    const document = analyzeDocument({
      run: describeRun(db, runId)!,
      packages: 1,
      dependencies: 0,
      ranked: ranked(),
      gate: null,
      interpretation: null,
      interpretationSkipped: 'no-credential',
    });
    expect(document['interpretation']).toEqual({
      ran: false,
      skipped: 'no-credential',
      models: [],
    });
  });

  it('serialises the gate verdict alongside the findings that produced it', () => {
    finding('high');
    const document = analyzeDocument({
      run: describeRun(db, runId)!,
      packages: 1,
      dependencies: 0,
      ranked: ranked(),
      gate: evaluateGate(ranked(), 'high'),
      interpretation: null,
      interpretationSkipped: 'disabled',
    });
    expect(document['gate']).toEqual({
      threshold: 'high',
      offending: 1,
      bySeverity: { high: 1 },
      failed: true,
    });
  });
});
