import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseGitLog } from '../src/history/git-log.js';
import { RenameChain } from '../src/history/renames.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function fixtureLog(): string {
  return readFileSync(join(REPO_ROOT, 'fixtures', 'git-log', 'mixed.log.txt'), 'utf8')
    .replaceAll('<SOH>', '\x01')
    .replaceAll('<US>', '\x1f')
    .replaceAll('<NUL>', '\x00');
}

describe('RenameChain', () => {
  it('leaves a path it never saw alone', () => {
    expect(new RenameChain().canonical('src/A.java')).toBe('src/A.java');
  });

  it('resolves a chain to the current name in one lookup', () => {
    // Fed newest-first, as git emits: c is the name today, a is the oldest.
    const chain = new RenameChain();
    chain.record('b', 'c');
    chain.record('a', 'b');

    expect(chain.canonical('a')).toBe('c');
    expect(chain.canonical('b')).toBe('c');
    expect(chain.canonical('c')).toBe('c');
  });

  it('resolves a long chain without walking it at read time', () => {
    const chain = new RenameChain();
    for (let i = 99; i >= 0; i -= 1) chain.record(`p${i}`, `p${i + 1}`);
    expect(chain.canonical('p0')).toBe('p100');
  });

  it('does not alias a path to itself when a rename is undone', () => {
    // Newest-first: b was renamed back to a, and before that a had been
    // renamed to b. The file is called `a` today, so `a` must stay `a`.
    const chain = new RenameChain();
    chain.record('b', 'a');
    chain.record('a', 'b');

    expect(chain.canonical('a')).toBe('a');
    expect(chain.canonical('b')).toBe('a');
  });

  it('counts only the paths it superseded', () => {
    const chain = new RenameChain();
    chain.record('b', 'c');
    chain.record('a', 'b');
    expect(chain.size).toBe(2);
  });
});

describe('RenameChain over the captured log', () => {
  const commits = parseGitLog(fixtureLog());
  const chain = new RenameChain();
  for (const commit of commits) {
    for (const file of commit.files) {
      if (file.oldPath !== null) chain.record(file.oldPath, file.path);
    }
  }

  it('follows alpha through gamma to delta', () => {
    // Two renames, two commits apart, resolved by one backwards pass.
    expect(chain.canonical('src/alpha.txt')).toBe('src/delta.txt');
    expect(chain.canonical('src/gamma.txt')).toBe('src/delta.txt');
  });

  it('follows a directory rename with spaces in both names', () => {
    expect(chain.canonical('docs/old notes/read me.md')).toBe('docs/new notes/read me.md');
  });

  it('merges a path that was deleted and later reused, as ADR-0009 records', () => {
    // src/side.txt was added on a branch, deleted, then re-created with
    // unrelated content. Git reports no rename, so nothing here can separate
    // the two lives — they share a path, and anything keyed by path merges
    // them. This over-reports one file's history and cannot invent an edge in
    // the static graph, which is the property that matters. Asserted so the
    // limitation stays pinned rather than being rediscovered as a bug.
    expect(chain.canonical('src/side.txt')).toBe('src/side.txt');

    const touching = commits.filter((c) => c.files.some((f) => f.path === 'src/side.txt'));
    expect(touching.map((c) => c.subject)).toEqual([
      'reuse the side path for something else',
      'delete side',
      'add side on a branch',
    ]);
  });

  it('leaves files that were never renamed alone', () => {
    expect(chain.canonical('src/beta.txt')).toBe('src/beta.txt');
    expect(chain.canonical('src/café.txt')).toBe('src/café.txt');
  });
});
