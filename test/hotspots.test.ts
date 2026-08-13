import { beforeEach, describe, expect, it } from 'vitest';

import type { CoupledPair } from '../src/analysis/coupling.js';
import {
  BUS_FACTOR_RULE,
  COUPLING_RULE,
  HOTSPOT_RULE,
  recordHistoryFindings,
} from '../src/analysis/history-findings.js';
import { busFactorRisks, topHotspots } from '../src/analysis/hotspots.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';

let db: Db;
let runId: number;
let sha = 0;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  runId = createRun(db, '/tmp/repo').id;
  sha = 0;
});

function metric(path: string, values: Partial<Record<string, number | string | null>>): void {
  db.prepare(
    `INSERT INTO file_metric
       (run_id, path, commits, churn, complexity, authors, top_author_share, last_change_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    path,
    values['commits'] ?? 1,
    values['churn'] ?? 1,
    values['complexity'] === undefined ? 1 : values['complexity'],
    values['authors'] ?? 1,
    values['topAuthorShare'] ?? 1,
    values['lastChangeAt'] ?? '2024-01-01T00:00:00.000Z',
  );
}

/** One commit by `author` touching `files`, with a given churn each. */
function commit(author: string, files: string[], churn = 1): string {
  sha += 1;
  const id = `sha${String(sha).padStart(3, '0')}`;
  const commitId = Number(
    db
      .prepare(
        `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
         VALUES (?, ?, ?, ?, ?, 'subject', 0)`,
      )
      .run(runId, id, author, `${author}@example.invalid`, `2024-01-01T00:00:${String(sha).padStart(2, '0')}.000Z`)
      .lastInsertRowid,
  );
  for (const path of files) {
    db.prepare(
      `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(runId, commitId, path, path, churn);
  }
  return id;
}

describe('topHotspots', () => {
  it('ranks by churn times complexity, not by either alone', () => {
    // Churned but flat, and complicated but untouched, are both uninteresting.
    metric('churned-but-flat.java', { churn: 1000, complexity: 1 });
    metric('deep-but-still.java', { churn: 1, complexity: 1000 });
    metric('hotspot.java', { churn: 200, complexity: 200 });

    expect(topHotspots(db, runId, 10).map((h) => h.path)).toEqual([
      'hotspot.java',
      'churned-but-flat.java',
      'deep-but-still.java',
    ]);
  });

  it('excludes a file with no complexity score rather than ranking it last', () => {
    // Unmeasured is not simple, and ranking it last would say it was.
    metric('binary.bin', { churn: 5000, complexity: null });
    metric('real.java', { churn: 10, complexity: 10 });

    expect(topHotspots(db, runId, 10).map((h) => h.path)).toEqual(['real.java']);
  });

  it('excludes a file that never changed', () => {
    metric('untouched.java', { churn: 0, complexity: 100 });
    expect(topHotspots(db, runId, 10)).toEqual([]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 10; i += 1) metric(`f${i}.java`, { churn: i + 1, complexity: 10 });
    expect(topHotspots(db, runId, 3)).toHaveLength(3);
  });

  it('computes the smallest author set covering more than half the commits', () => {
    metric('shared.java', { churn: 10, complexity: 10, commits: 5, authors: 3 });
    commit('ada', ['shared.java']);
    commit('ada', ['shared.java']);
    commit('ada', ['shared.java']);
    commit('bob', ['shared.java']);
    commit('cat', ['shared.java']);

    // ada alone has 3 of 5, which is more than half.
    expect(topHotspots(db, runId, 10)[0]).toMatchObject({ busFactor: 1, topAuthor: 'ada@example.invalid' });
  });

  it('needs two authors when neither has a majority alone', () => {
    metric('split.java', { churn: 10, complexity: 10, commits: 4, authors: 3 });
    commit('ada', ['split.java']);
    commit('bob', ['split.java']);
    commit('cat', ['split.java']);
    commit('cat', ['split.java']);

    // cat has 2 of 4 — exactly half, not more — so it takes a second author.
    expect(topHotspots(db, runId, 10)[0]).toMatchObject({ busFactor: 2 });
  });
});

