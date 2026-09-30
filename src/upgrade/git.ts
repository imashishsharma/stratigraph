/**
 * The upgrade's git discipline — ADR-0047: work on its own branch, commit
 * each layer separately, and undo a rejected attempt without touching
 * anything the user had in the tree.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

export function isGitRepo(repoPath: string): boolean {
  try {
    return git(repoPath, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** Tracked files with changes, staged or not. Untracked files do not count. */
export function trackedChanges(repoPath: string): string[] {
  return git(repoPath, ['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3));
}

/** Untracked, not ignored files. */
export function untracked(repoPath: string): Set<string> {
  return new Set(
    git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter((path) => path !== ''),
  );
}

export function head(repoPath: string): string {
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

export function currentBranch(repoPath: string): string {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export function branchExists(repoPath: string, name: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export function gitDir(repoPath: string): string {
  const dir = git(repoPath, ['rev-parse', '--git-dir']).trim();
  return isAbsolute(dir) ? dir : join(repoPath, dir);
}

/** Build output never belongs in an upgrade commit, even in a repo that forgot to ignore it. */
const BUILD_OUTPUT = /(^|\/)(target|node_modules|\.stratigraph)\//;

/**
 * Commit what the upgrade changed: modified tracked files, and new files that
 * were not already lying untracked when the run started. Returns the sha, or
 * null when there was nothing to commit.
 */
export function commitChanges(repoPath: string, message: string, preexisting: Set<string>): string | null {
  git(repoPath, ['add', '-u']);
  const fresh = [...untracked(repoPath)].filter((path) => !preexisting.has(path) && !BUILD_OUTPUT.test(path));
  for (let i = 0; i < fresh.length; i += 200) git(repoPath, ['add', '--', ...fresh.slice(i, i + 200)]);
  if (git(repoPath, ['diff', '--cached', '--name-only']).trim() === '') return null;
  git(repoPath, ['commit', '-q', '--no-verify', '-m', message]);
  return head(repoPath);
}

/**
 * Back to `sha`: tracked files reset, and files the attempt created removed.
 * Files that were untracked before the run are never touched.
 */
export function resetTo(repoPath: string, sha: string, preexisting: Set<string>): void {
  git(repoPath, ['reset', '-q', '--hard', sha]);
  for (const path of untracked(repoPath)) {
    if (preexisting.has(path) || BUILD_OUTPUT.test(path)) continue;
    rmSync(join(repoPath, path), { force: true });
  }
}

export function changedFiles(repoPath: string, from: string, to = 'HEAD'): string[] {
  return git(repoPath, ['diff', '--name-only', `${from}..${to}`])
    .split('\n')
    .filter((line) => line !== '');
}

/** Files the working tree changed since HEAD, including new ones not preexisting. */
export function dirtyFiles(repoPath: string, preexisting: Set<string>): string[] {
  const tracked = git(repoPath, ['diff', '--name-only', 'HEAD']).split('\n').filter((line) => line !== '');
  const fresh = [...untracked(repoPath)].filter((path) => !preexisting.has(path) && !BUILD_OUTPUT.test(path));
  return [...new Set([...tracked, ...fresh])].sort();
}

export function diffText(repoPath: string, from: string, to = 'HEAD'): string {
  return git(repoPath, ['diff', `${from}..${to}`]);
}
