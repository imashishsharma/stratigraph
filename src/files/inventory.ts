/**
 * Which files the repository holds — the denominator every coverage ratio is
 * taken over (ADR-0033), and the set `file_role` classifies (ADR-0030).
 *
 * In a git work tree that is `git ls-files`: what is tracked, not what happens
 * to be lying in the directory. Outside one it is a walk, pruned the same way
 * the extractors prune theirs, so a tarball still gets a denominator rather
 * than a coverage of nothing over nothing.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { gitToplevel, listTrackedFiles } from '../history/git-log.js';
import { inScope, type PathScope } from '../history/paths.js';

export interface RepoFiles {
  source: 'git' | 'walk';
  /** Repo-relative, forward slashes, in scope, sorted. */
  files: string[];
}

export function listRepoFiles(repoPath: string, scope: PathScope): RepoFiles {
  if (gitToplevel(repoPath) !== null) {
    return {
      source: 'git',
      files: listTrackedFiles(repoPath)
        .filter((path) => inScope(path, scope))
        .sort(),
    };
  }
  return { source: 'walk', files: walk(repoPath, scope) };
}

function walk(repoPath: string, scope: PathScope): string[] {
  const found: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(repoPath, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && !scope.exclude.has(entry.name)) queue.push(path);
      } else if (entry.isFile() && inScope(path, scope)) {
        found.push(path);
      }
    }
  }
  return found.sort();
}
