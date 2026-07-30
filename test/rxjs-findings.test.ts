import { beforeEach, describe, expect, it } from 'vitest';

import { recordRxjsFindings, RXJS_RULE } from '../src/analysis/rxjs-findings.js';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';

/**
 * The leak rule, and everything it declines to accuse.
 *
 * ADR-0008's shape: the subscribe site is a fact, "nothing can unsubscribe from
 * this" is a judgement. The judgement is conservative on purpose, so most of
 * what is asserted below is silence.
 */

let db: Db;
const RUN = 1;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO run (id, repo_path, tool_version, started_at, status)
     VALUES (?, '/repo', '0', '2026-07-31T00:00:00Z', 'ok')`,
  ).run(RUN);
});

interface Site {
  line: number;
  guarded: boolean;
  retained: boolean;
}

/** A component class with one member that subscribes. */
function component(options: {
  name: string;
  sites: Site[];
  hasDestroyHook?: boolean;
  attrs?: Record<string, unknown>;
}): Fact[] {
  const file = `src/app/${options.name}.ts`;
  const classFqn = `src/app/${options.name}:${options.name}`;
  const facts: Fact[] = [
    { v: 1, type: 'file', path: file, language: 'typescript' },
    { v: 1, type: 'node', kind: 'package', fqn: 'src/app', name: 'app' },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: classFqn,
      name: options.name,
      parent: { kind: 'package', fqn: 'src/app' },
      file,
      ...(options.attrs ? { attrs: options.attrs } : {}),
    },
    {
      v: 1,
      type: 'node',
      kind: 'method',
      fqn: `${classFqn}#ngOnInit()`,
      name: 'ngOnInit',
      parent: { kind: 'class', fqn: classFqn },
      file,
      attrs: { rxjsSubscribes: options.sites },
    },
  ];
  if (options.hasDestroyHook === true) {
    facts.push({
      v: 1,
      type: 'node',
      kind: 'method',
      fqn: `${classFqn}#ngOnDestroy()`,
      name: 'ngOnDestroy',
      parent: { kind: 'class', fqn: classFqn },
      file,
    });
  }
  return facts;
}

function write(facts: Fact[]): void {
  const writer = new SqliteFactWriter(db, RUN);
  for (const fact of facts) writer.write(fact);
  writer.close();
}

function findings(): Array<{ title: string; severity: string; authored_by: string }> {
  return db
    .prepare(`SELECT title, severity, authored_by FROM finding WHERE run_id = ? AND rule = ?`)
    .all(RUN, RXJS_RULE) as Array<{ title: string; severity: string; authored_by: string }>;
}

