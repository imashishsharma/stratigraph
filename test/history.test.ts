import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { topHotspots } from '../src/analysis/hotspots.js';
import { HistoryError, runHistory } from '../src/commands/history.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

/**
 * The one test in the suite that needs git.
 *
 * Everything else drives the parser from a captured log or seeds rows
 * directly, because the matrix runs on three operating systems and only this
 * test justifies depending on a binary. It builds its own repository rather
 * than reading the one it lives in: CI checks out shallow, and a test that
 * asserted on real history would be asserting on whatever was committed last.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

function git(args: string[], cwd: string, at?: string): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Ada Probe',
      '-c',
      'user.email=ada@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      stdio: 'pipe',
      env: at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : { ...process.env },
    },
  );
}

function write(repo: string, path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(repo: string, message: string, at: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-q', '--no-gpg-sign', '-m', message], repo, at);
}

/**
 * Two source files with distinguishable histories, one rename, one deletion,
 * and one file outside `src/`. Fixed dates and author, so every assertion
 * below is exact rather than approximate.
 */
function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'stratigraph-repo-'));
  git(['init', '-q'], repo);

  write(repo, 'src/Old.java', 'class Old {\n    void a() {}\n}\n');
  write(repo, 'src/Keep.java', 'class Keep {}\n');
  write(repo, 'README.md', '# readme\n');
  write(repo, 'doomed.txt', 'goes away\n');
  commit(repo, 'initial', '2024-01-01T10:00:00+00:00');

  write(repo, 'src/Keep.java', 'class Keep {\n    void b() {\n        c();\n    }\n}\n');
  commit(repo, 'grow Keep', '2024-01-02T10:00:00+00:00');

  git(['mv', 'src/Old.java', 'src/New.java'], repo);
  commit(repo, 'rename Old to New', '2024-01-03T10:00:00+00:00');

  write(repo, 'src/New.java', 'class New {\n    void a() {}\n    void b() {}\n}\n');
  commit(repo, 'grow New', '2024-01-04T10:00:00+00:00');

  git(['rm', '-q', 'doomed.txt'], repo);
  commit(repo, 'delete doomed', '2024-01-05T10:00:00+00:00');

  return repo;
}

let repo: string;

beforeAll(() => {
  if (GIT) repo = buildRepo();
});

/**
 * A fact store of its own per test. Tests that leave a run behind — and two of
 * them do deliberately — must not decide what the next test attaches to.
 */
function freshStore(target = repo, config?: object): { cwd: string; dbPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-cwd-'));
  if (config) writeFileSync(join(cwd, 'stratigraph.config.json'), JSON.stringify(config));
  runInit({ repo: target, cwd });
  return { cwd, dbPath: join(cwd, '.stratigraph', `${basename(target)}.db`) };
}

