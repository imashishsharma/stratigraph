import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectClusters, loadClusters } from '../src/analysis/clusters.js';
import { detectIntentMismatches } from '../src/analysis/intent-mismatch.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import type { Fact } from '../src/facts/types.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import { InterpretError } from '../src/interpret/client.js';
import type { CompletionRequest, ModelClient } from '../src/interpret/client.js';

import { identifiersIn } from '../src/interpret/contract.js';
import { buildEvidencePack } from '../src/interpret/evidence.js';
import { ADR_RULE, READING_RULE, RESPONSIBILITY_RULE, runInterpretation } from '../src/interpret/run.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');
const MODEL = 'claude-opus-5';

let db: Db;
let runId: number;

beforeEach(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-interpret-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
});

afterEach(() => {
  if (db.open) db.close();
});

const META = { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' };

function seed(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

function path(pkg: string): string {
  return `src/${pkg.replaceAll('.', '/')}/A.java`;
}

function type(pkg: string): object[] {
  return [
    { v: 1, type: 'file', path: path(pkg), language: 'java' },
    { v: 1, type: 'node', kind: 'package', fqn: pkg, name: pkg },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: `${pkg}.A`,
      name: 'A',
      parent: { kind: 'package', fqn: pkg },
      file: path(pkg),
    },
  ];
}

function clique(packages: string[], start: number): object[] {
  const out: object[] = [];
  let line = start;
  for (let i = 0; i < packages.length; i += 1) {
    for (let j = i + 1; j < packages.length; j += 1) {
      out.push({
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: `${packages[i]}.A` },
        dst: { kind: 'class', fqn: `${packages[j]}.A` },
        file: path(packages[i] as string),
        line,
      });
      line += 1;
    }
  }
  return out;
}

const BILLING = ['shop.billing.invoice', 'shop.billing.payment', 'shop.billing.ledger'];
const ADMIN = ['shop.admin.user', 'shop.admin.role', 'shop.admin.audit'];

/** Two clusters, with a stray package named under billing and wired into admin. */
function seedGroups(withStray = true): void {
  seed([
    META,
    ...[...BILLING, ...ADMIN, ...(withStray ? ['shop.billing.report'] : [])].flatMap(type),
    ...clique(BILLING, 1),
    ...clique(ADMIN, 100),
    ...(withStray ? clique(['shop.billing.report', ...ADMIN], 200) : []),
  ]);
}

/** Records every request and replays scripted responses in order. */
function fakeClient(
  responses: Array<unknown | Error>,
  model = MODEL,
): ModelClient & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let at = 0;
  return {
    requests,
    async complete(request: CompletionRequest) {
      requests.push(request);
      const next = responses[Math.min(at, responses.length - 1)];
      at += 1;
      if (next instanceof Error) throw next;
      if (next !== null && typeof next === 'object' && 'refusal' in next) {
        return { output: null, model, refusal: (next as { refusal: string }).refusal };
      }
      return { output: next, model, refusal: null };
    },
  };
}

function analyse() {
  const clusters = detectClusters(db, runId, { couplingWeight: 1 }).clusters;
  const mismatches = detectIntentMismatches(db, runId, clusters);
  return { clusters, mismatches };
}

const OPTIONS = {
  minClusterSize: 2,
  maxClusters: 25,
  sendSource: false,
  repoPath: FIXTURE,
};

/** A response grounded in whatever ids the pack actually produced. */
function grounded(db_: Db, clusterIndex = 0): Record<string, unknown> {
  const { clusters, mismatches } = analyse();
  const cluster = clusters[clusterIndex] as (typeof clusters)[number];
  const pack = buildEvidencePack(db_, runId, cluster, mismatches[0] ?? null, {
    sendSource: false,
    repoPath: FIXTURE,
  });
  const first = pack.items[0]?.id as string;
  const second = pack.items[1]?.id ?? first;
  return {
    name: 'Order handling',
    responsibility: [{ text: 'Groups packages that reference each other.', cites: [first] }],
    mismatch: null,
    adrCandidates: [
      {
        title: 'These packages form one unit',
        decision: { text: 'They reference each other directly.', cites: [first] },
        evidence: { text: 'The edges connect them.', cites: [second] },
        question: 'Was this grouping intended?',
      },
    ],
  };
}

function findings(rule: string): Array<{ title: string; detail: string; model: string | null }> {
  return db
    .prepare(
      `SELECT title, detail, model FROM finding WHERE run_id = ? AND rule = ? ORDER BY id`,
    )
    .all(runId, rule) as Array<{ title: string; detail: string; model: string | null }>;
}

function diagnostics(): Array<{ message: string; level: string }> {
  return db
    .prepare(`SELECT message, level FROM diagnostic WHERE run_id = ? AND extractor = 'interpret'`)
    .all(runId) as Array<{ message: string; level: string }>;
}

