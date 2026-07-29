import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_FILENAME = 'stratigraph.config.json';

export interface LlmConfig {
  /** Interpretation layer. The whole pipeline must work with this off. */
  enabled: boolean;
  model: string | null;
  /**
   * Send raw source bodies to the model. Off by default, loudly logged when on.
   * Structural metadata is sent regardless when `enabled` is true.
   */
  sendSource: boolean;
}

export interface JavaConfig {
  /**
   * JDK home used to run the Java extractor. Null means "discover it".
   * The published package never assumes the machine's default JDK.
   */
  home: string | null;
  /**
   * Path to the extractor jar. Null means "look in the usual places"
   * (see `src/toolchain/extractor-jar.ts`).
   */
  jar: string | null;
}

/**
 * Knobs that decide whether the coupling report is signal or noise. Every one
 * of them, and the failure it prevents, is recorded in ADR-0011.
 */
export interface HistoryConfig {
  /** Anything `git log --since` accepts. Null mines the whole history. */
  since: string | null;
  /**
   * Commits touching more than this many files take no part in coupling. One
   * repo-wide reformat otherwise couples everything it touched.
   */
  maxFilesPerCommit: number;
  /** A pair must co-change at least this often to be reported. */
  minShared: number;
  /** Each file must have changed at least this often, or the ratio is an artefact. */
  minCommits: number;
}

export const DEFAULT_HISTORY: HistoryConfig = {
  since: null,
  maxFilesPerCommit: 50,
  minShared: 5,
  minCommits: 5,
};

export interface StratigraphConfig {
  /** Absolute path to the repository under analysis. */
  repoPath: string;
  /** Absolute path to the fact store. Never inside the analysed repo by default. */
  dbPath: string;
  /** Glob-ish path prefixes to analyse. Empty means "everything". */
  include: string[];
  exclude: string[];
  llm: LlmConfig;
  java: JavaConfig;
  history: HistoryConfig;
  /** Where the config came from, for `stratigraph init` to report. */
  source: string | null;
}