function read<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = openDatabase(dbPath, { mustExist: true, readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

describe.skipIf(!GIT)('runHistory against a real repository', () => {
  it('records every commit, and opens a run when there is none', async () => {
    const { cwd, dbPath } = freshStore();
    const result = await runHistory({ repo, cwd });

    expect(result).toMatchObject({ commits: 5, merges: 0, reusedRun: false });
    const commits = read<{ subject: string; author_email: string; authored_at: string }>(
      dbPath,
      `SELECT subject, author_email, authored_at FROM git_commit
        WHERE run_id = ? ORDER BY authored_at`,
      result.runId,
    );
    expect(commits.map((c) => c.subject)).toEqual([
      'initial',
      'grow Keep',
      'rename Old to New',
      'grow New',
      'delete doomed',
    ]);
    expect(commits[0]).toMatchObject({
      author_email: 'ada@example.invalid',
      authored_at: '2024-01-01T10:00:00.000Z',
    });
  });

  it('follows the rename, so one file has one history', async () => {
    const { cwd, dbPath } = freshStore();
    const { runId } = await runHistory({ repo, cwd });

    // Old.java's commit is filed under the name the file carries today.
    const rows = read<{ path: string }>(
      dbPath,
      `SELECT path FROM commit_file
        WHERE run_id = ? AND canonical_path = 'src/New.java' ORDER BY id`,
      runId,
    );
    expect(rows.map((r) => r.path)).toEqual(['src/New.java', 'src/New.java', 'src/Old.java']);

    expect(
      read(dbPath, `SELECT commits FROM file_metric WHERE run_id = ? AND path = 'src/New.java'`, runId),
    ).toEqual([{ commits: 3 }]);
    expect(
      read(dbPath, `SELECT path FROM file_metric WHERE run_id = ? AND path LIKE '%Old%'`, runId),
    ).toEqual([]);
  });

  it('drops a deleted file from the metrics but keeps its commits', async () => {
    const { cwd, dbPath } = freshStore();
    const { runId } = await runHistory({ repo, cwd });

    expect(
      read(dbPath, `SELECT path FROM file_metric WHERE run_id = ? AND path = 'doomed.txt'`, runId),
    ).toEqual([]);
    // The history is still there. It is the metrics that are about files which
    // still exist, not the record of what happened.
    expect(
      read(
        dbPath,
        `SELECT COUNT(*) AS n FROM commit_file WHERE run_id = ? AND path = 'doomed.txt'`,
        runId,
      ),
    ).toEqual([{ n: 2 }]);
  });

  it('scores complexity off the working tree', async () => {
    const { cwd, dbPath } = freshStore();
    const { runId } = await runHistory({ repo, cwd });

    expect(
      read(dbPath, `SELECT complexity FROM file_metric WHERE run_id = ? AND path = 'src/Keep.java'`, runId),
    ).toEqual([{ complexity: 4 }]);
  });

  it('replaces its own rows rather than appending on a second run', async () => {
    const { cwd, dbPath } = freshStore();
    const first = await runHistory({ repo, cwd });
    const second = await runHistory({ repo, cwd });

    expect(second.runId).toBe(first.runId);
    expect(second.commits).toBe(first.commits);
    expect(read(dbPath, 'SELECT COUNT(*) AS n FROM git_commit WHERE run_id = ?', first.runId)).toEqual(
      [{ n: 5 }],
    );
  });

  it('attaches to the latest run so history and facts share one run id', async () => {
    // This is what lets `analyze` say which coupled pairs have no static
    // dependency: both halves have to be in the same run.
    const { cwd, dbPath } = freshStore();
    const db = openDatabase(dbPath, { mustExist: true });
    const fresh = createRun(db, repo).id;
    db.close();

    expect(await runHistory({ repo, cwd })).toMatchObject({ runId: fresh, reusedRun: true });
  });

  it('refuses to attach history to a run holding another repository', async () => {
    const { cwd, dbPath } = freshStore();
    const db = openDatabase(dbPath, { mustExist: true });
    createRun(db, mkdtempSync(join(tmpdir(), 'stratigraph-other-')));
    db.close();

    await expect(runHistory({ repo, cwd })).rejects.toThrow(/two different repositories/);
  });

  it('honours a since window', async () => {
    const { cwd } = freshStore();
    expect(await runHistory({ repo, cwd, since: '2024-01-03T00:00:00Z' })).toMatchObject({
      commits: 3,
    });
  });

  it('honours exclude, so history covers what extraction covers', async () => {
    const { cwd, dbPath } = freshStore(repo, { exclude: ['src'] });
    const result = await runHistory({ repo, cwd });

    expect(result.outOfScope).toBeGreaterThan(0);
    expect(
      read(dbPath, 'SELECT path FROM file_metric WHERE run_id = ? ORDER BY path', result.runId),
    ).toEqual([{ path: 'README.md' }]);
  });

  it('fails with a usable message outside a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'stratigraph-bare-'));
    const { cwd } = freshStore(bare);

    await expect(runHistory({ repo: bare, cwd })).rejects.toThrow(HistoryError);
    await expect(runHistory({ repo: bare, cwd })).rejects.toThrow(/not inside a git repository/);
  });

  it('mines a subdirectory with paths relative to it, not to the work tree root', async () => {
    // A single service inside a monorepo. `git log` reports paths from the work
    // tree root and `git ls-files` reports them from the cwd; if the two are
    // not reconciled, every metric silently comes out empty.
    const sub = join(repo, 'src');
    const { cwd, dbPath } = freshStore(sub);

    const result = await runHistory({ repo: sub, cwd });

    expect(
      read<{ path: string }>(
        dbPath,
        'SELECT path FROM file_metric WHERE run_id = ? ORDER BY path',
        result.runId,
      ).map((r) => r.path),
    ).toEqual(['Keep.java', 'New.java']);
  });

  it('never ranks a lockfile, however large and busy (the v1 failure)', async () => {
    // v1.6.1 on a real Spring + Angular repository ranked package-lock.json
    // first and package.json second. Rebuilt here: a lockfile rewritten
    // wholesale on every commit, a manifest bumped alongside it, and one small
    // source file changed a few times (ADR-0030, ADR-0031).
    const mono = mkdtempSync(join(tmpdir(), 'stratigraph-lock-'));
    git(['init', '-q'], mono);
    for (let i = 0; i < 6; i += 1) {
      const lock = Array.from({ length: 400 }, (_, n) => `    "pkg-${n}": { "version": "1.${i}.${n}" },`).join('\n');
      write(mono, 'package-lock.json', `{\n  "packages": {\n${lock}\n  }\n}\n`);
      write(mono, 'package.json', `{\n  "version": "1.${i}.0"\n}\n`);
      if (i % 2 === 0) {
        write(mono, 'src/app/order.service.ts', `export class OrderService {\n  total() {\n    return ${i};\n  }\n}\n`);
      }
      write(mono, 'src/app/order.service.spec.ts', `describe('x', () => {\n  it('${i}', () => {});\n});\n`);
      commit(mono, `bump ${i}`, `2024-0${i + 1}-01T10:00:00+00:00`);
    }
    const { cwd, dbPath } = freshStore(mono);

    const result = await runHistory({ repo: mono, cwd });

    expect(result.roles).toMatchObject({ lockfile: 1, manifest: 1, source: 1, test: 1 });
    const db = openDatabase(dbPath, { mustExist: true, readonly: true });
    try {
      expect(topHotspots(db, result.runId, 10).map((h) => h.path)).toEqual([
        'src/app/order.service.ts',
      ]);
    } finally {
      db.close();
    }
  });

  it('does not count revisions listed in .git-blame-ignore-revs', async () => {
    const fmt = mkdtempSync(join(tmpdir(), 'stratigraph-ignore-'));
    git(['init', '-q'], fmt);
    write(fmt, 'src/A.java', 'class A {\n    void a() {}\n}\n');
    commit(fmt, 'initial', '2024-01-01T10:00:00+00:00');
    write(fmt, 'src/A.java', 'class A {\n  void a() {}\n}\n');
    commit(fmt, 'reformat', '2024-01-02T10:00:00+00:00');
    const reformat = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fmt, encoding: 'utf8' }).trim();
    write(fmt, '.git-blame-ignore-revs', `# formatting\n${reformat}\n`);
    commit(fmt, 'ignore the reformat', '2024-01-03T10:00:00+00:00');
    const { cwd, dbPath } = freshStore(fmt);

    const result = await runHistory({ repo: fmt, cwd });

    expect(result.excludedIgnored).toBe(1);
    expect(
      read(dbPath, 'SELECT commits, recent_commits FROM file_metric WHERE run_id = ? AND path = ?', result.runId, 'src/A.java'),
    ).toEqual([{ commits: 2, recent_commits: 1 }]);
  });
});
