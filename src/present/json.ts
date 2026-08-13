/**
 * `--format json` — the machine-readable product of each command.
 *
 * A contract, not a dump of whatever the command happened to return. Internal
 * result types change whenever the analysis does; a shape something else parses
 * must not. So every document is built here, explicitly, and carries
 * `format: 1` — when a field has to change incompatibly, that number moves and
 * a consumer can say which shape it understands.
 *
 * Two rules follow the rest of the project into this layer. Nothing is derived
 * here — every value is read from a result the command already produced, so the
 * JSON and the terminal output of one run cannot disagree. And what the run
 * could *not* see travels with it: `coverage` and `gaps` are in the analyze
 * document for the same reason the report has a limits tab, because an empty
 * `findings` array is otherwise indistinguishable from a clean repository.
 */

import type { DiffFinding, DiffResult, NamedDelta } from '../analysis/diff.js';
import type { Check } from '../commands/doctor.js';
import type { InterpretResult } from '../interpret/run.js';
import type { FetchJarResult } from '../toolchain/jar-cache.js';
import type { PruneResult } from '../commands/prune.js';
import type { RunSummary } from '../mcp/queries.js';
import { TOOL_VERSION } from '../version.js';
import type { GateResult, RankedFindings } from './findings.js';

/** Bumped only for a change a parser could trip over. */
export const JSON_FORMAT_VERSION = 1;

export interface Envelope {
  stratigraph: string;
  format: number;
  command: string;
}

export function envelope(command: string): Envelope {
  return { stratigraph: TOOL_VERSION, format: JSON_FORMAT_VERSION, command };
}

/** The run a document describes, and what it could not answer. */
export function runDocument(summary: RunSummary): Record<string, unknown> {
  return {
    id: summary.runId,
    repo: summary.repoPath,
    commit: summary.repoHead,
    startedAt: summary.startedAt,
    toolVersion: summary.toolVersion,
    status: summary.status,
    extractors: summary.extractors,
    languages: summary.languages,
    counts: summary.counts,
    coverage: summary.coverage,
    gaps: summary.gaps,
  };
}

export function findingsDocument(ranked: RankedFindings): Record<string, unknown> {
  return {
    total: ranked.total,
    // Named `unpublishable` rather than `uncited` so a consumer reading only
    // this document knows it is a count of things withheld, not a subtotal.
    unpublishable: ranked.uncited,
    published: ranked.total - ranked.uncited,
    bySeverity: Object.fromEntries(ranked.bySeverity.map((row) => [row.severity, row.count])),
    byRule: Object.fromEntries(ranked.byRule.map((row) => [row.rule, row.count])),
    // `items` is capped by --top while every count above describes the whole
    // run, so the cap is stated rather than left to be discovered by a
    // consumer whose totals do not add up. Raise --top to get them all.
    shown: ranked.findings.length,
    truncated: ranked.findings.length < ranked.total - ranked.uncited,
    items: ranked.findings.map((finding) => ({
      id: finding.id,
      rule: finding.rule,
      ruleTitle: finding.ruleTitle,
      title: finding.title,
      detail: finding.detail,
      severity: finding.severity,
      // Kept explicit on every item: a consumer filtering findings must be able
      // to separate what a parser observed from what a model proposed without
      // consulting a second field elsewhere.
      authoredBy: finding.authoredBy,
      model: finding.model,
      evidence: finding.evidence.map((item) => ({
        kind: item.kind,
        label: item.label,
        path: item.path,
        line: item.line,
      })),
    })),
  };
}

export function gateDocument(gate: GateResult | null): Record<string, unknown> | null {
  if (gate === null) return null;
  return {
    threshold: gate.threshold,
    offending: gate.offending,
    bySeverity: Object.fromEntries(gate.bySeverity.map((row) => [row.severity, row.count])),
    failed: gate.failed,
  };
}

export function analyzeDocument(options: {
  run: RunSummary;
  packages: number;
  dependencies: number;
  ranked: RankedFindings;
  gate: GateResult | null;
  interpretation: InterpretResult | null;
  interpretationSkipped: string | null;
}): Record<string, unknown> {
  return {
    ...envelope('analyze'),
    run: runDocument(options.run),
    graph: { packages: options.packages, dependencies: options.dependencies },
    findings: findingsDocument(options.ranked),
    gate: gateDocument(options.gate),
    interpretation: interpretationDocument(
      options.interpretation,
      options.interpretationSkipped,
    ),
  };
}

/**
 * What the model layer did, including what it failed to do.
 *
 * `rejected` is here because ADR-0013 makes it load-bearing: descriptions
 * discarded by the citation check are the measurable part of the grounding
 * contract, and a consumer counting model output without them would report a
 * quiet run and a heavily-rejected one as the same thing.
 */
function interpretationDocument(
  result: InterpretResult | null,
  skipped: string | null,
): Record<string, unknown> {
  if (result === null) return { ran: false, skipped, models: [] };
  return {
    ran: true,
    skipped: null,
    models: result.models,
    considered: result.considered,
    attempted: result.attempted,
    described: result.described,
    rejectedByCitationCheck: result.rejected,
    declined: result.declined,
    adrCandidates: result.adrCandidates,
  };
}

