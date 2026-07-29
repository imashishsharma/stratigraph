import { relative } from 'node:path';

import { describeSource, loadConfig, type ConfigOverrides } from '../config.js';
import { currentVersion, migrate, openDatabase } from '../db/database.js';
import { readHead } from '../db/run.js';
import { info, warn } from '../log.js';

export interface InitResult {
  dbPath: string;
  repoPath: string;
  schemaVersion: number;
  applied: number[];
}

/**
 * Create (or migrate) the fact store for a repository. Idempotent: running it
 * twice on the same database is a no-op the second time.
 */
export function runInit(overrides: ConfigOverrides): InitResult {
  const config = loadConfig(overrides);

  info(`repository  ${config.repoPath}`);
  if (config.source || config.localSource) info(`config      ${describeSource(config)}`);

  const head = readHead(config.repoPath);
  if (head) {
    info(`head        ${head.slice(0, 12)}`);
  } else {
    warn(
      `${config.repoPath} is not a git repository — history mining will be unavailable`,
    );
  }

  const db = openDatabase(config.dbPath);
  try {
    const result = migrate(db);
    const schemaVersion = currentVersion(db);
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    info(`database    ${short(config.dbPath)}`);
    info(
      result.applied.length > 0
        ? `schema      v${schemaVersion} (applied ${result.applied.map((m) => m.name).join(', ')})`
        : `schema      v${schemaVersion} (already current)`,
    );
    info(`tables      ${tables.length}: ${tables.join(', ')}`);
    info(`interpretation ${config.llm.enabled ? 'enabled' : 'disabled (--no-llm)'}`);
    if (config.llm.sendSource) {
      warn('source bodies WILL be sent to the model API (--send-source is on)');
    }

    return {
      dbPath: config.dbPath,
      repoPath: config.repoPath,
      schemaVersion,
      applied: result.applied.map((m) => m.version),
    };
  } finally {
    db.close();
  }
}

function short(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}