describe('runInterpretation — the happy path', () => {
  it('names each cluster and records the model that answered', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0), grounded(db, 1)]);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    expect(result.described).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.declined).toBe(0);
    expect(result.models).toEqual([MODEL]);

    const named = loadClusters(db, runId);
    expect(named.every((cluster) => cluster.name === 'Order handling')).toBe(true);
    expect(named.every((cluster) => cluster.description !== null)).toBe(true);

    const authored = db
      .prepare('SELECT DISTINCT authored_by, model FROM cluster WHERE run_id = ?')
      .all(runId);
    expect(authored).toEqual([{ authored_by: 'model', model: MODEL }]);
  });

  it('writes a cited finding per description, because citations join to findings', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();

    await runInterpretation(db, runId, clusters, mismatches, fakeClient([grounded(db, 0)]), OPTIONS);

    const written = findings(RESPONSIBILITY_RULE);
    expect(written).toHaveLength(2);
    expect(written[0]?.model).toBe(MODEL);

    const cited = db
      .prepare(
        `SELECT COUNT(*) AS n FROM citation c
           JOIN finding f ON f.id = c.finding_id
          WHERE f.run_id = ? AND f.rule = ?`,
      )
      .get(runId, RESPONSIBILITY_RULE) as { n: number };
    expect(cited.n).toBeGreaterThan(0);
  });

  it('records ADR candidates with their question kept as a question', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();

    const result = await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([grounded(db, 0)]),
      OPTIONS,
    );

    expect(result.adrCandidates).toBe(2);
    const adrs = findings(ADR_RULE);
    expect(adrs[0]?.detail).toContain('Observed decision:');
    expect(adrs[0]?.detail).toContain('Question for the team: Was this grouping intended?');
  });

  it('marks everything it writes as model-authored', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    await runInterpretation(db, runId, clusters, mismatches, fakeClient([grounded(db, 0)]), OPTIONS);

    const authors = db
      .prepare(
        `SELECT rule, authored_by FROM finding WHERE run_id = ? GROUP BY rule, authored_by`,
      )
      .all(runId) as Array<{ rule: string; authored_by: string }>;

    for (const row of authors) {
      const expected = [RESPONSIBILITY_RULE, READING_RULE, ADR_RULE].includes(row.rule)
        ? 'model'
        : 'algorithm';
      expect(row.authored_by, row.rule).toBe(expected);
    }
  });
});

describe('runInterpretation — rejecting model output', () => {
  it('retries once with the violations, then accepts the corrected answer', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const bad = { ...grounded(db, 0), name: 'com.example.invented.Thing' };
    const client = fakeClient([bad, grounded(db, 0)]);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    expect(result.described).toBeGreaterThan(0);
    // The retry carries the specific violation back.
    expect(client.requests[1]?.prompt).toContain('Your previous answer was rejected');
    expect(client.requests[1]?.prompt).toContain('com.example.invented.Thing');
  });

  it('gives up after one retry and writes nothing', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const bad = {
      ...grounded(db, 0),
      responsibility: [
        { text: 'com.example.invented.Thing does the work.', cites: ['e404'] },
      ],
    };

    const result = await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([bad]),
      OPTIONS,
    );

    expect(result.rejected).toBe(2);
    expect(result.described).toBe(0);
    // Rejected output is never stored, not even partially.
    expect(loadClusters(db, runId).every((cluster) => cluster.name === null)).toBe(true);
    expect(findings(RESPONSIBILITY_RULE)).toEqual([]);
  });

  it('leaves a diagnostic, so an undescribed cluster differs from an untried one', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const bad = { ...grounded(db, 0), responsibility: [{ text: 'It does things.', cites: [] }] };

    await runInterpretation(db, runId, clusters, mismatches, fakeClient([bad]), OPTIONS);

    const recorded = diagnostics();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.message).toContain('failed the citation check twice');
    expect(recorded[0]?.message).toContain('cites nothing');
  });

  it('rejects a fabricated class even when the citation is real', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const real = grounded(db, 0);
    const bad = {
      ...real,
      responsibility: [
        {
          text: 'shop.billing.TaxCalculator computes VAT.',
          cites: (real['responsibility'] as Array<{ cites: string[] }>)[0]?.cites ?? [],
        },
      ],
    };

    const result = await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([bad]),
      OPTIONS,
    );

    expect(result.described).toBe(0);
    expect(diagnostics()[0]?.message).toContain('shop.billing.TaxCalculator');
  });
});

