/**
 * The ranked findings list.
 *
 * This reads `finding` joined to `citation` and re-derives nothing. Every rule
 * has already written its rows during `analyze`, with the evidence attached, so
 * a report is a view of the run rather than a second opinion about it — two
 * reports of one run cannot disagree, and neither can a report and the terminal
 * output that preceded it.
 *
 * It is also the enforcement point the schema comment on `citation` promises:
 * a finding with no citations is not publishable. See ADR-0021.
 */

import type { Db } from '../db/database.js';

/** Severity, as a number, so the ordering is arithmetic rather than a lookup. */
const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** A model's proposal sorts below an algorithm's finding of the same severity. */
const AUTHOR_RANK: Record<string, number> = { algorithm: 0, model: 1 };

/**
 * Human wording per rule, for a report a non-author has to read.
 *
 * A rule missing from here still appears — under its own name, which is worse
 * looking but never a silent omission.
 */
const RULE_TITLES: Record<string, string> = {
  'package-cycle': 'Package cycle',
  'intent-mismatch': 'Name and edges disagree',
  'logical-coupling': 'Changes together, with no dependency',
  hotspot: 'Hotspot — churn × complexity',
  'bus-factor': 'History is one person',
  'unbounded-subscription': 'Subscription with no way to unsubscribe',
  'cluster-responsibility': 'Cluster responsibility (model-authored)',
  'intent-reading': 'Reading of a mismatch (model-authored)',
  'adr-candidate': 'ADR candidate (model-authored proposal)',
};

export interface FindingEvidence {
  kind: 'node' | 'edge' | 'file' | 'commit';
  /** `src/shop/Order.java:41`, an fqn, or a short sha. */
  label: string;
  path: string | null;
  line: number | null;
}

export interface RankedFinding {
  id: number;
  rule: string;
  /** The rule's human wording, or the rule name when there is none. */
  ruleTitle: string;
  title: string;
  detail: string | null;
  severity: string;
  authoredBy: 'algorithm' | 'model';
  model: string | null;
  evidence: FindingEvidence[];
}

export interface RankedFindings {
  findings: RankedFinding[];
  /** How many rows exist for this run, before ranking or capping. */
  total: number;
  /**
   * Findings excluded for carrying no citation. Reported rather than dropped:
   * a report that quietly hid a finding would be lying by omission about the
   * same thing it exists to prevent.
   */
  uncited: number;
  /** Counts per rule, over everything publishable — not only what is shown. */
  byRule: Array<{ rule: string; ruleTitle: string; count: number }>;
  /** Counts per severity, likewise. */
  bySeverity: Array<{ severity: string; count: number }>;
}

export interface FindingsOptions {
  /** Maximum findings returned. The counts above still describe everything. */
  top: number;
  /** Evidence rows resolved per finding. */
  evidencePerFinding?: number | undefined;
}

const DEFAULT_EVIDENCE = 6;

/**
 * Read and rank every publishable finding for a run.
 *
 * The order is total and deterministic (ADR-0021): severity, then author, then
 * how much evidence there is, then rule name, then id. The last one guarantees
 * there is no tie left to break by insertion order.
 */
