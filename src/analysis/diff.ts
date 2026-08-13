/**
 * What changed between two runs.
 *
 * The fact store has kept every run since M0 and nothing has ever compared two
 * of them, so the tool could say "this repository has nine high findings" and
 * never "three of those are new since Friday". The second sentence is the one
 * that gets acted on.
 *
 * Everything here is set arithmetic over rows both runs already hold. Nothing
 * is re-derived, no rule is re-evaluated, and a diff of two runs cannot
 * disagree with either run's own report — the same property ADR-0021 gives the
 * ranked list, one level up.
 */

import type { Db } from '../db/database.js';

/**
 * How a finding is recognised across runs.
 *
 * Finding ids are per-run, so identity has to come from content. `rule` plus
 * `title` is it: every rule builds its title deterministically from the
 * entities involved — a package pair, a file path, a class member — so the same
 * problem in the same place produces the same string twice.
 *
 * What this cannot see is a finding whose *wording* changes while the problem
 * stays. That reads as one resolved and one new, and the honest place to say so
 * is here rather than in a footnote nobody reaches.
 */
export interface FindingKey {
  rule: string;
  key: string;
}

export interface DiffFinding {
  rule: string;
  ruleTitle: string;
  title: string;
  severity: string;
  authoredBy: string;
}

export interface CountDelta {
  from: number;
  to: number;
  delta: number;
}

export interface NamedDelta {
  added: string[];
  removed: string[];
  from: number;
  to: number;
}

export interface RunRef {
  id: number;
  repoPath: string;
  repoHead: string | null;
  startedAt: string;
  /** Whether `analyze` left any output on this run. See ADR-0026. */
  analysed: boolean;
}

