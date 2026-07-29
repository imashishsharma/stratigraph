/**
 * Reading `git log`.
 *
 * Layer 3's only source. Everything here is transcription: what git said, in
 * objects. No metric is computed and no path is guessed at — the one piece of
 * judgement in the whole file is normalising an author date to UTC, and an
 * unparseable one is passed through rather than dropped.
 *
 * See ADR-0009 for why this is one whole-repository pass rather than
 * `--follow`, and `fixtures/git-log/README.md` for the format it parses.
 */

import { execFileSync, spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitLogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLogParseError';
  }
}

export interface FileChange {
  /** Path as of this commit. For a rename, the post-image path. */
  path: string;
  /** Pre-image path. Set only for renames and copies. */
  oldPath: string | null;
  /** Zero for a binary file, where git reports no line counts at all. */
  insertions: number;
  deletions: number;
  binary: boolean;
  /** git's own status letter — `A`, `M`, `D`, `R100`, … Null if not requested. */
  status: string | null;
}

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601, normalised to UTC where git's value parses. */
  authoredAt: string;
  parents: string[];
  subject: string;
  isMerge: boolean;
  files: FileChange[];
}

/**
 * `\x01` starts a record, `\x1f` separates header fields. Both are ours; `-z`
 * makes git's own separator `\x00`, so nothing collides.
 */
export const LOG_FORMAT = '%x01%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s';

/**
 * A record starts at `\x01` — but only when a sha and a field separator follow.
 * A commit message may contain any byte, `\x01` included, and splitting on the
 * bare sentinel would tear such a commit in half.
 */
const RECORD_START = /\x01(?=[0-9a-f]{7,64}\x1f)/g;

/** `:100644 100644 4cb29ea f384549 R073` — the `--raw` half of each entry. */
const RAW_ENTRY = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)$/;

/**
 * `1\t0\tsrc/A.java`, or `1\t0\t` when a rename puts the two paths in the
 * following fields, or `-\t-\tblob.bin` for a binary file. The path group is
 * `[\s\S]*` rather than `.*` because a filename may legally contain a newline.
 */
const NUMSTAT_ENTRY = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * Incremental parser, so a repository's whole log never has to be held in
 * memory at once. `push` returns every record it can complete and keeps the
 * rest; `end` flushes the last one.
 */
export class GitLogParser {
  private buffer = '';

  push(chunk: string): Commit[] {
    this.buffer += chunk;
    const starts = recordStarts(this.buffer);
    // The final record is only complete once the next one has begun, so hold
    // it back — which also means a partly-arrived record simply stays buffered.
    if (starts.length <= 1) return [];

    const commits: Commit[] = [];
    for (let i = 0; i < starts.length - 1; i += 1) {
      commits.push(parseRecord(this.buffer.slice((starts[i] as number) + 1, starts[i + 1])));
    }
    this.buffer = this.buffer.slice(starts[starts.length - 1]);
    return commits;
  }

  end(): Commit[] {
    const rest = this.buffer;
    this.buffer = '';
    const starts = recordStarts(rest);
    return starts.map((start, i) => parseRecord(rest.slice(start + 1, starts[i + 1])));
  }
}

/** Parse a complete log. Convenience over `GitLogParser` for tests and small repos. */
export function parseGitLog(text: string): Commit[] {
  const parser = new GitLogParser();
  return [...parser.push(text), ...parser.end()];
}

function recordStarts(text: string): number[] {
  const starts: number[] = [];
  RECORD_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RECORD_START.exec(text)) !== null) starts.push(match.index);
  return starts;
}

function parseRecord(record: string): Commit {
  // The header runs to the first newline when the commit has a diff, and to the
  // record separator when it does not — an empty commit produces no newline at
  // all. Any later newline belongs to the body, where a path may contain one.
  const newline = record.indexOf('\n');
  const headerText = (newline === -1 ? record : record.slice(0, newline)).replace(/\0+$/, '');
  const body = newline === -1 ? '' : record.slice(newline + 1);

  const parts = headerText.split('\x1f');
  if (parts.length < 6) {
    throw new GitLogParseError(
      `git log record has ${parts.length} header fields, expected 6: ${JSON.stringify(
        headerText.slice(0, 120),
      )}`,
    );
  }

  const parents = (parts[4] as string).split(' ').filter((p) => p.length > 0);
  return {
    sha: parts[0] as string,
    authorName: parts[1] as string,
    authorEmail: parts[2] as string,
    authoredAt: toUtc(parts[3] as string),
    parents,
    // A subject may itself contain the field separator, so everything after the
    // fifth field is subject rather than an extra field.
    subject: parts.slice(5).join('\x1f'),
    isMerge: parents.length > 1,
    files: parseFiles(body),
  };
}

/**
 * `--raw --numstat` prints every raw entry for a commit and then every numstat
 * entry (verified against git, see the fixture). The raw half carries the
 * status letter, which is the only thing that separates an add from a modify;
 * the numstat half carries the line counts.
 */
