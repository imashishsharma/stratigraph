/**
 * The four questions an engineer asks from inside an editor (product plan,
 * Phase C): what breaks if I change this, who knows this file, where is this
 * table written, and why is this file a hotspot. Each is answered from stored
 * rows, one citable hop at a time, like every other query (ADR-0015).
 */

import { declaredInTest } from '../analysis/package-graph.js';
import { topHotspots, type Hotspot } from '../analysis/hotspots.js';
import type { Db } from '../db/database.js';

// ------------------------------------------------------------ what breaks

export interface Impact {
  fqn: string;
  kind: string;
  /** Hops from the subject: 1 = depends on it directly. */
  depth: number;
  /** The dependency that put it here: its edge kind, and where it is written. */
  via: { edgeKind: string; to: string; file: string | null; line: number | null };
  test: boolean;
}

export interface WhatBreaksResult {
  found: boolean;
  subject: string | null;
  depth: number;
  /** Main code, nearest first. */
  impacted: Impact[];
  /** Tests that reach the subject — they break too, and are counted apart. */
  tests: Impact[];
  /** HTTP endpoints served by an impacted method. */
  endpoints: Array<{ endpoint: string; handler: string; file: string | null; line: number | null }>;
  truncated: boolean;
}

const DEPENDENCY = `'calls','injects','extends','implements'`;

/**
 * Everything that depends on the subject, transitively, up to `depth` hops,
 * over observed call, injection and inheritance edges. A dependency counts on
 * the subject or anything it declares; each impacted element is reported at
 * the first hop that reaches it, with the edge that did.
 */
export function whatBreaksIf(
  db: Db,
  runId: number,
  options: { fqn: string; depth?: number | undefined; limit?: number | undefined },
): WhatBreaksResult {
  const depth = Math.min(Math.max(options.depth ?? 3, 1), 6);
  const limit = options.limit ?? 100;
  const subject = db
    .prepare(`SELECT id, fqn FROM node WHERE run_id = ? AND fqn = ? ORDER BY is_stub LIMIT 1`)
    .get(runId, options.fqn.trim()) as { id: number; fqn: string } | undefined;
  if (subject === undefined) {
    return { found: false, subject: null, depth, impacted: [], tests: [], endpoints: [], truncated: false };
  }

  const inbound = db.prepare(
    /* sql */ `
    WITH RECURSIVE subtree(id) AS (
        SELECT @id
      UNION
        SELECT n.id FROM node n JOIN subtree s ON n.parent_id = s.id
    )
    SELECT src.id AS id, src.fqn AS fqn, src.kind AS kind, e.kind AS edgeKind, dst.fqn AS target,
           f.path AS file, e.line AS line,
           COALESCE(owner.id, src.id) AS ownerId,
           ${declaredInTest('src')} AS test
      FROM edge e
      JOIN subtree t ON t.id = e.dst_id
      JOIN node src ON src.id = e.src_id
      JOIN node dst ON dst.id = e.dst_id
      LEFT JOIN node owner ON owner.id = src.parent_id AND src.kind IN ('method', 'field')
      LEFT JOIN source_file f ON f.id = e.file_id
     WHERE e.run_id = @runId AND e.kind IN (${DEPENDENCY}) AND e.confidence = 'fact'
       AND e.src_id NOT IN (SELECT id FROM subtree)
     ORDER BY src.fqn, f.path, e.line`,
  );

  const seen = new Set<number>([subject.id]);
  const impacted: Impact[] = [];
  const tests: Impact[] = [];
  let frontier = [subject.id];
  let truncated = false;
  for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const row of inbound.all({ runId, id }) as Array<{
        id: number;
        fqn: string;
        kind: string;
        edgeKind: string;
        target: string;
        file: string | null;
        line: number | null;
        ownerId: number;
        test: number;
      }>) {
        // A method's dependents are its type's dependents too: step up to
        // the declaring type so the next hop asks who uses it.
        const key = row.ownerId;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: Impact = {
          fqn: row.fqn,
          kind: row.kind,
          depth: hop,
          via: { edgeKind: row.edgeKind, to: row.target, file: row.file, line: row.line },
          test: row.test === 1,
        };
        (entry.test ? tests : impacted).push(entry);
        if (!entry.test) next.push(key);
        if (impacted.length + tests.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }

  const endpoints =
    impacted.length === 0
      ? []
      : (db
          .prepare(
            /* sql */ `
            SELECT ep.fqn AS endpoint, m.fqn AS handler, f.path AS file, e.line AS line
              FROM edge e
              JOIN node m ON m.id = e.src_id
              JOIN node ep ON ep.id = e.dst_id AND ep.kind = 'endpoint'
              LEFT JOIN source_file f ON f.id = e.file_id
             WHERE e.run_id = ? AND e.kind = 'handles'
               AND (m.fqn = ? OR m.fqn IN (${marks(impacted)})
                    OR m.parent_id IN (SELECT id FROM node WHERE run_id = ? AND fqn IN (${marks(impacted)})))
             ORDER BY ep.fqn`,
          )
          .all(
            runId,
            subject.fqn,
            ...impacted.map((i) => i.fqn),
            runId,
            ...impacted.map((i) => i.fqn),
          ) as WhatBreaksResult['endpoints']);

  return { found: true, subject: subject.fqn, depth, impacted, tests, endpoints, truncated };
}

function marks(items: readonly unknown[]): string {
  return items.map(() => '?').join(',');
}

// --------------------------------------------------------------- who knows