export interface DiffResult {
  from: RunRef;
  to: RunRef;
  /** True when the two runs describe different repositories. */
  differentRepo: boolean;
  findings: {
    added: DiffFinding[];
    resolved: DiffFinding[];
    unchanged: number;
    addedBySeverity: Array<{ severity: string; count: number }>;
    resolvedBySeverity: Array<{ severity: string; count: number }>;
  };
  counts: {
    packages: CountDelta;
    types: CountDelta;
    endpoints: CountDelta;
    tables: CountDelta;
    edges: CountDelta;
    files: CountDelta;
  };
  /** The named entities worth listing rather than counting. */
  surface: {
    packages: NamedDelta;
    endpoints: NamedDelta;
    tables: NamedDelta;
  };
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

export function diffRuns(db: Db, fromId: number, toId: number): DiffResult {
  const from = runRef(db, fromId);
  const to = runRef(db, toId);

  const before = publishableFindings(db, fromId);
  const after = publishableFindings(db, toId);

  const beforeKeys = new Map(before.map((finding) => [identity(finding), finding]));
  const afterKeys = new Map(after.map((finding) => [identity(finding), finding]));

  const added = [...afterKeys].filter(([key]) => !beforeKeys.has(key)).map(([, f]) => f);
  const resolved = [...beforeKeys].filter(([key]) => !afterKeys.has(key)).map(([, f]) => f);
  const unchanged = afterKeys.size - added.length;

  return {
    from,
    to,
    differentRepo: from.repoPath !== to.repoPath,
    findings: {
      added: rank(added),
      resolved: rank(resolved),
      unchanged,
      addedBySeverity: bySeverity(added),
      resolvedBySeverity: bySeverity(resolved),
    },
    counts: {
      packages: countDelta(db, fromId, toId, kindCount('package')),
      types: countDelta(db, fromId, toId, typeCount()),
      endpoints: countDelta(db, fromId, toId, kindCount('endpoint')),
      tables: countDelta(db, fromId, toId, kindCount('table')),
      edges: countDelta(db, fromId, toId, 'SELECT COUNT(*) AS n FROM edge WHERE run_id = ?'),
      files: countDelta(
        db,
        fromId,
        toId,
        'SELECT COUNT(*) AS n FROM source_file WHERE run_id = ?',
      ),
    },
    surface: {
      packages: namedDelta(db, fromId, toId, 'package'),
      endpoints: namedDelta(db, fromId, toId, 'endpoint'),
      tables: namedDelta(db, fromId, toId, 'table'),
    },
  };
}

/**
 * The identity string for one finding.
 *
 * A package cycle is normalised to its *set* of packages, sorted. The title
 * names the shortest path through a strongly-connected component, and the
 * shortest path can rotate or re-route when an unrelated edge appears — which
 * would report the same cycle as one resolved and one new every time the
 * component changed shape at all. The set is what a reader means by "the same
 * cycle", so that is what is compared.
 *
 * The separator is a plain space because these strings are only ever compared
 * for equality, never parsed back apart, and a rule name is a slug with no
 * space in it. Readable beats clever for a key that shows up in a test failure.
 */
export function identity(finding: DiffFinding): string {
  if (finding.rule === 'package-cycle') {
    const packages = cyclePackages(finding.title);
    if (packages !== null) return `package-cycle ${packages.join(' ')}`;
  }
  return `${finding.rule} ${finding.title}`;
}

/**
 * The packages named in a cycle title, sorted and de-duplicated.
 *
 * Coupled to the wording `src/analysis/cycles.ts` produces. A format change
 * there makes this return null and the diff falls back to comparing whole
 * titles — noisier, never wrong — and the test on this function fails, which is
 * the point of having one.
 */
function cyclePackages(title: string): string[] | null {
  const match = /^Package cycle(?: across \d+ packages)?: (.+)$/.exec(title);
  if (match === null) return null;
  const names = match[1]!
    .split(/\s*(?:⇄|→)\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return [...new Set(names)].sort();
}

/**
 * Publishable findings only — the ones with a citation.
 *
 * The same rule the report and the gate use (ADR-0021). A diff that counted
 * uncited findings would report a build regressing on a claim no output will
 * show anyone.
 */
function publishableFindings(db: Db, runId: number): DiffFinding[] {
  return db
    .prepare(
      `SELECT f.rule AS rule, f.title AS title, f.severity AS severity,
              f.authored_by AS authoredBy
         FROM finding f
        WHERE f.run_id = ?
          AND EXISTS (SELECT 1 FROM citation c WHERE c.finding_id = f.id)
        ORDER BY f.id`,
    )
    .all(runId)
    .map((row) => {
      const finding = row as Omit<DiffFinding, 'ruleTitle'>;
      return { ...finding, ruleTitle: finding.rule };
    });
}

function rank(findings: DiffFinding[]): DiffFinding[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      a.rule.localeCompare(b.rule) ||
      a.title.localeCompare(b.title),
  );
}

function bySeverity(findings: DiffFinding[]): Array<{ severity: string; count: number }> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return [...counts]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

function kindCount(kind: string): string {
  return `SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND is_stub = 0 AND kind = '${kind}'`;
}

function typeCount(): string {
  return `SELECT COUNT(*) AS n FROM node WHERE run_id = ? AND is_stub = 0
            AND kind IN ('class','interface','enum','annotation')`;
}

function countDelta(db: Db, fromId: number, toId: number, sql: string): CountDelta {
  const one = (runId: number): number =>
    (db.prepare(sql).get(runId) as { n: number }).n;
  const from = one(fromId);
  const to = one(toId);
  return { from, to, delta: to - from };
}

/** Names present in one run and not the other. Capped by the caller, not here. */
function namedDelta(db: Db, fromId: number, toId: number, kind: string): NamedDelta {
  const names = (runId: number): Set<string> =>
    new Set(
      (
        db
          .prepare(
            `SELECT fqn FROM node WHERE run_id = ? AND is_stub = 0 AND kind = ? ORDER BY fqn`,
          )
          .all(runId, kind) as Array<{ fqn: string }>
      ).map((row) => row.fqn),
    );

  const before = names(fromId);
  const after = names(toId);
  return {
    added: [...after].filter((fqn) => !before.has(fqn)).sort(),
    removed: [...before].filter((fqn) => !after.has(fqn)).sort(),
    from: before.size,
    to: after.size,
  };
}

function runRef(db: Db, runId: number): RunRef {
  const row = db
    .prepare(
      `SELECT id, repo_path AS repoPath, repo_head AS repoHead, started_at AS startedAt
         FROM run WHERE id = ?`,
    )
    .get(runId) as
    | { id: number; repoPath: string; repoHead: string | null; startedAt: string }
    | undefined;
  if (row === undefined) throw new Error(`run ${runId} is not in this store`);

  // Bound three times rather than as `?1` reused: better-sqlite3 counts
  // placeholders positionally and rejects a numbered one used more than once.
  const analysed =
    (
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM cluster WHERE run_id = ?)
                + (SELECT COUNT(*) FROM finding WHERE run_id = ?)
                + (SELECT COUNT(*) FROM temporal_coupling WHERE run_id = ?) AS n`,
        )
        .get(runId, runId, runId) as { n: number }
    ).n > 0;

  return { ...row, analysed };
}