describe('busFactorRisks', () => {
  it('finds a file whose history is one person', () => {
    metric('owned.java', { churn: 50, complexity: 10, commits: 6, authors: 1 });
    for (let i = 0; i < 6; i += 1) commit('ada', ['owned.java']);

    expect(busFactorRisks(db, runId, 10, 5).map((f) => f.path)).toEqual(['owned.java']);
  });

  it('ignores a file too new for its ownership to mean anything', () => {
    // Two commits by one author is a new file, not a bus factor.
    metric('brand-new.java', { churn: 50, complexity: 10, commits: 2, authors: 1 });
    commit('ada', ['brand-new.java']);
    commit('ada', ['brand-new.java']);

    expect(busFactorRisks(db, runId, 10, 5)).toEqual([]);
  });

  it('ignores a file with knowledge genuinely spread around', () => {
    metric('shared.java', { churn: 50, complexity: 10, commits: 6, authors: 3 });
    for (const author of ['ada', 'ada', 'bob', 'bob', 'cat', 'cat']) commit(author, ['shared.java']);

    expect(busFactorRisks(db, runId, 10, 5)).toEqual([]);
  });

  it('ranks by churn, so the risk that matters most comes first', () => {
    metric('big.java', { churn: 900, complexity: 10, commits: 8, authors: 1 });
    metric('small.java', { churn: 9, complexity: 10, commits: 8, authors: 1 });
    for (let i = 0; i < 8; i += 1) commit('ada', ['big.java', 'small.java']);

    expect(busFactorRisks(db, runId, 10, 5).map((f) => f.path)).toEqual([
      'big.java',
      'small.java',
    ]);
  });

  it('includes a file with no complexity score, because ownership does not need one', () => {
    metric('config.xml', { churn: 40, complexity: null, commits: 7, authors: 1 });
    for (let i = 0; i < 7; i += 1) commit('ada', ['config.xml']);

    expect(busFactorRisks(db, runId, 10, 5).map((f) => f.path)).toEqual(['config.xml']);
  });
});

