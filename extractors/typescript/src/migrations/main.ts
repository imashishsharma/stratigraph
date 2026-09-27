#!/usr/bin/env node
/**
 * Entry point for the migrations extractor (ADR-0037).
 *
 * Reads Liquibase changelogs (XML/YAML/JSON/formatted SQL), Flyway `V*.sql`
 * scripts and standalone DDL (`schema*.sql`, `ddl.sql`, `*.ddl`) and emits the
 * schema they leave behind: tables, columns and foreign keys, each cited at
 * the change that created it. Same command line and protocol as the other
 * extractors (ADR-0001, ADR-0003).
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FactEmitter, type LineSink } from '../protocol.js';
import { LiquibaseReader, type ChangelogHost } from './liquibase.js';
import { key, SchemaState } from './schema.js';
import { applySql } from './sql.js';

export const EXTRACTOR = 'migrations';
export const VERSION = '1.0.0';

const DEFAULT_EXCLUDES = ['node_modules', 'target', 'build', 'dist', '.git', '.idea', '.gradle'];

/** The same directories `src/files/roles.ts` calls migrations; a test keeps the two equal. */
export const MIGRATION_DIRS = ['db/changelog/', 'db/migration/', 'db/migrations/', 'liquibase/', 'flyway/'];

/** Standalone DDL: `schema.sql`, `schema-postgres.sql`, `ddl.sql`, `x.ddl`. */
export const DDL_NAME = /^(?:(?:schema|ddl)(?:[-_.][\w.-]*)?\.sql|[\w.-]+\.ddl)$/i;

const TEST_SEGMENT = /(^|\/)(src\/test|src\/it|src\/integrationTest|test|tests|__tests__)\//;

export function isMigrationPath(path: string): boolean {
  if (TEST_SEGMENT.test(path)) return false;
  const name = posix.basename(path);
  if (DDL_NAME.test(name)) return true;
  if (!/\.(sql|xml|ya?ml|json)$/i.test(name)) return false;
  return MIGRATION_DIRS.some((dir) => `/${path}`.includes(`/${dir}`));
}

export interface Streams {
  stdout: LineSink;
  stderr: LineSink;
}

export async function run(argv: string[], streams: Streams): Promise<number> {
  let repo: string | null = null;
  const excludes = new Set(DEFAULT_EXCLUDES);
  const includes: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') repo = argv[++i] ?? null;
    else if (arg === '--exclude') excludes.add(argv[++i] ?? '');
    else if (arg === '--include') includes.push(argv[++i] ?? '');
    else if (arg === '--version') {
      streams.stderr.write(`${EXTRACTOR} extractor ${VERSION}`);
      return 0;
    } else {
      streams.stderr.write(`error: unknown argument ${arg}`);
      return 2;
    }
  }
  if (repo === null) {
    streams.stderr.write('error: --repo is required');
    return 2;
  }
  const repoRoot = resolve(repo);
  const emitter = new FactEmitter(streams.stdout);
  emitter.meta(EXTRACTOR, VERSION, repoRoot);

  const files = walk(repoRoot, excludes, includes).filter(isMigrationPath);
  streams.stderr.write(`discovered ${files.length} migration file(s)`);
  extract(repoRoot, files, emitter);
  streams.stderr.write(emitter.summary());
  return 0;
}