export interface WhoKnowsResult {
  found: boolean;
  path: string;
  commits: number;
  authors: Array<{ author: string; commits: number; share: number; last: string }>;
  /** The most recent commits, for citation. */
  recent: Array<{ sha: string; author: string; date: string; subject: string | null }>;
}

/** Who has changed a file, how much, and how recently — from `git log`, not a guess. */
export function whoKnows(db: Db, runId: number, options: { path: string }): WhoKnowsResult {
  const path = options.path.trim().replace(/^\.\//, '');
  const rows = db
    .prepare(
      /* sql */ `
      SELECT c.sha AS sha, COALESCE(c.author_name, c.author_email, 'unknown') AS author,
             c.authored_at AS date, c.subject AS subject
        FROM commit_file cf
        JOIN git_commit c ON c.id = cf.commit_id
       WHERE cf.run_id = ? AND cf.canonical_path = ? AND c.is_merge = 0
       ORDER BY c.authored_at DESC`,
    )
    .all(runId, path) as Array<{ sha: string; author: string; date: string; subject: string | null }>;
  if (rows.length === 0) return { found: false, path, commits: 0, authors: [], recent: [] };

  const byAuthor = new Map<string, { commits: number; last: string }>();
  for (const row of rows) {
    const entry = byAuthor.get(row.author) ?? { commits: 0, last: row.date };
    entry.commits += 1;
    if (row.date > entry.last) entry.last = row.date;
    byAuthor.set(row.author, entry);
  }
  const authors = [...byAuthor.entries()]
    .map(([author, entry]) => ({
      author,
      commits: entry.commits,
      share: entry.commits / rows.length,
      last: entry.last,
    }))
    .sort((a, b) => b.commits - a.commits || b.last.localeCompare(a.last));
  return { found: true, path, commits: rows.length, authors, recent: rows.slice(0, 5) };
}

// ------------------------------------------------------ where is it written

export interface TableAccess {
  by: string;
  kind: string;
  via: string | null;
  file: string | null;
  line: number | null;
}

export interface TableWritesResult {
  found: boolean;
  table: string | null;
  writers: TableAccess[];
  readers: TableAccess[];
  /** Classes mapped to the table — writes through the ORM start from these. */
  mappedBy: TableAccess[];
}

/**
 * Code that writes a table: repositories of its entity, `@Query` and JDBC
 * statements that name it (ADR-0036) — and, for context, what reads it and
 * which classes are mapped to it.
 */
export function whereIsTableWritten(db: Db, runId: number, options: { table: string }): TableWritesResult {
  const table = db
    .prepare(`SELECT id, fqn FROM node WHERE run_id = ? AND kind = 'table' AND fqn = ?`)
    .get(runId, options.table.trim().toLowerCase()) as { id: number; fqn: string } | undefined;
  if (table === undefined) return { found: false, table: null, writers: [], readers: [], mappedBy: [] };
  const access = (kind: string) =>
    (
      db
        .prepare(
          /* sql */ `
          SELECT s.fqn AS by, s.kind AS kind, e.attrs AS attrs, f.path AS file, e.line AS line
            FROM edge e JOIN node s ON s.id = e.src_id LEFT JOIN source_file f ON f.id = e.file_id
           WHERE e.run_id = ? AND e.kind = ? AND e.dst_id = ?
           ORDER BY s.fqn, f.path, e.line`,
        )
        .all(runId, kind, table.id) as Array<{ by: string; kind: string; attrs: string | null; file: string | null; line: number | null }>
    ).map((row) => ({
      by: row.by,
      kind: row.kind,
      via: row.attrs === null ? null : ((JSON.parse(row.attrs) as { via?: string }).via ?? null),
      file: row.file,
      line: row.line,
    }));
  return {
    found: true,
    table: table.fqn,
    writers: access('writes_table'),
    readers: access('reads_table'),
    mappedBy: access('maps_to'),
  };
}

// ------------------------------------------------------- explain a hotspot

export interface HotspotExplanation {
  found: boolean;
  path: string;
  role: string | null;
  /** 1-based position in the ranking, or null when the file is not ranked. */
  rank: number | null;
  ranked: number;
  hotspot: Hotspot | null;
  /** Why an unranked file is unranked. */
  reason: string | null;
}

/** A file's place in the hotspot ranking and every number behind it (ADR-0031). */
export function explainHotspot(db: Db, runId: number, options: { path: string }): HotspotExplanation {
  const path = options.path.trim().replace(/^\.\//, '');
  const role =
    (db.prepare('SELECT role FROM file_role WHERE run_id = ? AND path = ?').get(runId, path) as { role: string } | undefined)
      ?.role ?? null;
  const all = topHotspots(db, runId, Number.MAX_SAFE_INTEGER);
  const index = all.findIndex((hotspot) => hotspot.path === path);
  if (index >= 0) {
    return { found: true, path, role, rank: index + 1, ranked: all.length, hotspot: all[index] as Hotspot, reason: null };
  }
  const metric = db
    .prepare('SELECT recent_commits AS recent, complexity FROM file_metric WHERE run_id = ? AND path = ?')
    .get(runId, path) as { recent: number; complexity: number | null } | undefined;
  const reason =
    role === null
      ? 'The file is not in this run’s inventory.'
      : role !== 'source'
        ? `Only source files are ranked, and this file’s role is ${role}.`
        : metric === undefined
          ? 'No history is stored for this file.'
          : metric.complexity === null
            ? 'The file has no complexity score (binary, too large or unreadable).'
            : 'The file has no commits in the hotspot window.';
  return { found: role !== null, path, role, rank: null, ranked: all.length, hotspot: null, reason };
}
