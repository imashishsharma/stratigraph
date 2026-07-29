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

export function findRun(db: Db, id: number): Run | null {
  return toRun(
    db
      .prepare(`SELECT id, repo_path, repo_head, started_at FROM run WHERE id = ?`)
      .get(id) as RunRow | undefined,
  );
}

export function latestRun(db: Db): Run | null {
  return toRun(
    db
      .prepare(
        `SELECT id, repo_path, repo_head, started_at FROM run
          ORDER BY id DESC LIMIT 1`,
      )
      .get() as RunRow | undefined,
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