/** Apply every migration in tool order, then emit the resulting schema. */
export function extract(repoRoot: string, files: string[], emitter: FactEmitter): void {
  const state = new SchemaState();
  const texts = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!texts.has(path)) {
      try {
        texts.set(path, readFileSync(join(repoRoot, path), 'utf8'));
      } catch {
        texts.set(path, null);
      }
    }
    return texts.get(path) ?? null;
  };
  const inventory = new Set(files);
  const emitted = new Set<string>();

  const host: ChangelogHost = {
    read,
    resolve: (from, reference, relativeToChangelog) => resolveReference(inventory, from, reference, relativeToChangelog),
    list: (from, directory, relativeToChangelog) => {
      const base = resolveDirectory(from, directory, relativeToChangelog);
      return [...inventory].filter((path) => base.some((dir) => path.startsWith(dir))).sort();
    },
    seen: (path, language) => {
      if (emitted.has(path)) return;
      emitted.add(path);
      emitter.file(path, language, (read(path) ?? '').split('\n').length);
    },
    warn: (message, file, line) => emitter.diagnostic('warn', message, file, line),
  };

  const changelogs = files.filter((path) => /\.(xml|ya?ml|json)$/i.test(path) && /databaseChangeLog/.test(read(path) ?? ''));
  const included = new Set<string>();
  for (const path of changelogs) {
    for (const reference of references(read(path) ?? '')) {
      const target = resolveReference(inventory, path, reference.file, reference.relative);
      if (target !== null) included.add(target);
    }
    for (const dir of directoryReferences(read(path) ?? '')) {
      for (const base of resolveDirectory(path, dir.path, dir.relative)) {
        for (const candidate of inventory) if (candidate.startsWith(base)) included.add(candidate);
      }
    }
  }

  const liquibase = new LiquibaseReader(state, host);
  const roots = changelogs.filter((path) => !included.has(path)).sort(byDepthThenPath);
  for (const root of roots) liquibase.read(root);
  for (const path of changelogs) liquibase.read(path); // anything unreachable from a root, in path order

  const sql = files.filter((path) => /\.(sql|ddl)$/i.test(path) && !included.has(path) && !emitted.has(path));
  const flyway = sql.filter((path) => /^(V[\d._]+|R)__/i.test(posix.basename(path)));
  const other = sql.filter((path) => !flyway.includes(path)).sort();
  for (const path of flyway.sort(byFlywayVersion)) {
    host.seen(path, 'sql');
    applySql(state, read(path) ?? '', path);
  }
  for (const path of other) {
    host.seen(path, 'sql');
    applySql(state, read(path) ?? '', path);
  }

  for (const table of state.tables.values()) {
    const tableFqn = key(table.name);
    emitter.node({
      kind: 'table',
      fqn: tableFqn,
      name: table.name,
      file: table.site.file,
      startLine: table.site.line,
      attrs: { source: 'migration' },
    });
    for (const column of table.columns.values()) {
      emitter.node({
        kind: 'column',
        fqn: `${tableFqn}#${key(column.name)}`,
        name: column.name,
        parent: { kind: 'table', fqn: tableFqn },
        file: column.site.file,
        startLine: column.site.line,
        attrs: {
          ...(column.type === null ? {} : { type: column.type }),
          ...(column.primaryKey ? { primaryKey: true } : {}),
          ...(column.nullable === null ? {} : { nullable: column.nullable }),
        },
      });
    }
  }
  for (const table of state.tables.values()) {
    const tableFqn = key(table.name);
    for (const fk of table.foreignKeys) {
      const first = fk.columns[0];
      const src =
        first !== undefined && table.columns.has(key(first))
          ? { kind: 'column' as const, fqn: `${tableFqn}#${key(first)}` }
          : { kind: 'table' as const, fqn: tableFqn };
      emitter.edge({
        kind: 'references',
        src,
        dst: { kind: 'table', fqn: key(fk.table) },
        file: fk.site.file,
        line: fk.site.line,
        attrs: { columns: fk.columns, refColumns: fk.refColumns },
      });
    }
  }
}