describe('recordHistoryFindings', () => {
  const pair = (over: Partial<CoupledPair> = {}): CoupledPair => ({
    pathA: 'OrderService.java',
    pathB: 'order-form.html',
    shared: 18,
    commitsA: 20,
    commitsB: 20,
    strength: 0.9,
    lift: 6.2,
    staticEdges: 0,
    parsedA: true,
    parsedB: true,
    ...over,
  });

  function findings(rule: string) {
    return db
      .prepare('SELECT id, title, detail, severity, authored_by FROM finding WHERE run_id = ? AND rule = ?')
      .all(runId, rule) as Array<Record<string, unknown>>;
  }

  it('writes a coupling finding citing the commits that produced it', () => {
    const shas = [
      commit('ada', ['OrderService.java', 'order-form.html']),
      commit('ada', ['OrderService.java', 'order-form.html']),
    ];
    metric('OrderService.java', {});
    metric('order-form.html', {});

    const counts = recordHistoryFindings(db, runId, {
      pairs: [pair()],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });

    expect(counts.coupling).toBe(1);
    const [finding] = findings(COUPLING_RULE);
    expect(finding).toMatchObject({ severity: 'high', authored_by: 'algorithm' });
    expect(finding?.['title']).toMatch(/no dependency between them/);

    const cited = db
      .prepare(`SELECT kind, commit_sha FROM citation WHERE finding_id = ? ORDER BY commit_sha`)
      .all(finding?.['id']) as Array<{ kind: string; commit_sha: string }>;
    expect(cited.map((c) => c.commit_sha)).toEqual([...shas].sort());
    expect(cited.every((c) => c.kind === 'commit')).toBe(true);
  });

  it('says nothing about a pair the static graph already explains', () => {
    // The dependency doing its job is not news, and on a large repository
    // those would bury the pairs that matter.
    recordHistoryFindings(db, runId, {
      pairs: [pair({ staticEdges: 4 })],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });
    expect(findings(COUPLING_RULE)).toEqual([]);
  });

  it('grades coupling severity by strength', () => {
    recordHistoryFindings(db, runId, {
      pairs: [
        pair({ pathA: 'a.java', strength: 0.95 }),
        pair({ pathA: 'b.java', strength: 0.6 }),
        pair({ pathA: 'c.java', strength: 0.2 }),
      ],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });
    expect(findings(COUPLING_RULE).map((f) => f['severity'])).toEqual(['high', 'medium', 'low']);
  });

  it('will not rate a coupling claim it could not check as strongly as one it could', () => {
    // petclinic's `gradle-wrapper.jar` and `gradlew.bat` co-change in 11 of 11
    // commits — a perfect strength that means one tool regenerates both. Rated
    // on strength alone that was `high`, and twenty like it filled the band a
    // package cycle competes in (ADR-0028).
    recordHistoryFindings(db, runId, {
      pairs: [
        pair({ pathA: 'a.java', pathB: 'b.java', strength: 0.95 }),
        pair({ pathA: 'gradlew', pathB: 'gradlew.bat', strength: 0.95, parsedA: false, parsedB: false }),
        pair({ pathA: 'c.java', pathB: 'schema.sql', strength: 0.95, parsedB: false }),
      ],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });

    expect(findings(COUPLING_RULE).map((f) => f['severity'])).toEqual(['high', 'low', 'low']);
  });

  it('rates nothing as high when there was no static graph to check against', () => {
    // Every pair has staticEdges 0 here because nothing was extracted, not
    // because nothing connects them. Severity has to reflect that too, or a
    // history-only run reports its whole coupling list as high.
    recordHistoryFindings(db, runId, {
      pairs: [pair({ strength: 0.95 })],
      hotspots: [],
      busFactor: [],
      staticGraph: false,
    });

    expect(findings(COUPLING_RULE)[0]?.['severity']).toBe('low');
  });

  it('does not claim an absence it never checked for', () => {
    // With no extracted code, staticEdges is zero for every pair because
    // nothing was looked at. The finding has to say that, or it asserts an
    // absence that was never established.
    recordHistoryFindings(db, runId, {
      pairs: [pair()],
      hotspots: [],
      busFactor: [],
      staticGraph: false,
    });

    const [finding] = findings(COUPLING_RULE);
    expect(finding?.['title']).toBe('OrderService.java and order-form.html change together');
    expect(finding?.['detail']).toMatch(/no evidence was found either way/);
    expect(finding?.['detail']).not.toMatch(/No imports, calls/);
  });

  it('does not credit the static graph for files it cannot hold', () => {
    // Two build files can never have an edge between them. "No dependency
    // between them" is true of them and worth nothing, and on dubbo pairs of
    // poms and wrapper scripts are most of the top of the list.
    recordHistoryFindings(db, runId, {
      pairs: [pair({ pathA: 'a/pom.xml', pathB: 'b/pom.xml', parsedA: false, parsedB: false })],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });

    const [finding] = findings(COUPLING_RULE);
    expect(finding?.['title']).toBe('a/pom.xml and b/pom.xml change together');
    expect(finding?.['detail']).toMatch(/No extractor parses a\/pom\.xml or b\/pom\.xml/);
    expect(finding?.['detail']).toMatch(/not a demonstrated absence of coupling/);
  });

  it('names only the unparsed half when one file is code', () => {
    recordHistoryFindings(db, runId, {
      pairs: [pair({ pathA: 'A.java', pathB: 'schema.sql', parsedA: true, parsedB: false })],
      hotspots: [],
      busFactor: [],
      staticGraph: true,
    });
    expect(findings(COUPLING_RULE)[0]?.['detail']).toMatch(/No extractor parses schema\.sql, so/);
  });

  it('reports the lift in the detail, so the claim can be checked', () => {
    recordHistoryFindings(db, runId, { pairs: [pair()], hotspots: [], busFactor: [], staticGraph: true });
    expect(findings(COUPLING_RULE)[0]?.['detail']).toMatch(/6\.2x what independent files would share/);
  });

  it('writes a hotspot finding citing its biggest commits', () => {
    metric('Fat.java', { churn: 100, complexity: 50, commits: 3 });
    const small = commit('ada', ['Fat.java'], 1);
    const big = commit('ada', ['Fat.java'], 500);

    recordHistoryFindings(db, runId, {
      pairs: [],
      hotspots: topHotspots(db, runId, 10),
      busFactor: [],
      staticGraph: true,
    });

    const [finding] = findings(HOTSPOT_RULE);
    // Medium, not high: hotspot severity comes from rank within this
    // repository, and a relative position must not outrank a cited structural
    // defect in the same list (ADR-0028).
    expect(finding?.['severity']).toBe('medium');
    const cited = db
      .prepare('SELECT commit_sha FROM citation WHERE finding_id = ?')
      .all(finding?.['id']) as Array<{ commit_sha: string }>;
    expect(cited[0]?.commit_sha).toBe(big);
    expect(cited.map((c) => c.commit_sha)).toContain(small);
  });

  it('says a hotspot score is a proxy rather than a parsed measure', () => {
    metric('Fat.java', { churn: 100, complexity: 50 });
    commit('ada', ['Fat.java']);
    recordHistoryFindings(db, runId, {
      pairs: [],
      hotspots: topHotspots(db, runId, 10),
      busFactor: [],
      staticGraph: true,
    });
    expect(findings(HOTSPOT_RULE)[0]?.['detail']).toMatch(/proxy for nesting/);
  });

  it('writes a bus-factor finding about the knowledge, not about the person', () => {
    metric('owned.java', { churn: 50, complexity: 10, commits: 6, authors: 1 });
    for (let i = 0; i < 6; i += 1) commit('ada', ['owned.java']);

    recordHistoryFindings(db, runId, {
      pairs: [],
      hotspots: [],
      busFactor: busFactorRisks(db, runId, 10, 5),
      staticGraph: true,
    });

    const [finding] = findings(BUS_FACTOR_RULE);
    expect(finding?.['severity']).toBe('high');
    expect(finding?.['detail']).toMatch(/not about the author/);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM citation WHERE finding_id = ?').get(finding?.['id']),
    ).toEqual({ n: 5 });
  });

  it('replaces its own findings rather than appending', () => {
    metric('OrderService.java', {});
    metric('order-form.html', {});
    commit('ada', ['OrderService.java', 'order-form.html']);

    recordHistoryFindings(db, runId, { pairs: [pair()], hotspots: [], busFactor: [], staticGraph: true });
    recordHistoryFindings(db, runId, { pairs: [pair()], hotspots: [], busFactor: [], staticGraph: true });

    expect(findings(COUPLING_RULE)).toHaveLength(1);
    // Citations went with them, rather than being orphaned.
    expect(db.prepare('SELECT COUNT(*) AS n FROM citation').get()).toEqual({ n: 1 });
  });

  it('leaves findings from other rules alone', () => {
    db.prepare(
      `INSERT INTO finding (run_id, rule, title, severity, authored_by)
       VALUES (?, 'package-cycle', 'a cycle', 'high', 'algorithm')`,
    ).run(runId);

    recordHistoryFindings(db, runId, { pairs: [], hotspots: [], busFactor: [], staticGraph: true });

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE rule = 'package-cycle'`).get(),
    ).toEqual({ n: 1 });
  });
});
