import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { computeFileMetrics } from '../src/history/metrics.js';

let db: Db;
let runId: number;
let repo: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repo = mkdtempSync(join(tmpdir(), 'stratigraph-metrics-'));
  runId = createRun(db, repo).id;
});

interface Change {
  path: string;
  canonical?: string;
  insertions?: number;
  deletions?: number;
}

let sha = 0;

/** Seed one commit directly, so metrics are tested without git anywhere near them. */
function commit(options: {
  author: string;
  at: string;
  files: Change[];
  merge?: boolean;
}): void {
  sha += 1;
  const commitId = Number(
    db
      .prepare(
        `INSERT INTO git_commit (run_id, sha, author_name, author_email, authored_at, subject, is_merge)
         VALUES (?, ?, ?, ?, ?, 'subject', ?)`,
      )
      .run(runId, `sha${sha}`, options.author, `${options.author}@example.invalid`, options.at, options.merge ? 1 : 0)
      .lastInsertRowid,
  );
  for (const file of options.files) {
    db.prepare(
      `INSERT INTO commit_file
         (run_id, commit_id, path, canonical_path, insertions, deletions, change_type)
       VALUES (?, ?, ?, ?, ?, ?, 'M')`,
    ).run(
      runId,
      commitId,
      file.path,
      file.canonical ?? file.path,
      file.insertions ?? 1,
      file.deletions ?? 0,
    );
  }
}

function writeFile(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function metrics(path: string) {
  return db
    .prepare('SELECT * FROM file_metric WHERE run_id = ? AND path = ?')
    .get(runId, path) as Record<string, unknown> | undefined;
}

describe('computeFileMetrics', () => {
  it('counts commits, churn, authors and the change window', () => {
    writeFile('src/A.java', 'class A {}\n');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/A.java', insertions: 10, deletions: 2 }] });
    commit({ author: 'bob', at: '2024-03-01T00:00:00.000Z', files: [{ path: 'src/A.java', insertions: 4, deletions: 4 }] });

    computeFileMetrics(db, runId, repo, ['src/A.java']);

    expect(metrics('src/A.java')).toMatchObject({
      commits: 2,
      churn: 20,
      authors: 2,
      top_author_share: 0.5,
      first_change_at: '2024-01-01T00:00:00.000Z',
      last_change_at: '2024-03-01T00:00:00.000Z',
    });
  });

  it('excludes merge commits from every metric', () => {
    // ADR-0011. git prints no diff for a merge by default, so this changes
    // nothing today — it is here so that adding --diff-merges to the log for
    // some other reason cannot silently double every count.
    writeFile('src/A.java', 'class A {}\n');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/A.java', insertions: 5 }] });
    commit({
      author: 'zoe',
      at: '2024-02-01T00:00:00.000Z',
      merge: true,
      files: [{ path: 'src/A.java', insertions: 500 }],
    });

    computeFileMetrics(db, runId, repo, ['src/A.java']);

    expect(metrics('src/A.java')).toMatchObject({ commits: 1, churn: 5, authors: 1 });
  });

  it('measures ownership by commits rather than by lines', () => {
    // One reformatting commit can rewrite a whole file. Ownership by line
    // would credit the entire file to whoever ran the formatter.
    writeFile('src/A.java', 'class A {}\n');
    for (let i = 0; i < 3; i += 1) {
      commit({ author: 'ada', at: `2024-01-0${i + 1}T00:00:00.000Z`, files: [{ path: 'src/A.java', insertions: 1 }] });
    }
    commit({
      author: 'formatter',
      at: '2024-01-09T00:00:00.000Z',
      files: [{ path: 'src/A.java', insertions: 900, deletions: 900 }],
    });

    computeFileMetrics(db, runId, repo, ['src/A.java']);

    expect(metrics('src/A.java')).toMatchObject({ commits: 4, authors: 2, top_author_share: 0.75 });
  });

  it('groups a renamed file under one history', () => {
    // The rename chain has already resolved canonical_path; this is the half
    // that has to actually use it.
    writeFile('src/New.java', 'class New {}\n');
    commit({
      author: 'ada',
      at: '2024-01-01T00:00:00.000Z',
      files: [{ path: 'src/Old.java', canonical: 'src/New.java', insertions: 7 }],
    });
    commit({
      author: 'ada',
      at: '2024-02-01T00:00:00.000Z',
      files: [{ path: 'src/New.java', insertions: 3 }],
    });

    computeFileMetrics(db, runId, repo, ['src/New.java']);

    expect(metrics('src/New.java')).toMatchObject({ commits: 2, churn: 10 });
    expect(metrics('src/Old.java')).toBeUndefined();
  });

  it('keeps only files that still exist at HEAD', () => {
    writeFile('src/Live.java', 'class Live {}\n');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/Live.java' }] });
    commit({ author: 'ada', at: '2024-01-02T00:00:00.000Z', files: [{ path: 'src/Gone.java' }] });

    const stats = computeFileMetrics(db, runId, repo, ['src/Live.java']);

    expect(stats.files).toBe(1);
    expect(metrics('src/Gone.java')).toBeUndefined();
  });

  it('scores complexity from the file on disk', () => {
    writeFile('src/Deep.java', 'class A {\n    void run() {\n        go();\n    }\n}\n');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/Deep.java' }] });

    const stats = computeFileMetrics(db, runId, repo, ['src/Deep.java']);

    expect(stats.measured).toBe(1);
    expect(metrics('src/Deep.java')).toMatchObject({ complexity: 4 });
  });

  it('leaves complexity null for a file it cannot measure, and says why', () => {
    // Null, not zero: a jar scored zero would rank as the simplest file in the
    // repository rather than as unmeasured.
    writeFile('src/blob.bin', '\0binary');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/blob.bin' }] });

    const stats = computeFileMetrics(db, runId, repo, ['src/blob.bin']);

    expect(stats).toMatchObject({ files: 1, measured: 0, skippedBinary: 1 });
    expect(metrics('src/blob.bin')?.['complexity']).toBeNull();
  });

  it('counts a file tracked at HEAD but missing from the work tree as unreadable', () => {
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/Sparse.java' }] });

    const stats = computeFileMetrics(db, runId, repo, ['src/Sparse.java']);

    expect(stats).toMatchObject({ files: 1, skippedUnreadable: 1 });
  });

  it('replaces its own output rather than appending to it', () => {
    writeFile('src/A.java', 'class A {}\n');
    commit({ author: 'ada', at: '2024-01-01T00:00:00.000Z', files: [{ path: 'src/A.java' }] });

    computeFileMetrics(db, runId, repo, ['src/A.java']);
    computeFileMetrics(db, runId, repo, ['src/A.java']);

    expect(db.prepare('SELECT COUNT(*) AS n FROM file_metric WHERE run_id = ?').get(runId)).toEqual(
      { n: 1 },
    );
  });

  it('produces nothing when no tracked file has history', () => {
    expect(computeFileMetrics(db, runId, repo, []).files).toBe(0);
  });
});
