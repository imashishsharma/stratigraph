/**
 * `stratigraph prune` — drop old runs and give the disk back.
 *
 * Every `extract`, `history` and `ingest` opens a run and nothing has ever
 * closed one, so a store analysed weekly in CI grows without bound: each run
 * holds a whole copy of the node and edge tables for the commit it read. On a
 * 4,000-file repository that is tens of megabytes a run, and none of it is
 * reachable once a newer run exists.
 *
 * Pruning is safe in a way deleting user data never is: the fact store is
 * derived, and every row in it can be rebuilt by pointing the same commands at
 * the same commit. What it costs is time, which is why this is a command you
 * run rather than something `extract` does on its way past — a tool that
 * silently discarded the run you were about to compare against would be worse
 * than a large file.
 */

import { statSync } from 'node:fs';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { assertSchemaCurrent, openDatabase, requireStore, type Db } from '../db/database.js';
import { info, print, warn } from '../log.js';

export class PruneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PruneError';
  }
}

export const DEFAULT_KEEP = 3;

export interface PruneOptions extends ConfigOverrides {
  /** Newest runs to keep. At least 1. */
  keep?: number | undefined;
  /** List what would go, delete nothing. */
  dryRun?: boolean | undefined;
}

export interface PrunedRun {
  id: number;
  startedAt: string;
  nodes: number;
  commits: number;
}

export interface PruneResult {
  kept: number[];
  deleted: PrunedRun[];
  /** Store size in bytes, before and after. Equal when nothing was deleted. */
  bytesBefore: number;
  bytesAfter: number;
  dryRun: boolean;
}

export function runPrune(options: PruneOptions = {}): PruneResult {
  const config = loadConfig(options);
  const keep = options.keep ?? DEFAULT_KEEP;
  const dryRun = options.dryRun ?? false;

  if (!Number.isInteger(keep) || keep < 1) {
    throw new PruneError(
      `--keep must be a whole number of at least 1, got "${keep}". A store with no runs ` +
        `answers nothing; delete the file itself if that is what you want.`,
    );
  }

  requireStore(
    config.dbPath,
    'there is nothing to prune. Run `stratigraph init` and `stratigraph extract` first.',
  );

  const bytesBefore = statSync(config.dbPath).size;
  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);

    const runs = summarise(db);
    if (runs.length === 0) {
      throw new PruneError(`no runs in ${config.dbPath} — there is nothing to prune`);
    }

    // Newest first, so "keep 3" keeps the three a reader would call the latest.
    const kept = runs.slice(0, keep);
    const doomed = runs.slice(keep);

    report(kept, doomed, dryRun);

    if (doomed.length === 0 || dryRun) {
      return {
        kept: kept.map((run) => run.id),
        deleted: doomed,
        bytesBefore,
        bytesAfter: bytesBefore,
        dryRun,
      };
    }

    // Every table hangs off `run` with ON DELETE CASCADE, so this one statement
    // is the whole deletion — and one transaction means a run is either gone
    // or entirely present, never half-collected.
    const drop = db.transaction((ids: number[]) => {
      const statement = db.prepare('DELETE FROM run WHERE id = ?');
      for (const id of ids) statement.run(id);
    });
    drop(doomed.map((run) => run.id));

    // Outside the transaction: SQLite refuses to VACUUM inside one. Without it
    // the pages are free-listed and the file on disk never shrinks, which is
    // the entire complaint this command answers.
    db.exec('VACUUM');

    // And in WAL mode the shrunk database is still sitting in the write-ahead
    // log at this point, so the file has not changed size yet. Checkpoint and
    // fold the log back in before measuring, or this command reports that it
    // reclaimed nothing every single time.
    db.pragma('wal_checkpoint(TRUNCATE)');

    const bytesAfter = statSync(config.dbPath).size;
    info(
      `${doomed.length} run(s) deleted. ${size(bytesBefore)} -> ${size(bytesAfter)} ` +
        `(${size(Math.max(0, bytesBefore - bytesAfter))} reclaimed).`,
    );

    return { kept: kept.map((run) => run.id), deleted: doomed, bytesBefore, bytesAfter, dryRun };
  } finally {
    db.close();
  }
}

/** Newest first. Counts come along so the output says what is being discarded. */
function summarise(db: Db): PrunedRun[] {
  return db
    .prepare(
      `SELECT r.id AS id,
              r.started_at AS startedAt,
              (SELECT COUNT(*) FROM node WHERE run_id = r.id AND is_stub = 0) AS nodes,
              (SELECT COUNT(*) FROM git_commit WHERE run_id = r.id) AS commits
         FROM run r
        ORDER BY r.id DESC`,
    )
    .all() as PrunedRun[];
}

/**
 * Print every run and its fate before anything is deleted.
 *
 * A destructive command that prints only a total ("2 runs deleted") gives the
 * reader no way to notice it took the wrong two.
 */
function report(kept: PrunedRun[], doomed: PrunedRun[], dryRun: boolean): void {
  const rows = [...kept.map((run) => [run, 'keep'] as const), ...doomed.map((r) => [r, dryRun ? 'would delete' : 'delete'] as const)]
    .sort(([a], [b]) => a.id - b.id);

  for (const [run, fate] of rows) {
    print(
      `run ${String(run.id).padEnd(4)} ${run.startedAt}  ` +
        `${String(run.nodes).padStart(7)} nodes  ${String(run.commits).padStart(7)} commits  ${fate}`,
    );
  }

  if (doomed.length === 0) {
    info(`nothing to prune: ${kept.length} run(s) stored, all within --keep.`);
    return;
  }

  // Recency is the wrong axis for exactly one thing. `history` attaches to the
  // run `extract` opened, so two bare extracts leave the newest runs with no
  // commits and all the mined history on an older one — which --keep then
  // deletes. Re-mining a large repository is minutes, not seconds, so this is
  // said before it happens rather than discovered after.
  if (kept.every((run) => run.commits === 0) && doomed.some((run) => run.commits > 0)) {
    warn(
      `every run being deleted carries the git history and none of the kept runs has any. ` +
        `After this the store has no commits, and hotspots, churn and co-change all become ` +
        `unavailable until you run \`stratigraph history\` again. Keep more runs, or re-mine ` +
        `history into the newest one first.`,
    );
  }

  if (dryRun) {
    info(`${doomed.length} run(s) would be deleted. Nothing was written (--dry-run).`);
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
