/**
 * Take the noise out of an AI fixer's edit before anyone reviews it —
 * ADR-0047. From the dddsample benchmark run: a correct fix arrived with two
 * import lines rewritten only in their line endings, which a reviewer must
 * read and dismiss.
 *
 * Only lines the edit did not really change are touched: a line whose text,
 * ignoring line ending and trailing whitespace, matches its counterpart in
 * the committed file gets the committed bytes back. New lines take the
 * file's own line ending. A file whose every difference is such noise is
 * restored whole. Nothing here alters what the code says.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git } from './git.js';

/** Largest changed region aligned line by line; beyond it only the edges are tidied. */
const MAX_REGION = 2500;

export interface TidyResult {
  /** Files restored whole: every change was whitespace or line endings. */
  restored: string[];
  /** Files whose unchanged lines got their original bytes back. */
  tidied: string[];
}

export function tidyEdit(repoPath: string, files: string[]): TidyResult {
  const result: TidyResult = { restored: [], tidied: [] };
  for (const file of files) {
    let before: string;
    try {
      // As checkout writes it to disk (line-ending filters applied), which is
      // what the fixer saw and changed; with core.autocrlf the stored blob
      // has LF while the file on disk has CRLF.
      before = git(repoPath, ['cat-file', '--filters', `HEAD:${file}`]);
    } catch {
      continue; // a new file: nothing to compare with
    }
    let after: string;
    try {
      after = readFileSync(join(repoPath, file), 'utf8');
    } catch {
      continue; // deleted
    }
    const tidied = tidyText(before, after);
    if (tidied === after) continue;
    writeFileSync(join(repoPath, file), tidied);
    if (tidied === before) result.restored.push(file);
    else result.tidied.push(file);
  }
  return result;
}

/** `after`, with every line it did not really change given back its bytes from `before`. */
export function tidyText(before: string, after: string): string {
  const old = splitKeepingEol(before);
  const now = splitKeepingEol(after);
  const key = (line: string) => line.replace(/[ \t]*\r?\n?$/, '');
  const eol = dominantEol(before);

  // Common prefix and suffix first: most edits are a small middle.
  let start = 0;
  while (start < old.length && start < now.length && key(old[start]!) === key(now[start]!)) start += 1;
  let endOld = old.length;
  let endNow = now.length;
  while (endOld > start && endNow > start && key(old[endOld - 1]!) === key(now[endNow - 1]!)) {
    endOld -= 1;
    endNow -= 1;
  }

  // A restored line keeps the edit's answer to "is a line break after me?"
  // (an edit may add lines after a last line that had none), with the
  // original's bytes otherwise.
  const restore = (original: string, edited: string): string => {
    const originalEnds = /\n$/.test(original);
    const editedEnds = /\n$/.test(edited);
    if (originalEnds === editedEnds) return original;
    return editedEnds ? `${original}${eol}` : original.replace(/\r?\n$/, '');
  };
  const prefix = old.slice(0, start).map((line, i) => restore(line, now[i]!));
  const suffix = old.slice(endOld).map((line, i) => restore(line, now[endNow + i]!));
  const middle = alignMiddle(old.slice(start, endOld), now.slice(start, endNow), key, eol, restore);
  return [...prefix, ...middle, ...suffix].join('');
}

function alignMiddle(
  old: string[],
  now: string[],
  key: (line: string) => string,
  eol: string,
  restore: (original: string, edited: string) => string,
): string[] {
  const withEol = (line: string) => (/\r?\n$/.test(line) ? line.replace(/\r?\n$/, eol) : line);
  if (old.length === 0 || now.length === 0 || old.length * now.length > MAX_REGION * MAX_REGION) {
    return now.map(withEol);
  }
  // Longest common subsequence on line text, then: matched lines keep their
  // original bytes, the rest are the edit's lines with the file's line ending.
  const n = old.length;
  const m = now.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = key(old[i]!) === key(now[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && key(old[i]!) === key(now[j]!)) {
      out.push(restore(old[i]!, now[j]!));
      i += 1;
      j += 1;
    } else if (i < n && table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1; // a line the edit removed
    } else {
      out.push(withEol(now[j]!));
      j += 1;
    }
  }
  return out;
}

function splitKeepingEol(text: string): string[] {
  return text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
