/**
 * `stratigraph diff` — what changed between two runs.
 *
 * The reason this matters more than its size suggests: `--fail-on` can only be
 * adopted by a repository that already passes it, which excludes every codebase
 * this tool was built for. `--fail-on-new` can be adopted on day one by any of
 * them, because it fails a build for regressions and stays silent about the
 * debt that was already there. A gate nobody can turn on is not a gate.
 */

import { loadConfig, type ConfigOverrides } from '../config.js';
import { diffRuns, type DiffFinding, type DiffResult } from '../analysis/diff.js';
import { assertSchemaCurrent, openDatabase, requireStore, type Db } from '../db/database.js';
import { info, outputFormat, print, printJson, warn } from '../log.js';
import { evaluateGate, type GateSeverity } from '../present/findings.js';
import { diffDocument } from '../present/json.js';
import { GateError } from './analyze.js';

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffError';
  }
}

/** Named entities listed before the rest are counted. */
const NAMES_SHOWN = 10;

export interface DiffOptions extends ConfigOverrides {
  /** The older run. Defaults to the analysed run before `to`. */
  from?: number | undefined;
  /** The newer run. Defaults to the most recent analysed run. */
  to?: number | undefined;
  /** Exit 3 when a finding this severe or worse is new in `to`. */
  failOnNew?: GateSeverity | undefined;
}

export function runDiff(options: DiffOptions = {}): DiffResult {
  const config = loadConfig(options);
  requireStore(
    config.dbPath,
    'diff compares two runs already in the store. Run `stratigraph analyze` twice first.',
  );

  const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
  try {
    assertSchemaCurrent(db);

    const { from, to } = resolveRuns(db, options, config.dbPath);
    const result = diffRuns(db, from, to);

    // ADR-0026 again, one level up: an unanalysed run has no findings, so every
    // finding in the other run reads as added or resolved. That is a comparison
    // against nothing, dressed as a clean sweep.
    for (const run of [result.from, result.to] as const) {
      if (!run.analysed) {
        throw new DiffError(
          `run ${run.id} has no analysis output, so comparing against it would report every ` +
            `finding in the other run as a change. Run \`stratigraph analyze --run ${run.id}\` ` +
            `first, or pick two runs that have both been analysed.`,
        );
      }
    }

    if (result.differentRepo) {
      warn(
        `run ${result.from.id} and run ${result.to.id} were taken from different paths ` +
          `(${result.from.repoPath} and ${result.to.repoPath}). Everything below is still set ` +
          `arithmetic, but "added" and "removed" mean something else across two repositories.`,
      );
    }

    if (outputFormat() === 'json') {
      printJson(diffDocument(result, NAMES_SHOWN));
    } else {
      report(result);
    }

    const gate =
      options.failOnNew === undefined
        ? null
        : evaluateGate(
            {
              findings: [],
              total: result.findings.added.length,
              uncited: 0,
              byRule: [],
              bySeverity: result.findings.addedBySeverity,
            },
            options.failOnNew,
          );

    if (gate?.failed === true) {
      const breakdown = gate.bySeverity.map((row) => `${row.count} ${row.severity}`).join(', ');
      throw new GateError(
        `${gate.offending} new finding(s) at or above \`${gate.threshold}\` since run ` +
          `${result.from.id} (${breakdown}). Findings that were already there do not count.`,
      );
    }

    return result;
  } finally {
    db.close();
  }
}

/**
 * Which two runs.
 *
 * Defaults to the last two *analysed* runs rather than the last two runs: a
 * bare `extract` opens a run with no findings, and defaulting to it would make
 * the common case compare against nothing.
 */