export function rankFindings(db: Db, runId: number, options: FindingsOptions): RankedFindings {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT f.id AS id, f.rule AS rule, f.title AS title, f.detail AS detail,
             f.severity AS severity, f.authored_by AS authoredBy, f.model AS model,
             COUNT(c.id) AS citations
        FROM finding f
        LEFT JOIN citation c ON c.finding_id = f.id
       WHERE f.run_id = @runId
       GROUP BY f.id
       ORDER BY f.id`,
    )
    .all({ runId }) as Array<{
    id: number;
    rule: string;
    title: string;
    detail: string | null;
    severity: string;
    authoredBy: 'algorithm' | 'model';
    model: string | null;
    citations: number;
  }>;

  const publishable = rows.filter((row) => row.citations > 0);
  const ranked = [...publishable].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      (AUTHOR_RANK[a.authoredBy] ?? 0) - (AUTHOR_RANK[b.authoredBy] ?? 0) ||
      b.citations - a.citations ||
      a.rule.localeCompare(b.rule) ||
      a.id - b.id,
  );

  const perFinding = options.evidencePerFinding ?? DEFAULT_EVIDENCE;
  const findings = ranked.slice(0, options.top).map((row) => ({
    id: row.id,
    rule: row.rule,
    ruleTitle: ruleTitle(row.rule),
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    authoredBy: row.authoredBy,
    model: row.model,
    evidence: loadEvidence(db, row.id, perFinding),
  }));

  return {
    findings,
    total: rows.length,
    uncited: rows.length - publishable.length,
    byRule: countBy(publishable, (row) => row.rule)
      .map(({ key, count }) => ({ rule: key, ruleTitle: ruleTitle(key), count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    bySeverity: countBy(publishable, (row) => row.severity)
      .map(({ key, count }) => ({ severity: key, count }))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
          a.severity.localeCompare(b.severity),
      ),
  };
}

export function ruleTitle(rule: string): string {
  return RULE_TITLES[rule] ?? rule;
}

/**
 * Resolve a finding's citations to something a reader can open.
 *
 * A citation to an edge is the interesting one: the row itself is a pair of
 * node ids, and what the reader needs is the file and line the extractor saw
 * it at, plus which two things it connected.
 */
function loadEvidence(db: Db, findingId: number, limit: number): FindingEvidence[] {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT c.kind        AS kind,
             c.line        AS citedLine,
             c.commit_sha  AS sha,
             n.fqn         AS nodeFqn,
             e.kind        AS edgeKind,
             en.fqn        AS edgeSrc,
             dn.fqn        AS edgeDst,
             COALESCE(cf.path, ef.path, nf.path) AS path,
             COALESCE(c.line, e.line, n.start_line) AS line,
             gc.subject    AS subject,
             gc.author_name AS author
        FROM citation c
        LEFT JOIN node n         ON n.id = c.node_id
        LEFT JOIN source_file nf ON nf.id = n.file_id
        LEFT JOIN edge e         ON e.id = c.edge_id
        LEFT JOIN source_file ef ON ef.id = e.file_id
        LEFT JOIN node en        ON en.id = e.src_id
        LEFT JOIN node dn        ON dn.id = e.dst_id
        LEFT JOIN source_file cf ON cf.id = c.file_id
        LEFT JOIN git_commit gc  ON gc.sha = c.commit_sha
       WHERE c.finding_id = @findingId
       ORDER BY c.id
       LIMIT @limit`,
    )
    .all({ findingId, limit }) as Array<{
    kind: FindingEvidence['kind'];
    citedLine: number | null;
    sha: string | null;
    nodeFqn: string | null;
    edgeKind: string | null;
    edgeSrc: string | null;
    edgeDst: string | null;
    path: string | null;
    line: number | null;
    subject: string | null;
    author: string | null;
  }>;

  return rows.map((row) => ({
    kind: row.kind,
    label: describe(row),
    path: row.path,
    line: row.line,
  }));
}

function describe(row: {
  kind: string;
  sha: string | null;
  nodeFqn: string | null;
  edgeKind: string | null;
  edgeSrc: string | null;
  edgeDst: string | null;
  path: string | null;
  subject: string | null;
  author: string | null;
}): string {
  switch (row.kind) {
    case 'edge':
      return row.edgeSrc === null || row.edgeDst === null
        ? /* c8 ignore next */ (row.edgeKind ?? 'edge')
        : `${row.edgeKind ?? 'edge'} ${row.edgeSrc} → ${row.edgeDst}`;
    case 'node':
      return row.nodeFqn ?? /* c8 ignore next */ 'node';
    case 'commit': {
      const sha = (row.sha ?? '').slice(0, 10);
      const parts = [sha];
      if (row.subject !== null) parts.push(row.subject);
      if (row.author !== null) parts.push(`(${row.author})`);
      return parts.join(' ');
    }
    default:
      return row.path ?? /* c8 ignore next */ 'file';
  }
}

function countBy<T>(rows: T[], key: (row: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, count]) => ({ key: k, count }));
}
