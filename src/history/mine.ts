/**
 * Layer 3's gather step: git log into `git_commit` and `commit_file`.
 *
 * Transcription only. Every row here is something git said, with rename
 * resolution (ADR-0009) as the one derived column — and that one is stored
 * alongside the path as the commit actually spelled it, so nothing is lost.
 * Metrics are computed separately, from these rows.
 */

import type { Db } from '../db/database.js';
import { info } from '../log.js';
import { readCommits, type Commit, type ReadCommitsOptions } from './git-log.js';
import { inScope, type PathScope } from './paths.js';
import { RenameChain } from './renames.js';

/**
 * Commits per write transaction. better-sqlite3's transactions are
 * synchronous and the log arrives asynchronously, so the two are bridged by
 * batching rather than by holding one transaction open across an await.
 */
const BATCH_COMMITS = 500;

export interface MineOptions extends ReadCommitsOptions {
  db: Db;
  runId: number;
  scope: PathScope;
  /** Stripped from every logged path; see `gitPrefix`. */
  prefix?: string | undefined;
}

export interface MineStats {
  commits: number;
  merges: number;
  /** `commit_file` rows written. */
  fileChanges: number;
  /** File changes dropped by include/exclude. */
  outOfScope: number;
  /** Paths superseded by a rename. */
  renames: number;
}

/**
 * Read the log into the store, replacing anything a previous run of this
 * command left behind.
 *
 * Idempotent for the same reason `detectPackageCycles` is: mining is a pure
 * function of the repository at a commit, so running it twice must not produce
 * two of everything.
 */
export async function mineHistory(options: MineOptions): Promise<MineStats> {
  const { db, runId } = options;
  const prefix = options.prefix ?? '';

  db.transaction(() => {
    // commit_file goes with it, by ON DELETE CASCADE.
    db.prepare('DELETE FROM git_commit WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM file_metric WHERE run_id = ?').run(runId);
  })();

  const insertCommit = db.prepare(
    `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
     VALUES (@runId, @sha, @authorName, @authorEmail, @authoredAt, @subject, @isMerge)`,
  );
  const insertFile = db.prepare(
    `INSERT INTO commit_file
       (run_id, commit_id, path, canonical_path, insertions, deletions, change_type)
     VALUES (@runId, @commitId, @path, @canonicalPath, @insertions, @deletions, @changeType)`,
  );

  const chain = new RenameChain();
  const stats: MineStats = {
    commits: 0,
    merges: 0,
    fileChanges: 0,
    outOfScope: 0,
    renames: 0,
  };

  const writeBatch = db.transaction((batch: Commit[]) => {
    for (const commit of batch) {
      const commitId = Number(
        insertCommit.run({
          runId,
          sha: commit.sha,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          authoredAt: commit.authoredAt,
          subject: commit.subject,
          isMerge: commit.isMerge ? 1 : 0,
        }).lastInsertRowid,
      );
      stats.commits += 1;
      if (commit.isMerge) stats.merges += 1;

      for (const file of commit.files) {
        const path = strip(file.path, prefix);
        const canonicalPath = chain.canonical(path);
        if (!inScope(canonicalPath, options.scope)) {
          stats.outOfScope += 1;
          continue;
        }
        insertFile.run({
          runId,
          commitId,
          path,
          canonicalPath,
          insertions: file.insertions,
          deletions: file.deletions,
          changeType: file.status,
        });
        stats.fileChanges += 1;
      }

      // Recorded after this commit's own paths are resolved, and therefore
      // only ever consulted by commits older than this one — which is exactly
      // the guarantee the backwards pass depends on.
      for (const file of commit.files) {
        if (file.oldPath === null) continue;
        chain.record(strip(file.oldPath, prefix), strip(file.path, prefix));
      }
    }
  });

  let batch: Commit[] = [];
  for await (const commit of readCommits(options)) {
    batch.push(commit);
    if (batch.length >= BATCH_COMMITS) {
      writeBatch(batch);
      batch = [];
      info(`git: ${stats.commits} commits read`);
    }
  }
  if (batch.length > 0) writeBatch(batch);

  stats.renames = chain.size;
  return stats;
}

/**
 * `git log` prints paths relative to the work tree root even when pointed at a
 * subdirectory. Everything else in the store is relative to `--repo`.
 */
function strip(path: string, prefix: string): string {
  return prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
