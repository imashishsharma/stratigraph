import { beforeEach, describe, expect, it } from 'vitest';

import type { CoupledPair } from '../src/analysis/coupling.js';
import {
  BUS_FACTOR_RULE,
  COUPLING_RULE,
  HOTSPOT_RULE,
  recordHistoryFindings,
} from '../src/analysis/history-findings.js';
import { busFactorRisks, explainHotspots, topHotspots } from '../src/analysis/hotspots.js';
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
  const commits = (values['commits'] as number | undefined) ?? 1;
  db.prepare(
    `INSERT INTO file_metric
       (run_id, path, commits, churn, complexity, authors, top_author_share, last_change_at,
        recent_commits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    path,
    commits,
    values['churn'] ?? 1,
    values['complexity'] === undefined ? 1 : values['complexity'],
    values['authors'] ?? 1,
    values['topAuthorShare'] ?? 1,
    values['lastChangeAt'] ?? '2024-01-01T00:00:00.000Z',
    values['recent'] ?? commits,
  );
  db.prepare(`INSERT INTO file_role (run_id, path, role, rule) VALUES (?, ?, ?, 'test')`).run(
    runId,
    path,
    values['role'] ?? 'source',
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
  it('ranks by recent change and complexity together, not by either alone', () => {
    // Changed often but flat, and complicated but untouched, are both uninteresting.
    metric('busy-but-flat.java', { recent: 40, complexity: 1 });
    metric('deep-but-still.java', { recent: 1, complexity: 1000 });
    metric('hotspot.java', { recent: 30, complexity: 800 });

    expect(topHotspots(db, runId, 10).map((h) => h.path)[0]).toBe('hotspot.java');
  });

  it('does not let a much larger file win on size alone', () => {
    // ADR-0031: v1 scored churn-in-lines x total indentation, which grows with
    // size squared, and a lockfile outranked every hand-written file.
    metric('Giant.java', { recent: 3, complexity: 50_000, churn: 900_000 });
    metric('Busy.java', { recent: 30, complexity: 800, churn: 2_000 });
    metric('Mid.java', { recent: 10, complexity: 400, churn: 900 });
    metric('Quiet.java', { recent: 1, complexity: 100, churn: 20 });

    const ranked = topHotspots(db, runId, 10);
    expect(ranked.map((h) => h.path)).toEqual(['Busy.java', 'Giant.java', 'Mid.java', 'Quiet.java']);
    expect(ranked[0]).toMatchObject({ recentPercentile: 1, complexityPercentile: 0.75, score: 0.75 });
  });

  it('compares complexity within a file type, so markup does not outrank code by nesting', () => {
    // jhipster-sample-app: with one pool, Angular templates took 14 of the top
    // 20, because markup nests deeply without branching. Indentation in HTML
    // and indentation in Java are not the same unit.
    for (let i = 0; i < 10; i += 1) {
      metric(`t${i}.html`, { recent: 5, complexity: 1000 + i * 100 });
      metric(`c${i}.java`, { recent: 5, complexity: 100 + i * 10 });
    }

    const top = topHotspots(db, runId, 2).map((h) => h.path);
    expect(top.sort()).toEqual(['c9.java', 't9.html']);
  });

  it('ranks a file type too small to rank against itself against everything', () => {
    // A lone .sql file must not score the top complexity percentile by being
    // the only one of its kind.
    for (let i = 0; i < 10; i += 1) metric(`c${i}.java`, { recent: 5, complexity: 100 + i * 10 });
    metric('only.sql', { recent: 5, complexity: 1 });

    const sql = topHotspots(db, runId, 20).find((h) => h.path === 'only.sql');
    expect(sql?.complexityPercentile).toBeLessThan(0.2);
  });

  it('ranks only source files', () => {
    metric('package-lock.json', { recent: 500, complexity: 90_000, role: 'lockfile' });
    metric('package.json', { recent: 400, complexity: 200, role: 'manifest' });
    metric('src/test/BigTest.java', { recent: 300, complexity: 9_000, role: 'test' });
    metric('src/api/Generated.java', { recent: 300, complexity: 9_000, role: 'generated' });
    metric('src/Real.java', { recent: 2, complexity: 20 });

    expect(topHotspots(db, runId, 10).map((h) => h.path)).toEqual(['src/Real.java']);
  });

  it('excludes a file with no complexity score rather than ranking it last', () => {
    // Unmeasured is not simple, and ranking it last would say it was.
    metric('binary.java', { recent: 50, complexity: null });
    metric('real.java', { recent: 10, complexity: 10 });

    expect(topHotspots(db, runId, 10).map((h) => h.path)).toEqual(['real.java']);
  });

  it('excludes a file not changed within the window', () => {
    metric('untouched.java', { commits: 90, recent: 0, complexity: 100 });
    expect(topHotspots(db, runId, 10)).toEqual([]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 10; i += 1) metric(`f${i}.java`, { recent: i + 1, complexity: 10 });
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

describe('explainHotspots', () => {
  function window(values: { commits: number; bulk?: number; ignored?: number; start?: string | null }): void {
    db.prepare(
      `INSERT INTO history_window
         (run_id, window_start, window_end, months, max_files, commits, excluded_bulk, excluded_ignored)
       VALUES (?, ?, '2026-09-18T00:00:00.000Z', 12, 50, ?, ?, ?)`,
    ).run(runId, values.start === undefined ? '2025-09-18T00:00:00.000Z' : values.start, values.commits, values.bulk ?? 0, values.ignored ?? 0);
  }

  it('says when every commit in the window was a sweep, instead of an empty list', () => {
    // jhipster-sample-app: all 7 commits in its last year regenerate 81-377 files.
    metric('src/A.java', { recent: 0 });
    window({ commits: 7, bulk: 7 });

    expect(explainHotspots(db, runId, 0)).toMatch(/every one of the 7 commit\(s\) .* was a sweep/);
  });

  it('says how the ranking was made when there is one', () => {
    metric('src/A.java', { recent: 3 });
    window({ commits: 10, bulk: 2, ignored: 1 });

    const text = explainHotspots(db, runId, 1);
    expect(text).toMatch(/12 months to 2026-09-18/);
    expect(text).toMatch(/2 touched more than 50 files and 1 are listed in .git-blame-ignore-revs/);
  });

  it('tells a store mined before file roles to re-run history', () => {
    expect(explainHotspots(db, runId, 0)).toMatch(/Fix: `stratigraph history`/);
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

  it('ranks by recent commits, so the knowledge in use comes first', () => {
    metric('active.java', { churn: 9, complexity: 10, commits: 8, recent: 8, authors: 1 });
    metric('dormant.java', { churn: 900, complexity: 10, commits: 8, recent: 1, authors: 1 });
    for (let i = 0; i < 8; i += 1) commit('ada', ['active.java', 'dormant.java']);

    expect(busFactorRisks(db, runId, 10, 5).map((f) => f.path)).toEqual([
      'active.java',
      'dormant.java',
    ]);
  });

  it('ignores a file nobody has touched within the window', () => {
    metric('fossil.java', { commits: 8, recent: 0, authors: 1 });
    for (let i = 0; i < 8; i += 1) commit('ada', ['fossil.java']);

    expect(busFactorRisks(db, runId, 10, 5)).toEqual([]);
  });

  it('considers source files only', () => {
    // One person bumping dependencies is not concentrated knowledge.
    metric('package-lock.json', { commits: 40, authors: 1, role: 'lockfile' });
    metric('config.xml', { commits: 7, authors: 1, role: 'config', complexity: null });
    for (let i = 0; i < 7; i += 1) commit('ada', ['package-lock.json', 'config.xml']);

    expect(busFactorRisks(db, runId, 10, 5)).toEqual([]);
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
    // Medium: whether one owner is a risk depends on the file mattering, which
    // this rule cannot see (ADR-0031).
    expect(finding?.['severity']).toBe('medium');
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