describe('recordRxjsFindings', () => {
  it('reports a subscription with no operator, no handle and no hook', () => {
    write(
      component({
        name: 'OrderList',
        sites: [{ line: 21, guarded: false, retained: false }],
      }),
    );

    const result = recordRxjsFindings(db, RUN);
    expect(result).toMatchObject({ leaks: 1, sites: 1 });

    const [finding] = findings();
    expect(finding?.title).toContain('subscribes without a way to unsubscribe');
    // Algorithm-authored, so `authored_by` alone says no model was involved.
    expect(finding?.authored_by).toBe('algorithm');
    expect(finding?.severity).toBe('medium');
  });

  it('cites the member and the exact line', () => {
    // A finding with no citation is not publishable. This one has to point at
    // something a reader can open.
    write(
      component({ name: 'OrderList', sites: [{ line: 21, guarded: false, retained: false }] }),
    );
    recordRxjsFindings(db, RUN);

    const citation = db
      .prepare(
        `SELECT c.kind, c.line, n.fqn
           FROM citation c JOIN node n ON n.id = c.node_id
           JOIN finding f ON f.id = c.finding_id
          WHERE f.rule = ?`,
      )
      .get(RXJS_RULE) as { kind: string; line: number; fqn: string } | undefined;

    expect(citation).toEqual({
      kind: 'node',
      line: 21,
      fqn: 'src/app/OrderList:OrderList#ngOnInit()',
    });
  });

  it('says nothing when the chain bounds its own lifetime', () => {
    // `takeUntil(this.destroy$)` — the code has said how this ends.
    write(component({ name: 'Guarded', sites: [{ line: 9, guarded: true, retained: false }] }));
    const result = recordRxjsFindings(db, RUN);
    expect(result).toMatchObject({ leaks: 0, sites: 1 });
  });

  it('says nothing when the Subscription is kept', () => {
    write(component({ name: 'Kept', sites: [{ line: 9, guarded: false, retained: true }] }));
    expect(recordRxjsFindings(db, RUN).leaks).toBe(0);
  });

  it('says nothing when the class has an ngOnDestroy', () => {
    // There is somewhere for an unsubscribe to live. Whether it does is not
    // something this can see, and accusing anyway would be a guess.
    write(
      component({
        name: 'Destroyable',
        sites: [{ line: 9, guarded: false, retained: false }],
        hasDestroyHook: true,
      }),
    );
    expect(recordRxjsFindings(db, RUN).leaks).toBe(0);
  });

  it('says nothing about a subscribe outside any class', () => {
    // A module-level function has no component lifecycle to outlive, and no
    // ngOnDestroy that could ever exist.
    write([
      { v: 1, type: 'file', path: 'src/app/setup.ts', language: 'typescript' },
      { v: 1, type: 'node', kind: 'package', fqn: 'src/app', name: 'app' },
      {
        v: 1,
        type: 'node',
        kind: 'method',
        fqn: 'src/app/setup#bootstrap()',
        name: 'bootstrap',
        parent: { kind: 'package', fqn: 'src/app' },
        file: 'src/app/setup.ts',
        attrs: { rxjsSubscribes: [{ line: 4, guarded: false, retained: false }] },
      },
    ]);
    expect(recordRxjsFindings(db, RUN).leaks).toBe(0);
  });

  it('treats a site with no verdict recorded as guarded, not as a leak', () => {
    // Facts from an older extractor carried only a line. Unknown must not
    // become an accusation.
    write([
      { v: 1, type: 'file', path: 'src/app/Old.ts', language: 'typescript' },
      { v: 1, type: 'node', kind: 'package', fqn: 'src/app', name: 'app' },
      {
        v: 1,
        type: 'node',
        kind: 'class',
        fqn: 'src/app/Old:Old',
        name: 'Old',
        parent: { kind: 'package', fqn: 'src/app' },
        file: 'src/app/Old.ts',
      },
      {
        v: 1,
        type: 'node',
        kind: 'method',
        fqn: 'src/app/Old:Old#ngOnInit()',
        name: 'ngOnInit',
        parent: { kind: 'class', fqn: 'src/app/Old:Old' },
        file: 'src/app/Old.ts',
        attrs: { rxjsSubscribes: [{ line: 4 }] },
      },
    ]);
    expect(recordRxjsFindings(db, RUN).leaks).toBe(0);
  });

  it('reports every leaking site in one member separately', () => {
    write(
      component({
        name: 'Two',
        sites: [
          { line: 10, guarded: false, retained: false },
          { line: 14, guarded: true, retained: false },
          { line: 18, guarded: false, retained: false },
        ],
      }),
    );

    const result = recordRxjsFindings(db, RUN);
    expect(result).toMatchObject({ leaks: 2, sites: 3 });
    expect(result.reported.map((leak) => leak.line)).toEqual([10, 18]);
  });

  it('replaces findings from a previous analysis rather than doubling them', () => {
    write(component({ name: 'OrderList', sites: [{ line: 21, guarded: false, retained: false }] }));
    recordRxjsFindings(db, RUN);
    recordRxjsFindings(db, RUN);
    expect(findings()).toHaveLength(1);
  });
});