export function reportDocument(options: {
  run: RunSummary;
  outDir: string;
  files: string[];
  ranked: RankedFindings;
  gate: GateResult | null;
}): Record<string, unknown> {
  return {
    ...envelope('report'),
    run: runDocument(options.run),
    outDir: options.outDir,
    files: options.files,
    findings: findingsDocument(options.ranked),
    gate: gateDocument(options.gate),
  };
}

export function doctorDocument(checks: Check[]): Record<string, unknown> {
  return {
    ...envelope('doctor'),
    // A preflight in a pipeline wants one boolean before it wants nine strings.
    ok: checks.every((check) => check.status === 'ok'),
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail,
    })),
  };
}

export function extractDocument(result: {
  runId: number;
  languages: string[];
  skipped: Array<{ language: string; reason: string }>;
  files: number;
  nodes: number;
  stubs: number;
  edges: number;
  diagnostics: number;
}): Record<string, unknown> {
  return {
    ...envelope('extract'),
    run: result.runId,
    languages: result.languages,
    // Not an error and not nothing: an extractor that could not run means an
    // absence in the graph, and a consumer treating this as empty would read
    // "no Java here" from "no JDK here".
    skipped: result.skipped,
    counts: {
      files: result.files,
      nodes: result.nodes,
      stubs: result.stubs,
      edges: result.edges,
      diagnostics: result.diagnostics,
    },
  };
}

export function historyDocument(result: {
  runId: number;
  reusedRun: boolean;
  commits: number;
  merges: number;
  fileChanges: number;
  outOfScope: number;
  renames: number;
  files: number;
  measured: number;
  skippedBinary: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  shallow: boolean;
}): Record<string, unknown> {
  return {
    ...envelope('history'),
    run: result.runId,
    // False means this command opened its own run rather than attaching to the
    // one `extract` made — which is what decides whether coupling can be
    // compared against the dependency graph at all.
    attachedToExistingRun: result.reusedRun,
    commits: result.commits,
    merges: result.merges,
    fileChanges: result.fileChanges,
    outOfScope: result.outOfScope,
    renames: result.renames,
    metrics: {
      files: result.files,
      measured: result.measured,
      skippedBinary: result.skippedBinary,
      skippedTooLarge: result.skippedTooLarge,
      skippedUnreadable: result.skippedUnreadable,
    },
    // A shallow clone understates churn, coupling and authorship alike, so it
    // rides along rather than staying a warning on a stream nobody parses.
    shallow: result.shallow,
  };
}

export function diffDocument(result: DiffResult, namesShown: number): Record<string, unknown> {
  const finding = (item: DiffFinding): Record<string, unknown> => ({
    rule: item.rule,
    title: item.title,
    severity: item.severity,
    authoredBy: item.authoredBy,
  });

  /** Named entities, capped — with the cap stated, as everywhere else. */
  const named = (delta: NamedDelta): Record<string, unknown> => ({
    from: delta.from,
    to: delta.to,
    addedCount: delta.added.length,
    removedCount: delta.removed.length,
    added: delta.added.slice(0, namesShown),
    removed: delta.removed.slice(0, namesShown),
    truncated: delta.added.length > namesShown || delta.removed.length > namesShown,
  });

  return {
    ...envelope('diff'),
    from: {
      run: result.from.id,
      commit: result.from.repoHead,
      startedAt: result.from.startedAt,
      repo: result.from.repoPath,
    },
    to: {
      run: result.to.id,
      commit: result.to.repoHead,
      startedAt: result.to.startedAt,
      repo: result.to.repoPath,
    },
    differentRepo: result.differentRepo,
    findings: {
      addedCount: result.findings.added.length,
      resolvedCount: result.findings.resolved.length,
      unchanged: result.findings.unchanged,
      addedBySeverity: Object.fromEntries(
        result.findings.addedBySeverity.map((row) => [row.severity, row.count]),
      ),
      resolvedBySeverity: Object.fromEntries(
        result.findings.resolvedBySeverity.map((row) => [row.severity, row.count]),
      ),
      // Listed in full: a regression list a pipeline cannot enumerate is a
      // number, and a number is not actionable.
      added: result.findings.added.map(finding),
      resolved: result.findings.resolved.map(finding),
    },
    counts: result.counts,
    surface: {
      packages: named(result.surface.packages),
      endpoints: named(result.surface.endpoints),
      tables: named(result.surface.tables),
    },
  };
}

export function pruneDocument(result: PruneResult): Record<string, unknown> {
  return {
    ...envelope('prune'),
    dryRun: result.dryRun,
    kept: result.kept,
    deleted: result.deleted,
    bytes: {
      before: result.bytesBefore,
      after: result.bytesAfter,
      reclaimed: Math.max(0, result.bytesBefore - result.bytesAfter),
    },
  };
}

export function fetchExtractorDocument(result: FetchJarResult): Record<string, unknown> {
  return {
    ...envelope('fetch-extractor'),
    path: result.path,
    url: result.url,
    sha256: result.sha256,
    bytes: result.bytes,
    cached: result.cached,
  };
}
