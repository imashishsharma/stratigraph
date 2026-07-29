import { loadConfig, type ConfigOverrides } from '../config.js';
import { assertSchemaCurrent, openDatabase, type Db } from '../db/database.js';
import { createRun, finishRun, findRun, latestRun, readHead, type Run } from '../db/run.js';
import {
  gitPrefix,
  gitToplevel,
  isShallowClone,
  listTrackedFiles,
  type SpawnGit,
} from '../history/git-log.js';
import { computeFileMetrics, type MetricsStats } from '../history/metrics.js';
import { mineHistory, type MineStats } from '../history/mine.js';
import { inScope, pathScope } from '../history/paths.js';
import { info, warn } from '../log.js';

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export interface HistoryOptions extends ConfigOverrides {
  /** Attach to a specific run instead of the most recent one. */
  run?: number | undefined;
  /** Overridable so tests can drive a canned log without a git binary. */
  spawnGit?: SpawnGit | undefined;
}

export interface HistoryResult extends MineStats, MetricsStats {
  runId: number;
  /** False when this command had to open the run itself. */
  reusedRun: boolean;
}

/**
 * Mine the repository's git history into the fact store.
 *
 * Layer 3's gather step, the counterpart to `extract`. It attaches to the most
 * recent run rather than opening its own, so that history and static facts
 * share a `run_id` — which is what lets `analyze` say, exactly, which coupled
 * pairs have no dependency between them. A repository with no run yet gets one,
 * so history works on a machine with no JDK and no extractor jar.
 */
export async function runHistory(options: HistoryOptions): Promise<HistoryResult> {
  const config = loadConfig(options);

  const toplevel = gitToplevel(config.repoPath);
  if (toplevel === null) {
    throw new HistoryError(
      `${config.repoPath} is not inside a git repository — history mining needs one. ` +
        `Run \`stratigraph doctor\` to check that git is on the PATH.`,
    );
  }
  if (isShallowClone(config.repoPath)) {
    warn(
      `${config.repoPath} is a shallow clone, so most of its history is not present. ` +
        `Churn, coupling and authorship will all be understated. Run ` +
        `\`git fetch --unshallow\` first.`,
    );
  }

  // `git log` prints paths relative to the work tree root even when pointed at
  // a subdirectory, while everything else in the store is relative to --repo.
  const prefix = gitPrefix(config.repoPath);
  if (prefix !== '') {
    info(`git: analysing ${prefix} of the repository at ${toplevel}`);
  }

  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);
    const { run, reused } = resolveRun(db, config.repoPath, options.run);

    const scope = pathScope(config.exclude, config.include);
    let mined: MineStats;
    let metrics: MetricsStats;
    try {
      mined = await mineHistory({
        db,
        runId: run.id,
        repoPath: config.repoPath,
        since: config.history.since ?? undefined,
        // Scoping the log to the subtree; paths still come back prefixed.
        pathspec: prefix === '' ? undefined : ['.'],
        prefix,
        scope,
        spawnGit: options.spawnGit,
      });

      const tracked = listTrackedFiles(config.repoPath).filter((path) => inScope(path, scope));
      metrics = computeFileMetrics(db, run.id, config.repoPath, tracked);
    } catch (err) {
      if (!reused) finishRun(db, run.id, 'failed');
      throw err;
    }

    if (!reused) finishRun(db, run.id, 'ok');
    report(run.id, mined, metrics, config.history.since);

    return { runId: run.id, reusedRun: reused, ...mined, ...metrics };
  } finally {
    db.close();
  }
}

function resolveRun(
  db: Db,
  repoPath: string,
  requested: number | undefined,
): { run: Run; reused: boolean } {
  if (requested !== undefined) {
    const run = findRun(db, requested);
    if (!run) throw new HistoryError(`no run ${requested} in this fact store`);
    checkRun(run, repoPath);
    return { run, reused: true };
  }

  const latest = latestRun(db);
  if (latest) {
    checkRun(latest, repoPath);
    return { run: latest, reused: true };
  }

  info('no existing run; opening one for history alone');
  return { run: createRun(db, repoPath), reused: false };
}

function checkRun(run: Run, repoPath: string): void {
  if (run.repoPath !== repoPath) {
    throw new HistoryError(
      `run ${run.id} holds facts for ${run.repoPath}, not ${repoPath}. Attaching this ` +
        `history to it would describe two different repositories as one.`,
    );
  }

  // Not fatal: the facts and the history are both real, they just describe two
  // snapshots. Saying so beats silently reporting them as one.
  const head = readHead(repoPath);
  if (run.repoHead !== null && head !== null && run.repoHead !== head) {
    warn(
      `run ${run.id} recorded HEAD ${run.repoHead.slice(0, 10)}, but the repository is now at ` +
        `${head.slice(0, 10)} — its facts and this history describe different snapshots. ` +
        `Re-run \`stratigraph extract\` to line them up.`,
    );
  }
}

/**
 * Progress and counts go to stderr: `history` gathers, it does not report.
 *
 * ADR-0011 requires a run to say what each rule removed. A repository whose
 * history was mostly filtered away must announce itself rather than look like
 * one with little history.
 */
function report(
  runId: number,
  mined: MineStats,
  metrics: MetricsStats,
  since: string | null,
): void {
  const window = since === null ? 'full history' : `since ${since}`;
  info(
    `run ${runId}: ${mined.commits} commits (${mined.merges} merges), ` +
      `${mined.fileChanges} file changes, ${metrics.files} files with metrics (${window})`,
  );
  if (mined.renames > 0) {
    info(`run ${runId}: ${mined.renames} paths resolved through renames`);
  }
  if (mined.outOfScope > 0) {
    info(`run ${runId}: ${mined.outOfScope} file changes outside include/exclude`);
  }

  const unmeasured = metrics.files - metrics.measured;
  if (unmeasured > 0) {
    warn(
      `${unmeasured} of ${metrics.files} files have no complexity score ` +
        `(${metrics.skippedBinary} binary, ${metrics.skippedTooLarge} too large, ` +
        `${metrics.skippedUnreadable} unreadable) — they are ranked by churn alone`,
    );
  }
}
