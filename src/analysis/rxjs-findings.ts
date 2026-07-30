import type { Db } from '../db/database.js';

/**
 * Subscriptions that nothing can tear down.
 *
 * ADR-0008's rule, applied to a third case: the *fact* is that a member named
 * `subscribe` was called at a line, and the TypeScript extractor recorded that
 * along with two other pieces of syntax it could see — whether the chain bounds
 * its own lifetime, and whether the returned `Subscription` was kept. The
 * *judgement* that the result leaks is arithmetic over those, and it belongs
 * here, in `finding`, with `authored_by = 'algorithm'` and a citation to the
 * member the call sits in.
 *
 * Conservative by construction. All three conditions must hold — no lifetime
 * operator, no retained handle, and no `ngOnDestroy` on the class — so a
 * subscription that is torn down in a way this cannot see produces silence
 * rather than a false accusation. A missed leak costs a reader nothing; an
 * invented one costs them the report's credibility.
 */

export const RXJS_RULE = 'unbounded-subscription';

interface SubscribeSite {
  line: number;
  guarded: boolean;
  retained: boolean;
}

/** One reported leak, carried on the result so the report needs no second query. */
export interface RxjsLeak {
  title: string;
  detail: string;
  file: string | null;
  line: number;
}

export interface RxjsFindings {
  /** Findings written. */
  leaks: number;
  /** The leaks themselves, in the order they were written. */
  reported: RxjsLeak[];
  /** Call sites seen, whatever the verdict. Denominator for the ratio. */
  sites: number;
}

export function recordRxjsFindings(db: Db, runId: number): RxjsFindings {
  db.prepare(`DELETE FROM finding WHERE run_id = ? AND rule = ?`).run(runId, RXJS_RULE);

  const members = db
    .prepare(
      /* sql */ `
      SELECT n.id, n.fqn, n.name, n.parent_id, n.attrs, f.path
        FROM node n
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = @runId AND n.attrs LIKE '%"rxjsSubscribes"%'
       ORDER BY n.id`,
    )
    .all({ runId }) as Array<{
    id: number;
    fqn: string;
    name: string;
    parent_id: number | null;
    attrs: string;
    path: string | null;
  }>;

  const insertFinding = db.prepare(
    `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
     VALUES (@runId, @rule, @title, @detail, 'medium', 'algorithm')`,
  );
  const insertCitation = db.prepare(
    `INSERT INTO citation (finding_id, kind, node_id, line) VALUES (?, 'node', ?, ?)`,
  );
  // A class "has a teardown hook" if it declares `ngOnDestroy` — the only hook
  // Angular calls on the way out, so its absence means there is nowhere for an
  // unsubscribe to live.
  const hasDestroyHook = db.prepare(
    `SELECT 1 FROM node
      WHERE run_id = ? AND parent_id = ? AND kind = 'method' AND name = 'ngOnDestroy'
      LIMIT 1`,
  );

  const result: RxjsFindings = { leaks: 0, reported: [], sites: 0 };

  const write = db.transaction((): void => {
    for (const member of members) {
      const sites = parseSites(member.attrs);
      result.sites += sites.length;
      if (sites.length === 0) continue;

      // The owner must be a **class**. A module-level function's parent is its
      // directory (ADR-0017), and a subscribe there has no component lifecycle
      // to outlive and no `ngOnDestroy` that could ever exist. Checking only
      // for a parent, rather than for a class parent, reports every bootstrap
      // function in the repository as a leak.
      const owner =
        member.parent_id === null
          ? undefined
          : (db
              .prepare(`SELECT id, fqn, name, kind FROM node WHERE id = ?`)
              .get(member.parent_id) as
              | { id: number; fqn: string; name: string; kind: string }
              | undefined);
      if (owner === undefined || owner.kind !== 'class') continue;

      const destroyable = hasDestroyHook.get(runId, owner.id) !== undefined;
      if (destroyable) continue;

      for (const site of sites) {
        if (site.guarded || site.retained) continue;

        const leak: RxjsLeak = {
          title: `${owner.name}.${member.name} subscribes without a way to unsubscribe`,
          detail:
            `${member.fqn} calls subscribe at ${member.path ?? 'an unknown file'}:${site.line}. ` +
            `The chain applies no lifetime operator (takeUntil, takeUntilDestroyed, take, ` +
            `first), the returned Subscription is not kept, and ${owner.fqn} declares no ` +
            `ngOnDestroy — so nothing in this class can end the subscription. If the source ` +
            `outlives the component, the component is retained with it.`,
          file: member.path,
          line: site.line,
        };
        const findingId = insertFinding.run({
          runId,
          rule: RXJS_RULE,
          title: leak.title,
          detail: leak.detail,
        }).lastInsertRowid;
        insertCitation.run(findingId, member.id, site.line);
        result.leaks += 1;
        result.reported.push(leak);
      }
    }
  });
  write();

  return result;
}

function parseSites(attrs: string): SubscribeSite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(attrs);
  } catch {
    return [];
  }
  const sites = (parsed as Record<string, unknown>)['rxjsSubscribes'];
  if (!Array.isArray(sites)) return [];

  return sites.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { line, guarded, retained } = entry as Record<string, unknown>;
    if (typeof line !== 'number') return [];
    return [
      {
        line,
        // An older run's facts carried only a line number. Absent means unknown,
        // and unknown must not become an accusation — so it reads as guarded.
        guarded: guarded !== false,
        retained: retained !== false,
      },
    ];
  });
}

/** One line for `analyze`, or null when this run has no subscriptions at all. */
export function summariseRxjs(result: RxjsFindings): string | null {
  if (result.sites === 0) return null;
  return (
    `${result.sites} subscribe site(s), ${result.leaks} with no way to unsubscribe`
  );
}
