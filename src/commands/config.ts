/**
 * `stratigraph config` — answer "where does this setting come from?" and
 * "where do I put my key?" without anyone hand-editing JSON.
 *
 * Both questions have well-defined answers in `config.ts`; the only reason they
 * were hard was that nothing printed them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_API_KEY_ENV,
  loadConfig,
  LOCAL_CONFIG_FILENAME,
  userConfigPath,
  type ConfigOverrides,
} from '../config.js';
import { userConfigTemplate } from '../config-template.js';
import { DOTENV_FILENAME } from '../dotenv.js';
import { resolveCredential, type Credential } from '../interpret/client.js';
import { print } from '../log.js';

export interface ConfigPathEntry {
  path: string;
  /** What this file is for, in one phrase. */
  role: string;
  exists: boolean;
  /** Whether an `llm.apiKey` may live in it. */
  mayHoldKey: boolean;
}

export interface ConfigPathsResult {
  entries: ConfigPathEntry[];
  credential: Credential | null;
  /** Set when resolving the credential failed, e.g. an unreadable key file. */
  credentialError: string | null;
  model: string;
}

/**
 * Every file that can affect a run, weakest first, whether or not it exists.
 *
 * Listing the absent ones is the point: someone asking this question usually
 * needs to know what to *create*, and a list of only the files that already
 * exist answers a different question.
 */
export function runConfigPaths(overrides: ConfigOverrides): ConfigPathsResult {
  const config = loadConfig(overrides);
  const cwd = overrides.cwd ?? process.cwd();
  const user = userConfigPath(overrides.env ?? process.env);

  const entries: ConfigPathEntry[] = [
    { path: user, role: 'you, every repository', exists: existsSync(user), mayHoldKey: true },
    {
      path: join(cwd, CONFIG_FILENAME),
      role: 'this project, committed',
      exists: existsSync(join(cwd, CONFIG_FILENAME)),
      mayHoldKey: false,
    },
    {
      path: join(cwd, LOCAL_CONFIG_FILENAME),
      role: 'this project, your machine',
      exists: existsSync(join(cwd, LOCAL_CONFIG_FILENAME)),
      mayHoldKey: true,
    },
    {
      path: join(cwd, DOTENV_FILENAME),
      role: `environment, e.g. ${DEFAULT_API_KEY_ENV}`,
      exists: existsSync(join(cwd, DOTENV_FILENAME)),
      mayHoldKey: true,
    },
  ];

  let credential: Credential | null = null;
  let credentialError: string | null = null;
  try {
    credential = resolveCredential(config.llm);
  } catch (err) {
    credentialError = (err as Error).message;
  }

  report(entries, config.llm.model, credential, credentialError);
  return { entries, credential, credentialError, model: config.llm.model };
}

function report(
  entries: readonly ConfigPathEntry[],
  model: string,
  credential: Credential | null,
  credentialError: string | null,
): void {
  const width = Math.max(...entries.map((entry) => entry.path.length));

  print('Files that configure a run, weakest first. Later ones win.');
  print('');
  for (const entry of entries) {
    print(
      `${entry.exists ? 'found  ' : 'absent '} ${entry.path.padEnd(width)}  ${entry.role}` +
        `${entry.mayHoldKey ? '' : '  (no key here)'}`,
    );
  }

  print('');
  print(`model        ${model}`);
  if (credentialError !== null) {
    print(`credential   error: ${credentialError}`);
  } else if (credential === null) {
    print('credential   none found — interpretation will be skipped');
    print('');
    print(`Set one with:  stratigraph config set-key sk-ant-...`);
    print(`or:            export ${DEFAULT_API_KEY_ENV}=sk-ant-...`);
  } else {
    print(`credential   ${credential.describe}`);
  }
}

export interface SetKeyResult {
  path: string;
  /** Whether an existing key was replaced rather than added. */
  replaced: boolean;
}

/**
 * Write the key into the user config, creating the file and its directory.
 *
 * Into the user config rather than a project file, because that is the one that
 * is outside every repository and therefore cannot be committed by accident.
 * Existing settings in the file are preserved — this edits one value.
 */
export function runConfigSetKey(
  apiKey: string,
  overrides: ConfigOverrides = {},
): SetKeyResult {
  const key = apiKey.trim();
  if (key.length === 0) {
    throw new ConfigError('a key is required: stratigraph config set-key sk-ant-...');
  }

  const path = userConfigPath(overrides.env ?? process.env);
  mkdirSync(dirname(path), { recursive: true });

  let existing: Record<string, unknown> = {};
  let replaced = false;
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError(`${path}: expected a JSON object`);
      }
      existing = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      // Refuse rather than overwrite: the file has something in it, and
      // replacing settings nobody can read back is not a recoverable mistake.
      throw new ConfigError(
        `${path}: not valid JSON (${(err as Error).message}) — fix or delete it first`,
      );
    }
    const llm = existing['llm'];
    replaced =
      typeof llm === 'object' && llm !== null && (llm as Record<string, unknown>)['apiKey'] !== undefined;
  }

  const llm =
    typeof existing['llm'] === 'object' && existing['llm'] !== null
      ? (existing['llm'] as Record<string, unknown>)
      : {};
  const updated = { ...existing, llm: { ...llm, apiKey: key } };

  // 0600: this file holds a credential, and the default umask would leave it
  // world-readable on a shared machine.
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  print(`${replaced ? 'Replaced' : 'Wrote'} llm.apiKey in ${path}`);
  print('Check it with: stratigraph doctor');
  return { path, replaced };
}

/** The template, for anyone who wants to write the file themselves. */
export { userConfigTemplate };
