/**
 * Reusing mined history when the log would be the same — ADR-0046.
 *
 * `git log` from an unchanged HEAD, with the same options, the same git and
 * the same git configuration, prints the same commits; mining them again is
 * most of `history` on a large repository (nacos: 5 of 7 s). So when all of
 * that matches the run that last mined, its `git_commit` and `commit_file`
 * rows are copied into the new run instead.
 *
 * Only an unchanged HEAD qualifies. A new commit could rename a file, and
 * rename resolution (ADR-0009) rewrites the canonical path of every older
 * change to it, so "the old rows plus the new commits" would not be what a
 * fresh mine produces.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Db } from '../db/database.js';
import { TOOL_VERSION } from '../version.js';
import type { MineStats } from './mine.js';

export interface HistoryKeyInput {
  repoPath: string;
  /** HEAD now, at mining time. */
  head: string;
  since: string | null;
  prefix: string;
  exclude: string[];
  include: string[];
}

/**
 * The key, or null when the log cannot be pinned: no HEAD, or a `since` that
 * git reads relative to today ("1 year ago"), which moves without HEAD moving.
 */
export function historyKey(input: HistoryKeyInput): string | null {
  if (input.since !== null && !/^\d{4}-\d{2}-\d{2}/.test(input.since)) return null;
  const hash = createHash('sha256');
  const part = (value: string) => hash.update(`${value}\0`);
  part('stratigraph-history/1');
  part(TOOL_VERSION);
  part(input.head);
  part(input.since ?? '');
  part(input.prefix);
  part(input.exclude.join('\n'));
  part(input.include.join('\n'));
  // Rename detection and path quoting are git's, so its version and its
  // configuration are part of what the log is a function of.
  part(gitText(input.repoPath, ['--version']));
  part(gitText(input.repoPath, ['config', '--list']));
  return hash.digest('hex');
}

function gitText(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return `failed:${args.join(' ')}`;
  }
}

interface StoredHistory {
  key: string;
  runId: number;
  stats: MineStats;
}

function keyPath(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.facts`, 'history.key');
}

export function rememberHistory(dbPath: string, key: string, runId: number, stats: MineStats): void {
  const path = keyPath(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ key, runId, stats } satisfies StoredHistory) + '\n');
  renameSync(tmp, path);
}

/**
 * Copy the history mined for an earlier run into `runId`, when its key
 * matches and its rows are still in the store. Returns the source run and its
 * stats, or null — in which case nothing was written.
 */
export function reuseHistory(db: Db, dbPath: string, key: string, runId: number): StoredHistory | null {
  let stored: StoredHistory;
  try {
    stored = JSON.parse(readFileSync(keyPath(dbPath), 'utf8')) as StoredHistory;
  } catch {
    return null;
  }
  if (stored.key !== key || stored.runId === runId) return null;

  return db.transaction((): StoredHistory | null => {
    const commits = db
      .prepare('SELECT count(*) FROM git_commit WHERE run_id = ?')
      .pluck()
      .get(stored.runId) as number;
    // Pruned, or never finished: mine instead.
    if (commits !== stored.stats.commits) return null;

    db.prepare('DELETE FROM git_commit WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM file_metric WHERE run_id = ?').run(runId);
    db.prepare(
      `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
       SELECT ?, sha, author_name, author_email, authored_at, subject, is_merge
         FROM git_commit WHERE run_id = ? ORDER BY id`,
    ).run(runId, stored.runId);
    db.prepare(
      `INSERT INTO commit_file (run_id, commit_id, path, canonical_path, insertions, deletions, change_type)
       SELECT ?, n.id, f.path, f.canonical_path, f.insertions, f.deletions, f.change_type
         FROM commit_file f
         JOIN git_commit o ON o.id = f.commit_id
         JOIN git_commit n ON n.run_id = ? AND n.sha = o.sha
        WHERE f.run_id = ?
        ORDER BY f.id`,
    ).run(runId, runId, stored.runId);
    return stored;
  })();
}
