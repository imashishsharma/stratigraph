import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GitLogParser,
  GitLogParseError,
  parseGitLog,
  type Commit,
} from '../src/history/git-log.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The fixture writes git's three invisible separator bytes as escapes so that a
 * reviewer can see, in a diff, what the parser is being held to. See
 * `fixtures/git-log/README.md`.
 */
function decode(escaped: string): string {
  return escaped
    .replaceAll('<SOH>', '\x01')
    .replaceAll('<US>', '\x1f')
    .replaceAll('<NUL>', '\x00');
}

function fixture(name: string): string {
  return decode(readFileSync(join(REPO_ROOT, 'fixtures', 'git-log', name), 'utf8'));
}

const MIXED = fixture('mixed.log.txt');

describe('the captured fixture', () => {
  it('reaches the test with its bytes intact', () => {
    // In this stream a newline separates a commit header from its diff; it is
    // structure, not text. Git's default `core.autocrlf` on Windows rewrites
    // it on checkout, which leaves a stray CR on every subject and makes ten
    // assertions below fail in ways that all look like parser bugs.
    // `.gitattributes` marks the file `-text`; this fails first, and names it.
    expect(MIXED.includes('\r'), 'fixture was checked out with CRLF — see .gitattributes').toBe(
      false,
    );
  });
});

function bySubject(commits: Commit[], subject: string): Commit {
  const found = commits.find((c) => c.subject === subject);
  if (!found) throw new Error(`no commit with subject "${subject}"`);
  return found;
}

