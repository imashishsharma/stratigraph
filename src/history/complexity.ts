/**
 * The complexity proxy: total indentation.
 *
 * Not cyclomatic complexity, and it does not claim to be. Indentation tracks
 * nesting and nesting tracks branching, which is enough to rank files against
 * one another — Tornhill's observation, and it holds up well enough to be worth
 * the nothing it costs.
 *
 * The reason for a proxy rather than a real measure is coverage. History covers
 * every file in the repository, and the files that turn up in a coupling pair
 * are very often the ones no extractor parses: XML wiring, SQL migrations,
 * properties files, shell scripts. A measure that needs a parser would score
 * exactly the files layer 2 already understands and leave the rest at zero.
 *
 * Nothing here is a fact about the code's structure — see ADR-0010. It is
 * arithmetic over whitespace, and it is stored in a column the schema names a
 * proxy.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * Spaces per indent level when a file gives no step to learn its own from.
 * Most files do: see `indentUnit`.
 */
export const SPACES_PER_INDENT = 4;

/** Above this, the file is almost certainly generated or vendored. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How much of a file is examined for the NUL byte that marks it binary. */
const BINARY_SNIFF_BYTES = 8192;

export interface Measurement {
  /** Sum of indent depth over non-blank lines. Null when the file was not measured. */
  complexity: number | null;
  /** Non-blank lines counted. Zero when the file was not measured. */
  lines: number;
  /** Spaces per level this file was measured in; null when it has no space indentation. */
  indentUnit: number | null;
  /** Why it was not measured, or null when it was. */
  skipped: 'binary' | 'too-large' | 'unreadable' | null;
}

/**
 * Indent depth summed over non-blank lines, in the file's own indent unit.
 *
 * A tab is one level. Spaces are divided by the file's unit and floored, so a
 * continuation line lined up under an opening bracket does not score as deeply
 * as a real nesting level would. The unit is learned per file (ADR-0031): a
 * 2-space TypeScript file measured in 4-space levels scores half what the same
 * nesting in Java does, and the ranking then compares indentation styles
 * rather than files.
 *
 * Comments are counted like any other line. Skipping them would mean knowing
 * the language, and a heavily commented file genuinely is more to read.
 */
export function indentationComplexity(text: string): {
  complexity: number;
  lines: number;
  indentUnit: number | null;
} {
  const indents: Array<{ tabs: number; spaces: number }> = [];

  for (const line of text.split('\n')) {
    let tabs = 0;
    let spaces = 0;
    let i = 0;
    for (; i < line.length; i += 1) {
      const char = line[i];
      if (char === '\t') tabs += 1;
      else if (char === ' ') spaces += 1;
      else break;
    }
    // Everything after the indent is whitespace — a blank line, or a line of
    // trailing spaces, or a bare CR from a CRLF file. Neither is code.
    if (line.slice(i).trim().length === 0) continue;
    indents.push({ tabs, spaces });
  }

  const unit = indentUnit(indents.map((indent) => indent.spaces));
  let complexity = 0;
  for (const { tabs, spaces } of indents) {
    complexity += tabs + Math.floor(spaces / (unit ?? SPACES_PER_INDENT));
  }
  return { complexity, lines: indents.length, indentUnit: unit };
}

/**
 * The most common positive step between consecutive space indents, 1..8;
 * the smaller on a tie. Aligned continuation lines produce scattered odd
 * steps, and a mode is not moved by scatter. Null when nothing is indented
 * with spaces; the documented width when something is but no step shows.
 */
function indentUnit(spaces: readonly number[]): number | null {
  if (!spaces.some((n) => n > 0)) return null;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const current of spaces) {
    const step = current - previous;
    if (step >= 1 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = current;
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [step, count] of [...steps].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = step;
      bestCount = count;
    }
  }
  return best ?? SPACES_PER_INDENT;
}

/**
 * Measure a file on disk, or say why it was not measured.
 *
 * Returns null rather than a number for anything it cannot honestly measure.
 * A binary file has no indentation, and scoring it zero would rank it as the
 * simplest thing in the repository rather than as unmeasured.
 */
export function measureFile(absolutePath: string): Measurement {
  let size: number;
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return { complexity: null, lines: 0, indentUnit: null, skipped: 'unreadable' };
    size = stats.size;
  } catch {
    return { complexity: null, lines: 0, indentUnit: null, skipped: 'unreadable' };
  }

  if (size > MAX_FILE_BYTES) return { complexity: null, lines: 0, indentUnit: null, skipped: 'too-large' };

  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    return { complexity: null, lines: 0, indentUnit: null, skipped: 'unreadable' };
  }

  if (isBinary(buffer)) return { complexity: null, lines: 0, indentUnit: null, skipped: 'binary' };

  return { ...indentationComplexity(buffer.toString('utf8')), skipped: null };
}

/** git's own heuristic: a NUL byte near the start means binary. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