/** `include file=` references in a changelog, however it is written. */
function references(text: string): Array<{ file: string; relative: boolean }> {
  const out: Array<{ file: string; relative: boolean }> = [];
  for (const match of text.matchAll(/<include\b([^>]*)>/g)) {
    const attrs = match[1] ?? '';
    const file = /\bfile\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    if (file) out.push({ file, relative: /relativeToChangelogFile\s*=\s*["']true["']/.test(attrs) });
  }
  for (const match of text.matchAll(/["']?file["']?\s*:\s*["']?([^"'\n,}]+)["']?/g)) {
    out.push({ file: (match[1] as string).trim(), relative: /relativeToChangelogFile["']?\s*:\s*["']?true/.test(text) });
  }
  return out;
}

function directoryReferences(text: string): Array<{ path: string; relative: boolean }> {
  const out: Array<{ path: string; relative: boolean }> = [];
  for (const match of text.matchAll(/<includeAll\b([^>]*)>/g)) {
    const attrs = match[1] ?? '';
    const path = /\bpath\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    if (path) out.push({ path, relative: /relativeToChangelogFile\s*=\s*["']true["']/.test(attrs) });
  }
  return out;
}

/** Where Liquibase would look for `reference` from `from`, among the files we have. */
export function resolveReference(
  inventory: ReadonlySet<string>,
  from: string,
  reference: string,
  relativeToChangelog: boolean,
): string | null {
  const ref = reference.replace(/^classpath\*?:/, '').replace(/^\/+/, '');
  const candidates: string[] = [];
  const fromDir = posix.dirname(from);
  if (relativeToChangelog) candidates.push(posix.normalize(posix.join(fromDir, ref)));
  const resources = resourcesRoot(from);
  if (resources !== null) candidates.push(posix.normalize(posix.join(resources, ref)));
  candidates.push(posix.normalize(ref));
  candidates.push(posix.normalize(posix.join(fromDir, ref)));
  for (const candidate of candidates) if (inventory.has(candidate)) return candidate;
  // Last resort: a unique file in the inventory whose path ends with the reference.
  const suffix = [...inventory].filter((path) => path.endsWith(`/${ref}`) || path === ref);
  return suffix.length === 1 ? (suffix[0] as string) : null;
}

function resolveDirectory(from: string, directory: string, relativeToChangelog: boolean): string[] {
  const dir = directory.replace(/^classpath\*?:/, '').replace(/^\/+/, '').replace(/\/?$/, '/');
  const out: string[] = [];
  if (relativeToChangelog) out.push(posix.normalize(posix.join(posix.dirname(from), dir)).replace(/\/?$/, '/'));
  const resources = resourcesRoot(from);
  if (resources !== null) out.push(posix.normalize(posix.join(resources, dir)).replace(/\/?$/, '/'));
  out.push(dir);
  return out;
}

/** `a/src/main/resources/` for a path under a Maven/Gradle resources root. */
function resourcesRoot(path: string): string | null {
  const index = path.indexOf('src/main/resources/');
  return index < 0 ? null : path.slice(0, index + 'src/main/resources/'.length);
}

function byDepthThenPath(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Flyway order: versioned by version number, then repeatable, then the rest. */
function byFlywayVersion(a: string, b: string): number {
  const va = flywayVersion(posix.basename(a));
  const vb = flywayVersion(posix.basename(b));
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const d = (va[i] ?? -1) - (vb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function flywayVersion(name: string): number[] {
  const match = /^V([\d._]+)__/i.exec(name);
  if (match) return (match[1] as string).split(/[._]/).filter(Boolean).map(Number);
  return /^R__/i.test(name) ? [Number.MAX_SAFE_INTEGER] : [Number.MAX_SAFE_INTEGER, 1];
}

function walk(repoRoot: string, excludes: Set<string>, includes: string[]): string[] {
  const out: string[] = [];
  const queue = [repoRoot];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludes.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        const path = relative(repoRoot, full).split('\\').join('/');
        if (includes.length === 0 || includes.some((prefix) => path.startsWith(prefix))) out.push(path);
      }
    }
  }
  return out.sort();
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/* c8 ignore start */
if (isEntryPoint()) {
  const streams: Streams = {
    stdout: { write: (line) => process.stdout.write(`${line}\n`) },
    stderr: { write: (line) => process.stderr.write(`${line}\n`) },
  };
  try {
    process.exitCode = await run(process.argv.slice(2), streams);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
