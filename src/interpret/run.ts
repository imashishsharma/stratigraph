/**
 * Layer 4's model half: name each cluster, describe what it appears to be for,
 * read the intent mismatches, and propose ADR candidates.
 *
 * The shape is fixed by ADR-0013. An algorithm assembles the evidence and
 * assigns it opaque ids; the model writes prose about it; a validator in code
 * checks every sentence back against the pack; output that fails is retried
 * once and then discarded. Nothing rejected is ever written, and a cluster
 * nobody could describe reads differently from a cluster nobody tried to.
 */

import type { ClusterSummary } from '../analysis/clusters.js';
import type { IntentMismatch } from '../analysis/intent-mismatch.js';
import type { Db } from '../db/database.js';
import { info, warn } from '../log.js';
import type { ModelClient } from './client.js';
import {
  describeViolations,
  RESPONSE_SCHEMA,
  validate,
  type Claim,
  type Interpretation,
  type Violation,
} from './contract.js';
import { buildEvidencePack, type EvidenceItem, type EvidencePack } from './evidence.js';

export const RESPONSIBILITY_RULE = 'cluster-responsibility';
export const READING_RULE = 'intent-reading';
export const ADR_RULE = 'adr-candidate';

const MODEL_RULES = [RESPONSIBILITY_RULE, READING_RULE, ADR_RULE];

export interface InterpretOptions {
  /** Clusters smaller than this are not described. */
  minClusterSize: number;
  /** Cap on clusters sent to the model, so a large repository cannot run away. */
  maxClusters: number;
  sendSource: boolean;
  repoPath: string;
}

export interface InterpretResult {
  /** Clusters large enough to be worth describing. */
  considered: number;
  /** Clusters actually sent, after `maxClusters`. */
  attempted: number;
  described: number;
  /** Sent, but the response failed the citation check twice. */
  rejected: number;
  /** Sent, but the model declined or returned nothing usable. */
  declined: number;
  adrCandidates: number;
  /** Model ids that actually answered. Usually one. */
  models: string[];
}

const SYSTEM_PROMPT = `You are reading the output of a static analysis tool that has already
established the facts. Your job is to describe, not to discover.

You will be given a cluster of packages that a graph algorithm grouped together, and a
numbered list of evidence: packages, dependency edges with file and line, files with their
change history, and commits. Every item has an id like "n1", "e3", "f2" or "c1".

Rules, all of which are checked in code after you answer:

1. Cite by evidence id. Every claim carries the ids of the evidence that supports it.
   An id that is not in the list will be rejected.
2. Never name a class, package, file or commit that does not appear in the evidence. If
   you cannot support a description without naming something you were not shown, say
   less instead. "No evidence found" is a correct answer; a plausible guess is not.
3. A name is a short label — two or three words of plain English. Do not put a
   fully-qualified type name in it.
4. ADR candidates are decisions the code appears to embody that were probably never
   written down. Propose one only when the evidence shows it. An empty list is a normal
   and frequent answer.
5. The question on an ADR candidate is for the team to answer. Ask; do not assert.

Write for someone who has to maintain this code and has never seen it before.`;

/**
 * Describe a run's clusters, replacing anything a previous interpretation wrote.
 *
 * Errors from a single cluster do not abort the rest: one unreachable API call
 * should cost that cluster's description, not the whole report.
 */
