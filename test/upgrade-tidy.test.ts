import { describe, expect, it } from 'vitest';

import { tidyText } from '../src/upgrade/tidy.js';

describe('tidyText (AI edits without the noise)', () => {
  it('gives an unchanged line back its original line ending (dddsample\'s imports)', () => {
    const before = 'package a;\r\n\r\nimport x.A;\r\nimport x.B;\r\n\r\nclass C {\r\n    int a;\r\n}\r\n';
    const after = 'package a;\n\nimport x.A;\nimport x.B;\n\nclass C {\n    int a;\n    int b;\n}\n';
    expect(tidyText(before, after)).toBe('package a;\r\n\r\nimport x.A;\r\nimport x.B;\r\n\r\nclass C {\r\n    int a;\r\n    int b;\r\n}\r\n');
  });

  it('restores trailing whitespace the edit stripped from lines it did not change', () => {
    const before = 'a  \nb\nc\t\n';
    const after = 'a\nb\nc\nd\n';
    expect(tidyText(before, after)).toBe('a  \nb\nc\t\nd\n');
  });

  it('returns the original exactly when every difference is noise', () => {
    const before = 'x\r\ny  \r\n';
    expect(tidyText(before, 'x\ny\n')).toBe(before);
  });

  it('keeps every real change: inserted, removed and edited lines', () => {
    const before = 'one\ntwo\nthree\nfour\n';
    const after = 'one\n2\nthree\nfive\n';
    expect(tidyText(before, after)).toBe(after);
  });

  it('follows the edit on the final newline', () => {
    expect(tidyText('a\nb\n', 'a\nb')).toBe('a\nb');
    expect(tidyText('a\nb', 'a\nb\nc\n')).toBe('a\nb\nc\n');
  });
});
