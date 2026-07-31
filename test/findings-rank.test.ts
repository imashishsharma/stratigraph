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
import { rankFindings, ruleTitle } from '../src/present/findings.js';
import { toMarkdown } from '../src/present/markdown.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;
let runId: number;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-findings-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
});

afterEach(() => {
  if (db.open) db.close();
});

interface Seeded {
  rule?: string;
  title?: string;
  detail?: string | null;
  severity?: string;
  authoredBy?: 'algorithm' | 'model';
  model?: string | null;
  citations?: number;
}

/** One finding with `citations` node citations attached, unless told otherwise. */
function finding(options: Seeded = {}): number {
  const {
    rule = 'package-cycle',
    title = 'a finding',
    detail = null,
    severity = 'medium',
    authoredBy = 'algorithm',
    model = null,
    citations = 1,
  } = options;

  const id = Number(
    db
      .prepare(
        `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, rule, title, detail, severity, authoredBy, model).lastInsertRowid,
  );

  for (let n = 0; n < citations; n += 1) {
    db.prepare(`INSERT INTO citation (finding_id, kind, commit_sha) VALUES (?, 'commit', ?)`).run(
      id,
      `sha${n}`,
    );
  }
  return id;
}

function titles(top = 20): string[] {
  return rankFindings(db, runId, { top }).findings.map((f) => f.title);
}

describe('ranking', () => {
  it('puts higher severity first', () => {
    finding({ title: 'low', severity: 'low' });
    finding({ title: 'high', severity: 'high' });
    finding({ title: 'info', severity: 'info' });
    finding({ title: 'medium', severity: 'medium' });

    expect(titles()).toEqual(['high', 'medium', 'low', 'info']);
  });

  it('puts an algorithm’s finding above a model’s proposal of the same severity', () => {
    // An ADR candidate is a proposal about the codebase; a cycle is a fact
    // about its graph. They must not interleave.
    finding({ title: 'model', severity: 'high', authoredBy: 'model', model: 'claude-opus-5' });
    finding({ title: 'algorithm', severity: 'high' });

    expect(titles()).toEqual(['algorithm', 'model']);
  });

  it('breaks a tie on how much evidence there is', () => {
    finding({ title: 'thin', citations: 1 });
    finding({ title: 'thick', citations: 5 });

    expect(titles()).toEqual(['thick', 'thin']);
  });

  it('breaks a remaining tie on rule name, then on id', () => {
    const first = finding({ rule: 'hotspot', title: 'hotspot-first' });
    finding({ rule: 'hotspot', title: 'hotspot-second' });
    finding({ rule: 'bus-factor', title: 'bus-factor' });

    expect(titles()).toEqual(['bus-factor', 'hotspot-first', 'hotspot-second']);
    expect(rankFindings(db, runId, { top: 20 }).findings[1]?.id).toBe(first);
  });

  it('is total: no two orderings of the same rows differ', () => {
    for (const severity of ['low', 'high', 'medium']) {
      for (const rule of ['hotspot', 'package-cycle']) {
        finding({ rule, severity, title: `${rule}-${severity}` });
      }
    }
    expect(titles()).toEqual(titles());
    // Severity descending; within a severity, rule name ascending.
    expect(titles()).toEqual([
      'hotspot-high',
      'package-cycle-high',
      'hotspot-medium',
      'package-cycle-medium',
      'hotspot-low',
      'package-cycle-low',
    ]);
  });

  it('caps the list without losing the count of what exists', () => {
    for (let n = 0; n < 5; n += 1) finding({ title: `f${n}` });

    const ranked = rankFindings(db, runId, { top: 2 });
    expect(ranked.findings).toHaveLength(2);
    expect(ranked.total).toBe(5);
    expect(ranked.byRule[0]?.count).toBe(5);
  });
});

describe('the publishability rule', () => {
  it('excludes a finding with no citation, and counts it', () => {
    finding({ title: 'cited' });
    finding({ title: 'uncited', citations: 0 });

    const ranked = rankFindings(db, runId, { top: 20 });
    expect(ranked.findings.map((f) => f.title)).toEqual(['cited']);
    expect(ranked.uncited).toBe(1);
    expect(ranked.total).toBe(2);
  });

  it('keeps an uncited finding out of the per-rule and per-severity counts too', () => {
    finding({ title: 'uncited', rule: 'hotspot', severity: 'high', citations: 0 });
    finding({ title: 'cited', rule: 'hotspot', severity: 'high' });

    const ranked = rankFindings(db, runId, { top: 20 });
    expect(ranked.byRule).toEqual([{ rule: 'hotspot', ruleTitle: ruleTitle('hotspot'), count: 1 }]);
    expect(ranked.bySeverity).toEqual([{ severity: 'high', count: 1 }]);
  });

  it('reports an empty run as empty rather than as clean', () => {
    const ranked = rankFindings(db, runId, { top: 20 });
    expect(ranked).toMatchObject({ findings: [], total: 0, uncited: 0 });
  });
});

describe('evidence resolution', () => {
  function seedFacts(): void {
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
        startLine: 7,
      },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'b.B',
        name: 'B',
        parent: { kind: 'package', fqn: 'a' },
        file: 'src/a/A.java',
      },
      {
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: 'a.A' },
        dst: { kind: 'class', fqn: 'b.B' },
        file: 'src/a/A.java',
        line: 3,
      },
    ]) {
      writer.write(parseFact(JSON.stringify(fact)) as Fact);
    }
    writer.close();
  }

  it('resolves an edge citation to what it connects and where', () => {
    seedFacts();
    const edgeId = (db.prepare(`SELECT id FROM edge WHERE run_id = ?`).get(runId) as { id: number })
      .id;
    const id = finding({ citations: 0 });
    db.prepare(`INSERT INTO citation (finding_id, kind, edge_id) VALUES (?, 'edge', ?)`).run(
      id,
      edgeId,
    );

    expect(rankFindings(db, runId, { top: 1 }).findings[0]?.evidence).toEqual([
      { kind: 'edge', label: 'imports a.A → b.B', path: 'src/a/A.java', line: 3 },
    ]);
  });

  it('resolves a node citation to its fqn and declaration line', () => {
    seedFacts();
    const nodeId = (
      db.prepare(`SELECT id FROM node WHERE run_id = ? AND fqn = 'a.A'`).get(runId) as {
        id: number;
      }
    ).id;
    const id = finding({ citations: 0 });
    db.prepare(`INSERT INTO citation (finding_id, kind, node_id) VALUES (?, 'node', ?)`).run(
      id,
      nodeId,
    );

    expect(rankFindings(db, runId, { top: 1 }).findings[0]?.evidence).toEqual([
      { kind: 'node', label: 'a.A', path: 'src/a/A.java', line: 7 },
    ]);
  });

  it('resolves a commit citation to a short sha, subject and author', () => {
    db.prepare(
      `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject)
       VALUES (?, 'abcdef1234567890', 'ada', 'ada@example.invalid', '2024-01-01T00:00:00Z', 'fix the thing')`,
    ).run(runId);
    const id = finding({ citations: 0 });
    db.prepare(`INSERT INTO citation (finding_id, kind, commit_sha) VALUES (?, 'commit', ?)`).run(
      id,
      'abcdef1234567890',
    );

    expect(rankFindings(db, runId, { top: 1 }).findings[0]?.evidence).toEqual([
      { kind: 'commit', label: 'abcdef1234 fix the thing (ada)', path: null, line: null },
    ]);
  });

  it('caps evidence per finding', () => {
    const id = finding({ citations: 12 });
    expect(id).toBeGreaterThan(0);
    expect(
      rankFindings(db, runId, { top: 1, evidencePerFinding: 3 }).findings[0]?.evidence,
    ).toHaveLength(3);
  });
});

describe('rule titles', () => {
  it('gives each rule wording a non-author can read', () => {
    expect(ruleTitle('package-cycle')).toBe('Package cycle');
    expect(ruleTitle('adr-candidate')).toBe('ADR candidate (model-authored proposal)');
  });

  it('falls back to the rule name rather than hiding an unknown rule', () => {
    expect(ruleTitle('something-new')).toBe('something-new');
  });
});

describe('findings.md', () => {
  const context = {
    repoName: 'shop',
    repoHead: 'abcdef1',
    runId: 1,
    toolVersion: '1.3.0',
    startedAt: '2026-07-31T00:00:00Z',
  };

  it('writes the ranked findings with their evidence', () => {
    finding({ title: 'a.b depends on b.a', severity: 'high', detail: 'two hops' });
    const out = toMarkdown(rankFindings(db, runId, { top: 20 }), context);

    expect(out).toContain('# Findings — shop');
    expect(out).toContain('### 1. a.b depends on b.a');
    expect(out).toContain('**high** · Package cycle · derived by an algorithm from parsed facts');
    expect(out).toContain('> two hops');
    expect(out).toContain('- sha0');
  });

  it('says which model wrote a model-authored finding', () => {
    finding({ rule: 'adr-candidate', authoredBy: 'model', model: 'claude-opus-5', severity: 'info' });
    expect(toMarkdown(rankFindings(db, runId, { top: 20 }), context)).toContain(
      'written by `claude-opus-5` — inference, not observation',
    );
  });

  it('reports uncited findings rather than dropping them silently', () => {
    finding({ title: 'cited' });
    finding({ title: 'uncited', citations: 0 });
    expect(toMarkdown(rankFindings(db, runId, { top: 20 }), context)).toContain(
      '1 finding(s) carry no citation and are not listed',
    );
  });

  it('distinguishes an empty run from a clean one', () => {
    const out = toMarkdown(rankFindings(db, runId, { top: 20 }), context);
    expect(out).toContain('not that nothing was looked at');
  });

  it('says how many it left out when capped', () => {
    for (let n = 0; n < 5; n += 1) finding({ title: `f${n}` });
    expect(toMarkdown(rankFindings(db, runId, { top: 2 }), context)).toContain(
      'Showing 2 of 5 findings',
    );
  });

  it('escapes markup in a title, because an fqn is not prose', () => {
    finding({ title: 'src/app/[id]/page_component*' });
    const out = toMarkdown(rankFindings(db, runId, { top: 20 }), context);
    expect(out).toContain('### 1. src/app/\\[id\\]/page\\_component\\*');
  });

  it('says the facts describe a commit, not the working tree', () => {
    expect(toMarkdown(rankFindings(db, runId, { top: 1 }), context)).toContain(
      'Facts describe commit `abcdef1`, not the working tree.',
    );
    expect(
      toMarkdown(rankFindings(db, runId, { top: 1 }), { ...context, repoHead: null }),
    ).toContain('HEAD was not recorded');
  });
});