export interface ConfigOverrides {
  repo?: string | undefined;
  db?: string | undefined;
  config?: string | undefined;
  llm?: boolean | undefined;
  sendSource?: boolean | undefined;
  javaHome?: string | undefined;
  extractorJar?: string | undefined;
  since?: string | undefined;
  maxFilesPerCommit?: number | undefined;
  cwd?: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_EXCLUDES = [
  'node_modules',
  'target',
  'build',
  'dist',
  '.git',
  '.idea',
  '.gradle',
];

const KNOWN_KEYS = new Set(['repo', 'db', 'include', 'exclude', 'llm', 'java', 'history']);
const KNOWN_LLM_KEYS = new Set(['enabled', 'model', 'sendSource']);
const KNOWN_JAVA_KEYS = new Set(['home', 'jar']);
const KNOWN_HISTORY_KEYS = new Set(['since', 'maxFilesPerCommit', 'minShared', 'minCommits']);

/**
 * Precedence: CLI flags > config file > defaults.
 *
 * The config file is looked up as `--config`, then `<cwd>/stratigraph.config.json`,
 * then `<repo>/stratigraph.config.json`.
 */
export function loadConfig(overrides: ConfigOverrides = {}): StratigraphConfig {
  const cwd = overrides.cwd ?? process.cwd();
  const fromCli = overrides.repo;

  const explicitConfig = overrides.config ? absolute(overrides.config, cwd) : null;
  if (explicitConfig && !existsSync(explicitConfig)) {
    throw new ConfigError(`config file not found: ${explicitConfig}`);
  }

  const candidateRepo = fromCli ? absolute(fromCli, cwd) : cwd;
  const configPath =
    explicitConfig ??
    firstExisting([join(cwd, CONFIG_FILENAME), join(candidateRepo, CONFIG_FILENAME)]);

  const file = configPath ? readConfigFile(configPath) : {};

  const repoRaw = fromCli ?? file.repo ?? cwd;
  const repoBase = configPath && !fromCli ? dirOf(configPath) : cwd;
  const repoPath = absolute(repoRaw, repoBase);

  if (!existsSync(repoPath)) {
    throw new ConfigError(`repository path does not exist: ${repoPath}`);
  }
  if (!statSync(repoPath).isDirectory()) {
    throw new ConfigError(`repository path is not a directory: ${repoPath}`);
  }

  const dbRaw = overrides.db ?? file.db ?? join('.stratigraph', `${basename(repoPath)}.db`);
  const dbBase = overrides.db ? cwd : configPath && file.db ? dirOf(configPath) : cwd;

  return {
    repoPath,
    dbPath: absolute(dbRaw, dbBase),
    include: file.include ?? [],
    exclude: file.exclude ?? DEFAULT_EXCLUDES,
    llm: {
      enabled: overrides.llm ?? file.llm?.enabled ?? true,
      model: file.llm?.model ?? null,
      sendSource: overrides.sendSource ?? file.llm?.sendSource ?? false,
    },
    java: {
      home: overrides.javaHome ?? file.java?.home ?? null,
      jar: overrides.extractorJar ?? file.java?.jar ?? null,
    },
    history: {
      since: overrides.since ?? file.history?.since ?? DEFAULT_HISTORY.since,
      maxFilesPerCommit:
        overrides.maxFilesPerCommit ??
        file.history?.maxFilesPerCommit ??
        DEFAULT_HISTORY.maxFilesPerCommit,
      minShared: file.history?.minShared ?? DEFAULT_HISTORY.minShared,
      minCommits: file.history?.minCommits ?? DEFAULT_HISTORY.minCommits,
    },
    source: configPath,
  };
}

interface ConfigFile {
  repo?: string;
  db?: string;
  include?: string[];
  exclude?: string[];
  llm?: { enabled?: boolean; model?: string; sendSource?: boolean };
  java?: { home?: string; jar?: string };
  history?: {
    since?: string;
    maxFilesPerCommit?: number;
    minShared?: number;
    minCommits?: number;
  };
}

function readConfigFile(path: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path}: not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(
        `${path}: unknown key "${key}" (expected ${[...KNOWN_KEYS].join(', ')})`,
      );
    }
  }

  const out: ConfigFile = {};
  if (obj['repo'] !== undefined) out.repo = expectString(path, 'repo', obj['repo']);
  if (obj['db'] !== undefined) out.db = expectString(path, 'db', obj['db']);
  if (obj['include'] !== undefined)
    out.include = expectStringArray(path, 'include', obj['include']);
  if (obj['exclude'] !== undefined)
    out.exclude = expectStringArray(path, 'exclude', obj['exclude']);

  if (obj['llm'] !== undefined) {
    const llm = obj['llm'];
    if (typeof llm !== 'object' || llm === null || Array.isArray(llm)) {
      throw new ConfigError(`${path}: "llm" must be an object`);
    }
    const llmObj = llm as Record<string, unknown>;
    for (const key of Object.keys(llmObj)) {
      if (!KNOWN_LLM_KEYS.has(key)) {
        throw new ConfigError(`${path}: unknown key "llm.${key}"`);
      }
    }
    out.llm = {};
    if (llmObj['enabled'] !== undefined)
      out.llm.enabled = expectBoolean(path, 'llm.enabled', llmObj['enabled']);
    if (llmObj['model'] !== undefined)
      out.llm.model = expectString(path, 'llm.model', llmObj['model']);
    if (llmObj['sendSource'] !== undefined)
      out.llm.sendSource = expectBoolean(path, 'llm.sendSource', llmObj['sendSource']);
  }

  if (obj['java'] !== undefined) {
    const java = obj['java'];
    if (typeof java !== 'object' || java === null || Array.isArray(java)) {
      throw new ConfigError(`${path}: "java" must be an object`);
    }
    const javaObj = java as Record<string, unknown>;
    for (const key of Object.keys(javaObj)) {
      if (!KNOWN_JAVA_KEYS.has(key)) {
        throw new ConfigError(`${path}: unknown key "java.${key}"`);
      }
    }
    out.java = {};
    if (javaObj['home'] !== undefined)
      out.java.home = expectString(path, 'java.home', javaObj['home']);
    if (javaObj['jar'] !== undefined)
      out.java.jar = expectString(path, 'java.jar', javaObj['jar']);
  }

  if (obj['history'] !== undefined) {
    const history = obj['history'];
    if (typeof history !== 'object' || history === null || Array.isArray(history)) {
      throw new ConfigError(`${path}: "history" must be an object`);
    }
    const historyObj = history as Record<string, unknown>;
    for (const key of Object.keys(historyObj)) {
      if (!KNOWN_HISTORY_KEYS.has(key)) {
        throw new ConfigError(`${path}: unknown key "history.${key}"`);
      }
    }
    out.history = {};
    if (historyObj['since'] !== undefined)
      out.history.since = expectString(path, 'history.since', historyObj['since']);
    if (historyObj['maxFilesPerCommit'] !== undefined)
      out.history.maxFilesPerCommit = expectPositiveInteger(
        path,
        'history.maxFilesPerCommit',
        historyObj['maxFilesPerCommit'],
      );
    if (historyObj['minShared'] !== undefined)
      out.history.minShared = expectPositiveInteger(
        path,
        'history.minShared',
        historyObj['minShared'],
      );
    if (historyObj['minCommits'] !== undefined)
      out.history.minCommits = expectPositiveInteger(
        path,
        'history.minCommits',
        historyObj['minCommits'],
      );
  }

  return out;
}

function expectPositiveInteger(path: string, key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${path}: "${key}" must be a positive integer`);
  }
  return value;
}

function expectString(path: string, key: string, value: unknown): string {
  if (typeof value !== 'string') throw new ConfigError(`${path}: "${key}" must be a string`);
  return value;
}

function expectBoolean(path: string, key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(`${path}: "${key}" must be a boolean`);
  return value;
}

function expectStringArray(path: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`${path}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

function absolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function dirOf(filePath: string): string {
  return resolve(filePath, '..');
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
