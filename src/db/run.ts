import { execFileSync } from 'node:child_process';

import { TOOL_VERSION } from '../version.js';
import type { Db } from './database.js';

export interface Run {
  id: number;
  repoPath: string;
  repoHead: string | null;
  startedAt: string;
}

/** Opens a new analysis run. Every fact row is scoped to one of these. */
export function createRun(db: Db, repoPath: string): Run {
  const startedAt = new Date().toISOString();
  const repoHead = readHead(repoPath);
  const info = db
    .prepare(
      `INSERT INTO run (repo_path, repo_head, tool_version, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .run(repoPath, repoHead, TOOL_VERSION, startedAt);
  return { id: Number(info.lastInsertRowid), repoPath, repoHead, startedAt };
}

export function finishRun(db: Db, runId: number, status: 'ok' | 'failed'): void {
  db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    runId,
  );
}

export type ExtractorStatus = 'ok' | 'skipped' | 'failed';

/**
 * What became of one extractor the run selected (ADR-0032). Written for every
 * selected extractor — a skipped one especially, because a gap nobody recorded
 * is indistinguishable from a language the repository does not use.
 */
export function recordExtractor(
  db: Db,
  runId: number,
  language: string,
  status: ExtractorStatus,
  reason: string | null,
): void {
  db.prepare(
    `INSERT INTO extractor_run (run_id, language, status, reason, finished_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (run_id, language) DO UPDATE
       SET status = excluded.status, reason = excluded.reason, finished_at = excluded.finished_at`,
  ).run(runId, language, status, reason, new Date().toISOString());
}

export function findRun(db: Db, id: number): Run | null {
  return toRun(
    db
      .prepare(`SELECT id, repo_path, repo_head, started_at FROM run WHERE id = ?`)
      .get(id) as RunRow | undefined,
  );
}

/**
 * The most recent run that finished ok (ADR-0032).
 *
 * Never a failed run, and never one still marked running — which, when no
 * process holds it, is a process that died. Either would be reported as a
 * complete description of a repository it only half read. An explicit
 * `--run` still reaches them through `findRun`.
 */
export function latestRun(db: Db): Run | null {
  return toRun(
    db
      .prepare(
        `SELECT id, repo_path, repo_head, started_at FROM run
          WHERE status = 'ok'
          ORDER BY id DESC LIMIT 1`,
      )
      .get() as RunRow | undefined,
  );
}

/**
 * Why `latestRun` found nothing: an empty store, or runs that never completed.
 * The second must name the run and how to read it anyway, or the person who
 * just watched `extract` fail is told to run `extract`.
 */
export function noCompletedRunMessage(db: Db, dbPath: string): string {
  const last = db
    .prepare('SELECT id, status FROM run ORDER BY id DESC LIMIT 1')
    .get() as { id: number; status: string } | undefined;
  if (last === undefined) {
    return `no runs in ${dbPath} — run \`stratigraph extract\` or \`stratigraph history\` first`;
  }
  const what = last.status === 'failed' ? 'failed' : 'never finished';
  return (
    `no completed run in ${dbPath} — run ${last.id} ${what}. Fix the cause and extract ` +
    `again, or pass --run ${last.id} to read its incomplete facts anyway`
  );
}

interface RunRow {
  id: number;
  repo_path: string;
  repo_head: string | null;
  started_at: string;
}

function toRun(row: RunRow | undefined): Run | null {
  if (!row) return null;
  return {
    id: row.id,
    repoPath: row.repo_path,
    repoHead: row.repo_head,
    startedAt: row.started_at,
  };
}

/** HEAD sha, or null when the target is not a git repository. */
export function readHead(repoPath: string): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
