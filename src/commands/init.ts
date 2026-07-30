import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  CONFIG_FILENAME,
  DEFAULT_API_KEY_ENV,
  describeSource,
  loadConfig,
  LOCAL_CONFIG_FILENAME,
  userConfigPath,
  type ConfigOverrides,
  type StratigraphConfig,
} from '../config.js';
import { configTemplate } from '../config-template.js';
import { resolveCredential, type Credential } from '../interpret/client.js';
import { currentVersion, migrate, openDatabase } from '../db/database.js';
import { readHead } from '../db/run.js';
import { info, warn } from '../log.js';

export interface InitOptions extends ConfigOverrides {
  /**
   * Write `stratigraph.config.json` as well as the database.
   *
   * Off by default: `init` is also the migrate command, and a routine
   * re-run should not start dropping files into someone's directory.
   */
  writeConfig?: boolean | undefined;
}

export interface InitResult {
  dbPath: string;
  repoPath: string;
  schemaVersion: number;
  applied: number[];
  /** The config file this run created, if it created one. */
  configWritten: string | null;
}

/**
 * Create (or migrate) the fact store for a repository. Idempotent: running it
 * twice on the same database is a no-op the second time.
 */
export function runInit(overrides: InitOptions): InitResult {
  const config = loadConfig(overrides);
  const cwd = overrides.cwd ?? process.cwd();

  info(`repository  ${config.repoPath}`);
  info(`config      ${describeSource(config)}`);

  const configWritten = overrides.writeConfig ? writeConfigFile(config, cwd) : null;

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
    reportInterpretation(config, overrides.env ?? process.env);
    if (config.llm.sendSource) {
      warn('source bodies WILL be sent to the model API (--send-source is on)');
    }

    return {
      dbPath: config.dbPath,
      repoPath: config.repoPath,
      schemaVersion,
      applied: result.applied.map((m) => m.version),
      configWritten,
    };
  } finally {
    db.close();
  }
}

/**
 * Write a starter `stratigraph.config.json`, holding the defaults spelled out.
 *
 * Never overwrites: a config file is something someone edited, and silently
 * replacing it is unrecoverable. An existing file is reported and left alone.
 */
function writeConfigFile(config: StratigraphConfig, cwd: string): string | null {
  const path = join(cwd, CONFIG_FILENAME);
  if (existsSync(path)) {
    info(`config      ${short(path)} already exists — left untouched`);
    return null;
  }

  const repo = relative(cwd, config.repoPath) || '.';
  writeFileSync(path, configTemplate({ repo }), 'utf8');
  info(`config      wrote ${short(path)} (defaults, spelled out — edit as needed)`);
  info(`            commit it; put your key in ${LOCAL_CONFIG_FILENAME} instead`);
  return path;
}

/**
 * Whether the interpretation layer will do anything, said at the moment someone
 * sets the tool up rather than only when they later wonder why the report has
 * no names in it.
 */
function reportInterpretation(config: StratigraphConfig, env: NodeJS.ProcessEnv): void {
  if (!config.llm.enabled) {
    info('interpretation disabled — structural output only');
    return;
  }

  let credential: Credential | null = null;
  try {
    credential = resolveCredential(config.llm, env);
  } catch (err) {
    warn((err as Error).message);
    return;
  }

  if (credential === null) {
    info(`interpretation ${config.llm.model}, no credential yet — structural output only`);
    info(`            add one with: export ${DEFAULT_API_KEY_ENV}=sk-ant-...`);
    info(`            or: echo '{"llm":{"apiKey":"sk-ant-..."}}' > ${userConfigPath()}`);
    return;
  }
  info(`interpretation ${config.llm.model}, credential from ${credential.describe}`);
}

function short(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}