describe('runInterpretation — declining and failing', () => {
  it('records a refusal and describes nothing', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();

    const result = await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([{ refusal: 'the model declined the request' }]),
      OPTIONS,
    );

    expect(result.declined).toBe(2);
    expect(result.described).toBe(0);
    expect(diagnostics()[0]?.message).toContain('declined');
  });

  it('lets one failed call cost that cluster, not the whole report', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([new Error('connection reset'), grounded(db, 1)]);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    expect(result.declined).toBe(1);
    expect(result.described).toBe(1);
    expect(diagnostics()[0]?.message).toContain('connection reset');
  });
});

describe('runInterpretation — a misconfigured run', () => {
  /** Throws the way the SDK does for a billing or auth failure. */
  function failing(status: number, message: string): ModelClient & { calls: number } {
    const client = {
      calls: 0,
      async complete() {
        client.calls += 1;
        throw new InterpretError(`${status} ${message}`, {
          fatal: status === 400 || status === 401 || status === 403,
        });
      },
    };
    return client;
  }

  it.each([
    [400, 'Your credit balance is too low to access the Anthropic API'],
    [401, 'invalid x-api-key'],
    [403, 'permission denied'],
  ])('stops after the first %i rather than repeating it per cluster', async (status, message) => {
    // Found by running it: an empty balance made one doomed call per cluster
    // and buried the cause in N identical diagnostics, while the report said
    // "got no usable answer" — which reads like the model declining.
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    expect(clusters.length).toBeGreaterThan(1);
    const client = failing(status, message);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    expect(client.calls).toBe(1);
    expect(result.fatalError).toContain(message);
    expect(result.declined).toBe(0);
    expect(diagnostics()).toHaveLength(1);
    expect(diagnostics()[0]?.message).toContain('interpretation stopped');
  });

  it.each([
    [429, 'rate limited'],
    [500, 'internal server error'],
  ])('keeps going after a %i, which a later cluster may survive', async (status, message) => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = failing(status, message);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    // One call per cluster: the single retry is for citation violations, not
    // for a thrown error, which nothing about re-asking would fix.
    expect(client.calls).toBe(clusters.length);
    expect(result.fatalError).toBeNull();
    expect(result.declined).toBe(clusters.length);
  });
});

describe('runInterpretation — scope and idempotence', () => {
  it('skips clusters below minClusterSize', async () => {
    seedGroups(false);
    seed([META, ...type('lonely.one')]);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, {
      ...OPTIONS,
      minClusterSize: 3,
    });

    expect(result.considered).toBe(2);
    expect(client.requests).toHaveLength(2);
  });

  it('caps the number of clusters sent', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    const result = await runInterpretation(db, runId, clusters, mismatches, client, {
      ...OPTIONS,
      maxClusters: 1,
    });

    expect(result.considered).toBe(2);
    expect(result.attempted).toBe(1);
    expect(client.requests).toHaveLength(1);
  });

  it('replaces a previous interpretation rather than appending to it', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();

    await runInterpretation(db, runId, clusters, mismatches, fakeClient([grounded(db, 0)]), OPTIONS);
    await runInterpretation(db, runId, clusters, mismatches, fakeClient([grounded(db, 0)]), OPTIONS);

    expect(findings(RESPONSIBILITY_RULE)).toHaveLength(2);
    expect(findings(ADR_RULE)).toHaveLength(2);
  });

  it('resets a cluster to algorithm-authored when a later run cannot describe it', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();

    await runInterpretation(db, runId, clusters, mismatches, fakeClient([grounded(db, 0)]), OPTIONS);
    expect(loadClusters(db, runId)[0]?.name).not.toBeNull();

    await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([{ refusal: 'declined' }]),
      OPTIONS,
    );

    // A stale name from the previous run would be the worst outcome: prose
    // nobody can trace to this run's evidence.
    expect(loadClusters(db, runId)[0]?.name).toBeNull();
    const authored = db
      .prepare('SELECT DISTINCT authored_by FROM cluster WHERE run_id = ?')
      .all(runId);
    expect(authored).toEqual([{ authored_by: 'algorithm' }]);
  });
});

describe('runInterpretation — the mismatch reading', () => {
  it('writes the model reading as a finding separate from the algorithmic one', async () => {
    seedGroups(true);
    const { clusters, mismatches } = analyse();
    expect(mismatches).toHaveLength(1);

    const stray = clusters.find((cluster) =>
      cluster.members.some((member) => member.fqn === 'shop.billing.report'),
    );
    const pack = buildEvidencePack(db, runId, stray as (typeof clusters)[number], mismatches[0] ?? null, {
      sendSource: false,
      repoPath: FIXTURE,
    });
    const id = pack.items[0]?.id as string;

    const response = {
      name: 'Administration',
      responsibility: [{ text: 'Handles administrative concerns.', cites: [id] }],
      mismatch: { text: 'It reads administrative data directly.', cites: [id] },
      adrCandidates: [],
    };

    await runInterpretation(db, runId, clusters, mismatches, fakeClient([response]), OPTIONS);

    const reading = findings(READING_RULE);
    expect(reading).toHaveLength(1);
    expect(reading[0]?.title).toContain('shop.billing.report');
    expect(reading[0]?.detail).toContain('reads administrative data');

    // The algorithmic finding is untouched and still algorithm-authored.
    const algorithmic = db
      .prepare(
        `SELECT authored_by, model FROM finding WHERE run_id = ? AND rule = 'intent-mismatch'`,
      )
      .all(runId);
    expect(algorithmic).toEqual([{ authored_by: 'algorithm', model: null }]);
  });

  it('tells the model to answer null when the cluster carries no mismatch', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);

    expect(client.requests[0]?.prompt).toContain('No intent mismatch was found');
  });
});