function parseFiles(body: string): FileChange[] {
  const fields = body.split('\0').filter((field) => field.length > 0);
  const statuses = new Map<string, string>();
  let i = 0;

  while (i < fields.length) {
    const match = RAW_ENTRY.exec(fields[i] as string);
    if (!match) break;
    const status = match[1] as string;
    i += 1;
    // A rename or copy names both paths; everything else names one.
    const paths = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const target = fields[i + paths - 1];
    if (target === undefined) {
      throw new GitLogParseError(`git log raw entry "${match[0]}" has no path`);
    }
    statuses.set(target, status);
    i += paths;
  }

  const files: FileChange[] = [];
  while (i < fields.length) {
    const field = fields[i] as string;
    const match = NUMSTAT_ENTRY.exec(field);
    if (!match) {
      throw new GitLogParseError(
        `expected a numstat entry, got ${JSON.stringify(field.slice(0, 120))}`,
      );
    }
    i += 1;

    let path = match[3] as string;
    let oldPath: string | null = null;
    if (path === '') {
      // A rename puts the pre- and post-image paths in the next two fields.
      const from = fields[i];
      const to = fields[i + 1];
      if (from === undefined || to === undefined) {
        throw new GitLogParseError('git log rename entry is missing one of its two paths');
      }
      oldPath = from;
      path = to;
      i += 2;
    }

    const binary = match[1] === '-';
    files.push({
      path,
      oldPath,
      insertions: binary ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      binary,
      status: statuses.get(path) ?? null,
    });
  }

  return files;
}

/**
 * Old repositories carry timestamps git will happily print and nothing will
 * parse. Dropping such a commit would lose real churn, so the raw string is
 * kept and the caller can see it is not an ISO date.
 */
function toUtc(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

export interface ReadCommitsOptions {
  repoPath: string;
  /** Anything `git log --since` accepts. Limits the window; never samples. */
  since?: string | undefined;
  /** Pathspecs to scope the log, used when --repo is below the git toplevel. */
  pathspec?: readonly string[] | undefined;
  /** Overridable so tests can drive a canned log without a git binary. */
  spawnGit?: SpawnGit | undefined;
}

export type SpawnGit = (args: string[]) => ReturnType<typeof spawn>;

export function gitLogArgs(options: ReadCommitsOptions): string[] {
  const args = [
    '-C',
    options.repoPath,
    'log',
    '--no-show-signature',
    '--encoding=UTF-8',
    '-M',
    '--numstat',
    '--raw',
    '-z',
    `--pretty=format:${LOG_FORMAT}`,
  ];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.pathspec && options.pathspec.length > 0) args.push('--', ...options.pathspec);
  return args;
}

/**
 * Stream a repository's commits, newest first.
 *
 * Streaming rather than buffering because a large repository's log runs to
 * hundreds of megabytes, and the miner only ever needs one commit at a time.
 */
export async function* readCommits(options: ReadCommitsOptions): AsyncGenerator<Commit> {
  const child = (options.spawnGit ?? defaultSpawnGit)(gitLogArgs(options));
  if (!child.stdout) throw new GitError('git produced no stdout stream');
  child.stdout.setEncoding('utf8');

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // Bounded: a failing git is terse, and a chatty one must not fill memory.
    if (stderr.length < 8192) stderr += chunk;
  });

  const exited = new Promise<number>((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });

  const parser = new GitLogParser();
  try {
    for await (const chunk of child.stdout) {
      yield* parser.push(chunk as string);
    }
    yield* parser.end();
  } finally {
    // A consumer that stops early must not leave git running.
    if (child.exitCode === null) child.kill();
  }

  const code = await exited;
  if (code !== 0) {
    throw new GitError(`git log exited with status ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
  }
}

function defaultSpawnGit(args: string[]): ReturnType<typeof spawn> {
  return spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Absolute path of the enclosing work tree, or null when there is not one. */
export function gitToplevel(repoPath: string): string | null {
  return gitOutput(repoPath, ['rev-parse', '--show-toplevel']);
}

/**
 * Paths tracked at HEAD, repo-relative with forward slashes.
 *
 * ADR-0011 keeps metrics to files that still exist: a deleted file has no
 * content to measure and coupling between two of them cannot be acted on.
 */
export function listTrackedFiles(repoPath: string): string[] {
  const out = gitOutput(repoPath, ['ls-files', '-z']);
  if (out === null) return [];
  return out.split('\0').filter((path) => path.length > 0);
}

/** True when the clone is shallow, and so has almost no history to mine. */
export function isShallowClone(repoPath: string): boolean {
  return gitOutput(repoPath, ['rev-parse', '--is-shallow-repository']) === 'true';
}

export function countCommits(repoPath: string): number | null {
  const out = gitOutput(repoPath, ['rev-list', '--count', 'HEAD']);
  if (out === null) return null;
  const count = Number(out);
  return Number.isInteger(count) ? count : null;
}

function gitOutput(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    }).replace(/\n$/, '');
  } catch {
    return null;
  }
}
