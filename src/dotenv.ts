/**
 * `.env` loading, because everyone expects it to be there.
 *
 * Deliberately small: this reads `KEY=value` lines and nothing else. There is
 * no interpolation, no `export` keyword handling beyond stripping it, and no
 * multi-line values. A `.env` that needs more than this is doing something the
 * config file should be doing instead.
 *
 * A real value is never returned in any error or log — the whole reason people
 * put a `.env` in a repository directory is that it holds a key.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DOTENV_FILENAME = '.env';

export interface DotenvResult {
  /** Files that were read, nearest last, so later ones win. */
  files: string[];
  /** Names that were set. Never the values. */
  applied: string[];
}

/**
 * Parse `.env` text into pairs.
 *
 * Exported for tests: parsing is the part with edge cases, and it is a pure
 * function of a string.
 */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue; // no name, or no `=` at all: not a setting

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    // Quoted values keep whatever is inside, including `#`; unquoted ones stop
    // at an inline comment, which is what every other .env reader does.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }

    values.set(name, value);
  }

  return values;
}

/**
 * Load `.env` from the working directory and the repository into `env`.
 *
 * **A variable already set in the real environment always wins.** That is the
 * rule every other `.env` reader follows, and it is what makes CI work: the
 * pipeline exports a secret and a stray committed `.env` cannot quietly
 * override it.
 *
 * Directories are tried in order and the **first** to define a name wins, so
 * callers pass the working directory before the repository under analysis: a
 * `.env` beside the config you are running with beats one that happens to be
 * committed in the repository you are pointing at.
 */
export function loadDotenv(
  directories: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DotenvResult {
  const result: DotenvResult = { files: [], applied: [] };

  for (const directory of directories) {
    const path = join(directory, DOTENV_FILENAME);
    if (!existsSync(path)) continue;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // unreadable is the same as absent; nothing here is required
    }

    result.files.push(path);
    for (const [name, value] of parseDotenv(text)) {
      if (env[name] !== undefined) continue; // the real environment wins
      env[name] = value;
      if (!result.applied.includes(name)) result.applied.push(name);
    }
  }

  return result;
}