describe('parseGitLog', () => {
  const commits = parseGitLog(MIXED);

  it('reads every commit, newest first', () => {
    expect(commits).toHaveLength(14);
    expect(commits[0]?.subject).toBe('reuse the side path for something else');
    expect(commits[13]?.subject).toBe('add alpha and beta');
  });

  it('reads the header fields', () => {
    expect(bySubject(commits, 'add a non-ascii path')).toMatchObject({
      sha: '37f790c8c57f60bed3095c2c0099c2914fb9c7d3',
      authorName: 'Ada Probe',
      authorEmail: 'ada@example.invalid',
      authoredAt: '2024-01-12T10:00:00.000Z',
      parents: ['36bb1f26931dfa26e26ebf953d3c0b159361f316'],
      isMerge: false,
    });
  });

  it('records a root commit as having no parents', () => {
    // The empty %P field must not become a parent named ''.
    expect(bySubject(commits, 'add alpha and beta').parents).toEqual([]);
  });

  it('reads several files from one commit', () => {
    expect(bySubject(commits, 'add alpha and beta').files).toEqual([
      { path: 'src/alpha.txt', oldPath: null, insertions: 3, deletions: 0, binary: false, status: 'A' },
      { path: 'src/beta.txt', oldPath: null, insertions: 1, deletions: 0, binary: false, status: 'A' },
    ]);
  });

  it('marks a merge and reads both parents', () => {
    const merge = bySubject(commits, 'merge side into main');
    expect(merge.isMerge).toBe(true);
    expect(merge.parents).toEqual([
      '68801186c57bd4a99d7a7a07c8ea64ac0a9d5125',
      'a6f57c5b8143de4ba5a789e4f55b9af2b010185b',
    ]);
    // git prints no diff for a merge unless asked, so a merge carries no files
    // and cannot double-count. ADR-0011 excludes them explicitly anyway.
    expect(merge.files).toEqual([]);
  });

  it('handles a commit with an empty subject and no files', () => {
    // Nothing separates the header from the body here — there is no newline at
    // all — which is the case a naive split-on-newline parser gets wrong.
    const empty = commits.find((c) => c.sha.startsWith('36bb1f26'));
    expect(empty).toMatchObject({ subject: '', files: [] });
  });

  it('reads a pure rename as one file with both names', () => {
    expect(bySubject(commits, 'rename alpha to gamma').files).toEqual([
      {
        path: 'src/gamma.txt',
        oldPath: 'src/alpha.txt',
        insertions: 0,
        deletions: 0,
        binary: false,
        status: 'R100',
      },
    ]);
  });

  it('reads a rename with an edit, keeping the counts and the similarity score', () => {
    expect(bySubject(commits, 'rename gamma to delta and edit').files).toEqual([
      {
        path: 'src/delta.txt',
        oldPath: 'src/gamma.txt',
        insertions: 1,
        deletions: 0,
        binary: false,
        status: 'R073',
      },
    ]);
  });

  it('keeps spaces in paths on both sides of a rename', () => {
    // Without -z git C-quotes these, and the quoting is what a hand-rolled
    // parser silently gets wrong.
    expect(bySubject(commits, 'rename the spaced directory').files).toEqual([
      {
        path: 'docs/new notes/read me.md',
        oldPath: 'docs/old notes/read me.md',
        insertions: 0,
        deletions: 0,
        binary: false,
        status: 'R100',
      },
    ]);
  });

  it('keeps a non-ascii path verbatim', () => {
    expect(bySubject(commits, 'add a non-ascii path').files[0]?.path).toBe('src/café.txt');
  });

  it('reports a binary file as binary with zero counts rather than guessing', () => {
    // numstat prints `-` for both counts. Reading that as 0 churn is correct;
    // inventing a line count from the byte size would not be.
    expect(bySubject(commits, 'add a binary file').files).toEqual([
      { path: 'src/blob.bin', oldPath: null, insertions: 0, deletions: 0, binary: true, status: 'A' },
    ]);
  });

  it('distinguishes add, modify and delete by git status rather than by counts', () => {
    // +1/-0 and +0/-1 do not say which is an add and which is a delete; the
    // raw status letter does, which is why the log asks for both.
    expect(bySubject(commits, 'delete beta').files[0]).toMatchObject({
      status: 'D',
      insertions: 0,
      deletions: 1,
    });
    expect(bySubject(commits, 'add side on a branch').files[0]).toMatchObject({ status: 'A' });
    expect(bySubject(commits, 'edit delta on main').files[0]).toMatchObject({ status: 'M' });
  });

  it('normalises the author date to UTC', () => {
    const offset =
      '\x01' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1fZoe\x1fz@example.invalid\x1f' +
      '2024-03-01T09:30:00+05:30\x1f\x1fsubject\x00';
    expect(parseGitLog(offset)[0]?.authoredAt).toBe('2024-03-01T04:00:00.000Z');
  });

  it('passes an unparseable date through rather than dropping the commit', () => {
    // Genuinely old repositories carry broken timestamps, and losing the commit
    // loses real churn. Keeping the string as git gave it is the honest option.
    const bad =
      '\x01' +
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1fZoe\x1fz@example.invalid\x1f' +
      'not-a-date\x1f\x1fsubject\x00';
    expect(parseGitLog(bad)[0]?.authoredAt).toBe('not-a-date');
  });

  it('returns nothing for empty input', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('rejects a record whose header is short rather than filling in blanks', () => {
    expect(() => parseGitLog('\x01' + 'c'.repeat(40) + '\x1fonly\x1ftwo\x00')).toThrow(
      GitLogParseError,
    );
  });
});

describe('GitLogParser streaming', () => {
  it('produces the same commits however the stream is chopped up', () => {
    // The reader gets whatever chunk sizes the OS hands it, and a record
    // boundary lands mid-chunk far more often than not.
    const whole = parseGitLog(MIXED);

    for (const size of [1, 7, 64, 500, MIXED.length * 2]) {
      const parser = new GitLogParser();
      const streamed: Commit[] = [];
      for (let i = 0; i < MIXED.length; i += size) {
        streamed.push(...parser.push(MIXED.slice(i, i + size)));
      }
      streamed.push(...parser.end());
      expect(streamed, `chunk size ${size}`).toEqual(whole);
    }
  });

  it('holds back a record until it is complete', () => {
    const parser = new GitLogParser();
    const head = '\x01' + 'd'.repeat(40) + '\x1fZoe\x1fz@example.invalid\x1f';
    expect(parser.push(head)).toEqual([]);
    expect(parser.push('2024-01-01T00:00:00Z\x1f\x1fsubject\x00')).toEqual([]);
    expect(parser.end()).toHaveLength(1);
  });

  it('does not treat a \\x01 inside a subject as a record boundary', () => {
    // A commit message can contain any byte. The sentinel only counts when it
    // is followed by a sha and a field separator.
    const text =
      '\x01' +
      'e'.repeat(40) +
      '\x1fZoe\x1fz@example.invalid\x1f2024-01-01T00:00:00Z\x1f\x1fbefore\x01after\x00';
    const commits = parseGitLog(text);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('before\x01after');
  });
});