export async function runInterpretation(
  db: Db,
  runId: number,
  clusters: readonly ClusterSummary[],
  mismatches: readonly IntentMismatch[],
  client: ModelClient,
  options: InterpretOptions,
): Promise<InterpretResult> {
  const mismatchOf = new Map<number, IntentMismatch>();
  for (const mismatch of mismatches) {
    const owner = clusters.find((cluster) =>
      cluster.members.some((member) => member.fqn === mismatch.fqn),
    );
    if (owner !== undefined) mismatchOf.set(owner.clusterId, mismatch);
  }

  const worthDescribing = clusters
    .filter((cluster) => cluster.members.length >= options.minClusterSize)
    .sort((a, b) => b.members.length - a.members.length || a.prefix.localeCompare(b.prefix));
  const attempted = worthDescribing.slice(0, options.maxClusters);

  clearPreviousInterpretation(db, runId);

  if (options.sendSource) {
    warn(
      'sending raw source bodies to the model API (--send-source). ' +
        'Structural metadata alone is the default; this sends code.',
    );
  }

  const result: InterpretResult = {
    considered: worthDescribing.length,
    attempted: attempted.length,
    described: 0,
    rejected: 0,
    declined: 0,
    adrCandidates: 0,
    models: [],
  };

  for (const cluster of attempted) {
    const pack = buildEvidencePack(
      db,
      runId,
      cluster,
      mismatchOf.get(cluster.clusterId) ?? null,
      { sendSource: options.sendSource, repoPath: options.repoPath },
    );

    const outcome = await describe(client, pack);
    if (outcome.model !== null && !result.models.includes(outcome.model)) {
      result.models.push(outcome.model);
    }

    if (outcome.kind === 'declined') {
      result.declined += 1;
      recordDiagnostic(db, runId, `cluster ${cluster.prefix}: ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === 'rejected') {
      result.rejected += 1;
      recordDiagnostic(
        db,
        runId,
        `cluster ${cluster.prefix}: model output failed the citation check twice and was ` +
          `discarded.\n${describeViolations(outcome.violations)}`,
      );
      continue;
    }

    write(db, runId, cluster, pack, outcome.value, outcome.model);
    result.described += 1;
    result.adrCandidates += outcome.value.adrCandidates.length;
  }

  info(
    `run ${runId}: described ${result.described} of ${result.attempted} clusters, ` +
      `${result.rejected} rejected, ${result.declined} declined`,
  );
  return result;
}

type Outcome =
  | { kind: 'described'; value: Interpretation; model: string }
  | { kind: 'rejected'; violations: Violation[]; model: string | null }
  | { kind: 'declined'; reason: string; model: string | null };

/**
 * Ask, check, and ask once more with the violations attached.
 *
 * Once, because the first retry corrects the ordinary case — a mis-typed id, a
 * sentence that drifted past the evidence — while further attempts on the same
 * input mostly resample the same failure at proportional cost (ADR-0013).
 */
async function describe(client: ModelClient, pack: EvidencePack): Promise<Outcome> {
  let violations: Violation[] = [];
  let model: string | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? renderPack(pack)
        : `${renderPack(pack)}

Your previous answer was rejected. Fix these and answer again:

${describeViolations(violations)}`;

    let completion;
    try {
      completion = await client.complete({
        system: SYSTEM_PROMPT,
        prompt,
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      });
    } catch (error) {
      return { kind: 'declined', reason: (error as Error).message, model };
    }

    model = completion.model;
    if (completion.output === null) {
      return { kind: 'declined', reason: completion.refusal ?? 'no output', model };
    }

    const checked = validate(completion.output, pack);
    if (checked.ok) return { kind: 'described', value: checked.value, model };
    violations = checked.violations;
  }

  return { kind: 'rejected', violations, model };
}

/** The pack, rendered for the model. Ids first, so they are hard to misread. */
export function renderPack(pack: EvidencePack): string {
  const lines = [
    `Cluster: ${pack.prefix}`,
    `Packages (${pack.members.length}): ${pack.members.join(', ')}`,
    '',
    'Evidence:',
    ...pack.items.map((item) => `  ${item.id}  ${item.text}`),
  ];

  if (pack.mismatch !== null) {
    lines.push(
      '',
      'A separate check found that one package here is named elsewhere:',
      `  ${pack.mismatch.fqn} is named under ${pack.mismatch.parent}, alongside ` +
        `${pack.mismatch.nameGroup.join(', ')}, which sit in ${pack.mismatch.expectedPrefix}.`,
      '  Describe why it might sit here instead, citing the evidence above. If the',
      '  evidence does not show why, set mismatch to null.',
    );
  } else {
    lines.push('', 'No intent mismatch was found in this cluster. Set mismatch to null.');
  }

  if (pack.source.length > 0) {
    lines.push('', 'Source excerpts (--send-source):');
    for (const file of pack.source) {
      lines.push(`--- ${file.path}`, file.body);
    }
  }

  return lines.join('\n');
}

/** Model-authored rows from a previous run of this command. */
function clearPreviousInterpretation(db: Db, runId: number): void {
  db.transaction(() => {
    for (const rule of MODEL_RULES) {
      db.prepare('DELETE FROM finding WHERE run_id = ? AND rule = ?').run(runId, rule);
    }
    // Clustering itself is the algorithm's; only the model's columns are reset.
    db.prepare(
      `UPDATE cluster SET name = NULL, description = NULL,
              authored_by = 'algorithm', model = NULL
        WHERE run_id = ?`,
    ).run(runId);
  })();
}

/**
 * Write the accepted interpretation.
 *
 * A described cluster ends up with both a name on the `cluster` row and a
 * `cluster-responsibility` finding saying the same thing. The duplication is
 * forced rather than chosen: `citation` joins to `finding` only, so a described
 * cluster needs a finding to hang its evidence from (ADR-0013).
 */
function write(
  db: Db,
  runId: number,
  cluster: ClusterSummary,
  pack: EvidencePack,
  value: Interpretation,
  model: string,
): void {
  const refOf = new Map<string, EvidenceItem>(pack.items.map((item) => [item.id, item]));

  const insertFinding = db.prepare(
    `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by, model, cluster_id)
     VALUES (@runId, @rule, @title, @detail, @severity, 'model', @model, @clusterId)`,
  );

  const cite = (findingId: number, claims: readonly Claim[]): void => {
    const seen = new Set<string>();
    for (const claim of claims) {
      for (const id of claim.cites) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = refOf.get(id);
        if (item === undefined) continue; // unreachable: validate ran first
        db.prepare(
          `INSERT INTO citation (finding_id, kind, node_id, edge_id, file_id, line, commit_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          findingId,
          item.kind,
          item.ref.nodeId ?? null,
          item.ref.edgeId ?? null,
          item.ref.fileId ?? null,
          item.ref.line ?? null,
          item.ref.commitSha ?? null,
        );
      }
    }
  };

  db.transaction(() => {
    const description = value.responsibility.map((claim) => claim.text).join(' ');
    db.prepare(
      `UPDATE cluster SET name = ?, description = ?, authored_by = 'model', model = ?
        WHERE id = ?`,
    ).run(value.name, description, model, cluster.clusterId);

    const responsibilityId = Number(
      insertFinding.run({
        runId,
        rule: RESPONSIBILITY_RULE,
        title: `${value.name} — ${cluster.members.length} packages under ${cluster.prefix}`,
        detail: value.responsibility.map((claim) => `  ${claim.text}`).join('\n'),
        severity: 'info',
        model,
        clusterId: cluster.clusterId,
      }).lastInsertRowid,
    );
    cite(responsibilityId, value.responsibility);

    // Dropped, not rejected, when the model volunteers a reading for a cluster
    // the algorithm found no mismatch in. It is grounded — the validator
    // checked it — but there is no algorithmic claim for it to hang off, and
    // ADR-0014 is explicit that the model does not get to decide one exists.
    if (value.mismatch !== null && pack.mismatch !== null) {
      // A separate finding from the algorithmic `intent-mismatch`: appending
      // model prose to that row would give one row two authors (ADR-0013).
      const readingId = Number(
        insertFinding.run({
          runId,
          rule: READING_RULE,
          title: `Why ${pack.mismatch.fqn} may sit in ${value.name}`,
          detail: `  ${value.mismatch.text}`,
          severity: 'info',
          model,
          clusterId: cluster.clusterId,
        }).lastInsertRowid,
      );
      cite(readingId, [value.mismatch]);
    }

    for (const candidate of value.adrCandidates) {
      const adrId = Number(
        insertFinding.run({
          runId,
          rule: ADR_RULE,
          title: candidate.title,
          detail: [
            `  Observed decision: ${candidate.decision.text}`,
            `  Evidence: ${candidate.evidence.text}`,
            `  Question for the team: ${candidate.question}`,
          ].join('\n'),
          severity: 'info',
          model,
          clusterId: cluster.clusterId,
        }).lastInsertRowid,
      );
      cite(adrId, [candidate.decision, candidate.evidence]);
    }
  })();
}

/**
 * A cluster nobody could describe must not read like one nobody tried to
 * describe, so every give-up leaves a row behind.
 */
function recordDiagnostic(db: Db, runId: number, message: string): void {
  db.prepare(
    `INSERT INTO diagnostic (run_id, extractor, level, message) VALUES (?, 'interpret', 'warn', ?)`,
  ).run(runId, message);
}