describe('the vocabulary and the check use one tokeniser', () => {
  it('accepts every identifier the pack rendered, whatever its shape', () => {
    // The vocabulary and rule 3 were built from two copies of the same regex
    // list. Two copies is two ways to disagree, and either direction is a
    // defect: a hole, or a rejection of a name the pack really did contain.
    seedGroups(true);
    const { clusters, mismatches } = analyse();

    for (const cluster of clusters) {
      const mismatch =
        mismatches.find((m) => cluster.members.some((x) => x.fqn === m.fqn)) ?? null;
      const pack = buildEvidencePack(db, runId, cluster, mismatch, {
        sendSource: false,
        repoPath: FIXTURE,
      });

      for (const item of pack.items) {
        for (const token of identifiersIn(item.text)) {
          expect(pack.vocabulary.has(token), `${token} from ${item.id}`).toBe(true);
        }
      }
    }
  });
});

describe('the prompt', () => {
  it('sends evidence ids and never database ids', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);
    const prompt = client.requests[0]?.prompt as string;

    expect(prompt).toMatch(/\n {2}n1 {2}package /);
    expect(prompt).toContain('shop.');
    // The system prompt states the rules the validator enforces.
    expect(client.requests[0]?.system).toContain('Never name a class, package, file or commit');
  });

  it('drops a mismatch reading the algorithm did not ask for', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    expect(mismatches).toEqual([]);
    const response = { ...grounded(db, 0) };
    const cites = (response['responsibility'] as Array<{ cites: string[] }>)[0]?.cites ?? [];
    response['mismatch'] = { text: 'Something drifted here.', cites };

    const result = await runInterpretation(
      db,
      runId,
      clusters,
      mismatches,
      fakeClient([response]),
      OPTIONS,
    );

    // Grounded, so not rejected — but there is no algorithmic claim for it to
    // hang off, and the model does not get to decide one exists (ADR-0014).
    expect(result.described).toBe(2);
    expect(findings(READING_RULE)).toEqual([]);
  });

  it('sends source bodies only when asked', async () => {
    // Paths that really exist under `repoPath`, so there is something to read.
    const real = [
      'src/main/java/com/example/tiny/web/GreetingController.java',
      'src/main/java/com/example/tiny/domain/Greeting.java',
    ];
    seed([
      META,
      ...real.flatMap((file, index) => {
        const pkg = `com.example.tiny.p${index}`;
        return [
          { v: 1, type: 'file', path: file, language: 'java' },
          { v: 1, type: 'node', kind: 'package', fqn: pkg, name: pkg },
          {
            v: 1,
            type: 'node',
            kind: 'class',
            fqn: `${pkg}.A`,
            name: 'A',
            parent: { kind: 'package', fqn: pkg },
            file,
          },
        ];
      }),
      {
        v: 1,
        type: 'edge',
        kind: 'imports',
        src: { kind: 'class', fqn: 'com.example.tiny.p0.A' },
        dst: { kind: 'class', fqn: 'com.example.tiny.p1.A' },
        file: real[0],
        line: 1,
      },
    ]);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    await runInterpretation(db, runId, clusters, mismatches, client, {
      ...OPTIONS,
      sendSource: true,
      repoPath: FIXTURE,
    });

    const prompt = client.requests[0]?.prompt as string;
    expect(prompt).toContain('Source excerpts (--send-source)');
    expect(prompt).toContain('class GreetingController');
  });

  it('skips a file it cannot read rather than guessing at it', async () => {
    seedGroups(false); // synthetic paths that exist nowhere on disk
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    await runInterpretation(db, runId, clusters, mismatches, client, {
      ...OPTIONS,
      sendSource: true,
      repoPath: FIXTURE,
    });

    expect(client.requests[0]?.prompt).not.toContain('Source excerpts');
  });

  it('sends no source bodies unless asked', async () => {
    seedGroups(false);
    const { clusters, mismatches } = analyse();
    const client = fakeClient([grounded(db, 0)]);

    await runInterpretation(db, runId, clusters, mismatches, client, OPTIONS);
    expect(client.requests[0]?.prompt).not.toContain('--send-source');
  });
});


