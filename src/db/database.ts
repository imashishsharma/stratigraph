import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { MIGRATIONS, SCHEMA_VERSION, type Migration } from './migrations/index.js';

export type Db = Database.Database;

/**
 * The store a command needs does not exist yet.
 *
 * Its own type because every command that reads the store can hit it, and the
 * alternative is what shipped before: better-sqlite3's own `TypeError: Cannot
 * open database because the directory does not exist`, printed with a
 * commander stack trace, at the exact moment a first-time user forgets
 * `stratigraph init`.
 */
export class MissingStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingStoreError';
  }
}

/**
 * Fail with the command that would fix it, before better-sqlite3 fails without.
 *
 * `remedy` completes the sentence "no fact store at <path> — ", so it names the
 * commands in the order this particular one needs them.
 */
export function requireStore(path: string, remedy: string): void {
  if (path !== ':memory:' && !existsSync(path)) {
    throw new MissingStoreError(`no fact store at ${path} — ${remedy}`);
  }
}

export interface OpenOptions {
  /** Fail instead of creating the file if it does not exist. */
  mustExist?: boolean;
  readonly?: boolean;
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  if (!options.mustExist && !options.readonly && path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, {
    fileMustExist: options.mustExist ?? false,
    readonly: options.readonly ?? false,
  });
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: Migration[];
}

/**
 * Apply every migration newer than the database's current version, each in its
 * own transaction. `user_version` is the source of truth; `schema_migration` is
 * the human-readable log.
 */
export function migrate(db: Db): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const from = currentVersion(db);
  const applied: Migration[] = [];

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= from) continue;
    const run = db.transaction(() => {
      db.exec(migration.up);
      db.prepare(
        'INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
    applied.push(migration);
  }

  return { from, to: currentVersion(db), applied };
}

export function currentVersion(db: Db): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  return rows[0]?.user_version ?? 0;
}

/** Throws if the database was written by a newer version of the tool. */
export function assertSchemaCurrent(db: Db): void {
  const version = currentVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than this build supports (${SCHEMA_VERSION}); upgrade the tool`,
    );
  }
  if (version < SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is older than ${SCHEMA_VERSION}; run \`stratigraph init\` to migrate`,
    );
  }
}
