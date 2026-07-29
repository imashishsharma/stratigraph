import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  indentationComplexity,
  MAX_FILE_BYTES,
  measureFile,
  SPACES_PER_INDENT,
} from '../src/history/complexity.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-complexity-'));
}

function write(name: string, content: string | Buffer): string {
  const path = join(scratch(), name);
  writeFileSync(path, content);
  return path;
}

describe('indentationComplexity', () => {
  it('scores a flat file zero rather than declining to score it', () => {
    // Zero is a real answer: the file has no nesting.
    expect(indentationComplexity('package a;\nclass A {}\n')).toEqual({
      complexity: 0,
      lines: 2,
    });
  });

  it('counts one level per four spaces, flooring the remainder', () => {
    const text = ['no indent', '    one', '        two', '      one and a half'].join('\n');
    // 0 + 1 + 2 + 1: a continuation line lined up under a bracket must not
    // score as deeply as a real nesting level.
    expect(indentationComplexity(text)).toEqual({ complexity: 4, lines: 4 });
  });

  it('counts one level per tab', () => {
    expect(indentationComplexity('a\n\tb\n\t\t\tc\n')).toEqual({ complexity: 4, lines: 3 });
  });

  it('adds tabs and spaces together on a mixed line', () => {
    expect(indentationComplexity('\t\t    x')).toEqual({ complexity: 3, lines: 1 });
  });

  it('ignores blank and whitespace-only lines', () => {
    // A file padded with deeply indented blank lines is not complex.
    expect(indentationComplexity('a\n\n        \n\t\t\n    b\n')).toEqual({
      complexity: 1,
      lines: 2,
    });
  });

  it('is not fooled by CRLF line endings', () => {
    // The bare CR must not count as content, or every blank line in a
    // Windows-authored file becomes a counted line.
    expect(indentationComplexity('a\r\n\r\n    b\r\n')).toEqual({ complexity: 1, lines: 2 });
  });

  it('handles an empty file', () => {
    expect(indentationComplexity('')).toEqual({ complexity: 0, lines: 0 });
  });

  it('counts comments like any other line', () => {
    // Skipping them would mean knowing the language, and a heavily commented
    // file genuinely is more to read.
    expect(indentationComplexity('    // a comment\n    code();')).toEqual({
      complexity: 2,
      lines: 2,
    });
  });

  it('uses the documented indent width', () => {
    expect(SPACES_PER_INDENT).toBe(4);
  });
});

describe('measureFile', () => {
  it('measures a text file', () => {
    const path = write('A.java', 'class A {\n    void run() {\n        go();\n    }\n}\n');
    expect(measureFile(path)).toEqual({ complexity: 4, lines: 5, skipped: null });
  });

  it('refuses to score a binary file rather than calling it simple', () => {
    // Scoring it zero would rank a jar as the least complex thing in the
    // repository. Null says "not measured", which is the truth.
    const path = write('blob.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
    expect(measureFile(path)).toEqual({ complexity: null, lines: 0, skipped: 'binary' });
  });

  it('measures a file whose NUL byte is beyond the sniff window', () => {
    // Only the start is examined, as git does. A text file stays measurable.
    const path = write('long.txt', `${'    x\n'.repeat(4000)}\0`);
    expect(measureFile(path).skipped).toBeNull();
  });

  it('refuses to score a file too large to be hand-written', () => {
    const path = write('generated.ts', 'x\n'.repeat(MAX_FILE_BYTES));
    expect(measureFile(path)).toEqual({ complexity: null, lines: 0, skipped: 'too-large' });
  });

  it('reports a missing file as unreadable rather than throwing', () => {
    // A file tracked at HEAD can still be absent from the work tree — a sparse
    // checkout, or a case-insensitive filesystem collision. One such file must
    // not abort mining the repository.
    expect(measureFile(join(scratch(), 'nope.java'))).toEqual({
      complexity: null,
      lines: 0,
      skipped: 'unreadable',
    });
  });

  it('reports a directory as unreadable', () => {
    expect(measureFile(scratch()).skipped).toBe('unreadable');
  });
});