function resolveRuns(
  db: Db,
  options: DiffOptions,
  dbPath: string,
): { from: number; to: number } {
  if (options.from !== undefined && options.to !== undefined) {
    // Checked here as well as below: this is the branch where both came from
    // the user, which is the only branch where they can be the wrong way round.
    return ordered(options.from, options.to);
  }

  const analysed = (
    db
      .prepare(
        `SELECT r.id AS id FROM run r
          WHERE EXISTS (SELECT 1 FROM finding WHERE run_id = r.id)
             OR EXISTS (SELECT 1 FROM cluster WHERE run_id = r.id)
             OR EXISTS (SELECT 1 FROM temporal_coupling WHERE run_id = r.id)
          ORDER BY r.id DESC`,
      )
      .all() as Array<{ id: number }>
  ).map((row) => row.id);

  const to = options.to ?? analysed[0];
  if (to === undefined) {
    throw new DiffError(
      `no analysed run in ${dbPath} — diff compares two of them. Run \`stratigraph extract\`, ` +
        `\`stratigraph history\` and \`stratigraph analyze\`, then again later.`,
    );
  }

  const from = options.from ?? analysed.find((id) => id < to);
  if (from === undefined) {
    throw new DiffError(
      `only one analysed run in ${dbPath} (run ${to}), so there is nothing to compare it ` +
        `against. Analyse a second run — a later commit, or the same one after a change.`,
    );
  }

  return ordered(from, to);
}

/**
 * Refuse a comparison read backwards.
 *
 * Not a courtesy: with the arguments swapped every fix reads as a regression
 * and every regression as a fix, and `--fail-on-new` then passes a build for
 * introducing the thing it was added to catch.
 */
function ordered(from: number, to: number): { from: number; to: number } {
  if (from >= to) {
    throw new DiffError(
      `--from must name an earlier run than --to, got ${from} and ${to}. A diff read backwards ` +
        `reports every fix as a regression and every regression as a fix.`,
    );
  }
  return { from, to };
}

function report(result: DiffResult): void {
  const { from, to, findings, counts, surface } = result;

  info(
    `run ${from.id} (${short(from.repoHead)}, ${from.startedAt}) -> ` +
      `run ${to.id} (${short(to.repoHead)}, ${to.startedAt})`,
  );

  print('');
  print('Findings');
  print(`  new        ${pad(findings.added.length)}  ${severities(findings.addedBySeverity)}`);
  print(
    `  resolved   ${pad(findings.resolved.length)}  ${severities(findings.resolvedBySeverity)}`,
  );
  print(`  unchanged  ${pad(findings.unchanged)}`);

  section('New since the earlier run', findings.added);
  section('Resolved', findings.resolved);

  print('');
  print('Structure');
  for (const [label, delta] of [
    ['files', counts.files],
    ['packages', counts.packages],
    ['types', counts.types],
    ['endpoints', counts.endpoints],
    ['tables', counts.tables],
    ['edges', counts.edges],
  ] as const) {
    print(
      `  ${label.padEnd(10)} ${String(delta.from).padStart(7)} -> ` +
        `${String(delta.to).padStart(7)}  ${signed(delta.delta)}`,
    );
  }

  names('Endpoints added', surface.endpoints.added);
  names('Endpoints removed', surface.endpoints.removed);
  names('Tables added', surface.tables.added);
  names('Tables removed', surface.tables.removed);

  if (findings.added.length === 0 && findings.resolved.length === 0) {
    print('');
    print('No finding changed between these two runs.');
  }
}

function section(heading: string, findings: DiffFinding[]): void {
  if (findings.length === 0) return;
  print('');
  print(`${heading}:`);
  for (const finding of findings) {
    print(`  [${finding.severity}] ${finding.title}`);
    // Model-authored rows sit in the same table as observations, and a reader
    // scanning a regression list has to be able to tell them apart here too.
    if (finding.authoredBy === 'model') print('    (model-authored — inference, not observation)');
  }
}

function names(heading: string, values: string[]): void {
  if (values.length === 0) return;
  print('');
  print(`${heading} (${values.length}):`);
  for (const value of values.slice(0, NAMES_SHOWN)) print(`  ${value}`);
  if (values.length > NAMES_SHOWN) {
    print(`  ... and ${values.length - NAMES_SHOWN} more`);
  }
}

function severities(rows: Array<{ severity: string; count: number }>): string {
  return rows.length === 0 ? '' : rows.map((row) => `${row.count} ${row.severity}`).join(', ');
}

function signed(delta: number): string {
  return delta === 0 ? '' : delta > 0 ? `+${delta}` : String(delta);
}

function pad(value: number): string {
  return String(value).padStart(4);
}

function short(sha: string | null): string {
  return sha === null ? 'no HEAD recorded' : sha.slice(0, 10);
}
