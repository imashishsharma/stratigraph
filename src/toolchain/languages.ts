import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Which extractors a repository needs.
 *
 * A monolith with a Spring backend and an Angular frontend in one tree is the
 * shape this tool was written for, and its cross-stack edges only exist if both
 * extractors write into the **same run** — nodes are scoped by `run_id`, so two
 * runs cannot be joined. Detection is therefore about which extractors to put
 * into one run, not about which of two separate analyses to perform.
 */

/**
 * `migrations` runs first so a table a migration creates is declared with its
 * file and line before a JPA mapping refers to it (ADR-0037): the store keeps a
 * node's first declaration.
 */
export const LANGUAGES = ['migrations', 'java', 'typescript'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * One extractor, two languages.
 *
 * `.kt` selects the same jar as `.java` because one jar parses both: the Kotlin
 * LST is built from the same elements and is walked by the same visitor
 * (ADR-0029). The distinction survives where it matters — every `file` fact
 * records `java` or `kotlin` individually — but there is no second process to
 * choose between here.
 *
 * `.kts` is absent deliberately. A `build.gradle.kts` is a build script, and
 * the extractor reads it as a module's identity rather than as a declaration
 * site (ADR-0006).
 */
const JAVA_EXTENSIONS = ['.java', '.kt'];

/**
 * Migration and DDL files, by the same directory rule as `src/files/roles.ts`
 * and `extractors/typescript/src/migrations/main.ts` (a test keeps all three
 * equal): changelogs and scripts under a migration directory, and standalone
 * `schema*.sql` / `ddl.sql` / `*.ddl` files. Test resources are not the
 * application's schema.
 */
const MIGRATION_DIRS = ['db/changelog/', 'db/migration/', 'db/migrations/', 'liquibase/', 'flyway/'];
const DDL_NAME = /^(?:[\w.-]*schema[\w.-]*\.sql|ddl(?:[-_.][\w.-]*)?\.sql|[\w.-]+\.ddl)$/i;
const TEST_SEGMENT = /(^|\/)(src\/test|src\/it|src\/integrationTest|test|tests|__tests__)\//;

function isMigration(path: string): boolean {
  if (TEST_SEGMENT.test(path)) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (DDL_NAME.test(name) || /^V\d+(?:[._]\d+)*__.+\.sql$/.test(name)) return true;
  // Any other SQL may be DDL, which only its content says; selecting the
  // extractor for it costs one read of a few files (ADR-0037).
  if (/\.sql$/i.test(name)) return true;
  if (!/\.(sql|xml|ya?ml|json)$/i.test(name)) return false;
  return MIGRATION_DIRS.some((dir) => `/${path}`.includes(`/${dir}`));
}
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * Walk until every language has been seen once, then stop.
 *
 * A full walk of a large monorepo to answer a yes/no question would cost more
 * than the extraction it precedes, and both extractors do their own discovery
 * anyway. The cap is a backstop for a repository where one language sits in a
 * corner nothing reaches early — it errs towards running an extractor that
 * finds nothing, which costs a few seconds, rather than skipping one that would
 * have found something, which costs a whole stack.
 */
const MAX_DIRECTORIES = 20_000;

export function detectLanguages(
  repoPath: string,
  excludedDirectories: readonly string[] = [],
): Set<Language> {
  const excluded = new Set(excludedDirectories);
  const found = new Set<Language>();
  const queue: string[] = [repoPath];
  let visited = 0;

  while (queue.length > 0 && found.size < LANGUAGES.length && visited < MAX_DIRECTORIES) {
    const dir = queue.shift()!;
    visited += 1;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) queue.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        const language = extractorFor(relative(repoPath, join(dir, entry.name)).split('\\').join('/'));
        if (language !== null) found.add(language);
      }
    }
  }

  return found;
}

/**
 * Which extractor would parse a file, by name alone; null for neither. The same
 * test decides detection and the denominator of an extractor's coverage
 * (ADR-0033), so the two cannot disagree about what counts as a source.
 */
export function extractorFor(path: string): Language | null {
  if (isMigration(path)) return 'migrations';
  if (JAVA_EXTENSIONS.some((ext) => path.endsWith(ext))) return 'java';
  if (!path.endsWith('.d.ts') && TYPESCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return 'typescript';
  }
  return null;
}

/** What a user may type for a language, and which extractor it selects. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  sql: 'migrations',
  liquibase: 'migrations',
  flyway: 'migrations',
  kotlin: 'java',
  kt: 'java',
  jvm: 'java',
};

/** Parse `--lang`. `all` means both, regardless of what is on disk. */
export function parseLanguages(value: string): Set<Language> | 'all' {
  if (value === 'all') return 'all';
  const requested = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    // `kotlin` and `kt` name the same extractor as `java`, so both are accepted
    // rather than rejected as unknown — a Kotlin user reaching for `--lang
    // kotlin` is asking a reasonable question and should not get an error.
    .map((part) => ALIASES[part] ?? part);

  const languages = new Set<Language>();
  for (const part of requested) {
    if (!(LANGUAGES as readonly string[]).includes(part)) {
      throw new Error(
        `unknown language "${part}" — expected one of ${LANGUAGES.join(', ')}, ` +
          `${Object.keys(ALIASES).join(', ')}, or all`,
      );
    }
    languages.add(part as Language);
  }
  return languages;
}
