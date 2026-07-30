import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

import { loadDotenv } from './dotenv.js';

export const CONFIG_FILENAME = 'stratigraph.config.json';

/**
 * Per-person settings, merged over `stratigraph.config.json`.
 *
 * The shared file describes the project and belongs in version control. This
 * one describes the machine it is running on — a model choice, a credential —
 * and belongs in `.gitignore`. Keeping them apart is what lets a team commit
 * one config and still let each person point at their own key.
 */
export const LOCAL_CONFIG_FILENAME = 'stratigraph.config.local.json';

export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Settings for one person across every repository they analyse.
 *
 * Without this, someone who installed the package globally has to create a
 * config in whatever directory they happen to run from, and re-paste their key
 * each time. This is where a key and a preferred model live once. It sits
 * outside every repository, so an inline key is safe here.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env['STRATIGRAPH_CONFIG_HOME'] ??
    (process.platform === 'win32'
      ? join(env['APPDATA'] ?? homedir(), 'stratigraph')
      : join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'stratigraph'));
  return join(base, 'config.json');
}

export interface LlmConfig {
  /** Interpretation layer. The whole pipeline must work with this off. */
  enabled: boolean;
  /** Model id for the interpretation layer. Recorded on every row it writes. */
  model: string;
  /**
   * The key itself. Accepted from the two files that are never committed —
   * `stratigraph.config.local.json` and the user config — and refused in the
   * shared `stratigraph.config.json`. See `readConfigFile`.
   */
  apiKey: string | null;
  /** Which file supplied `apiKey`, so `doctor` can name it rather than guess. */
  apiKeySource: string | null;
  /** A file containing the key, so no secret is in any config file at all. */
  apiKeyFile: string | null;
  /** Which environment variable holds the key. */
  apiKeyEnv: string;
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

/**
 * Layer 4. Every knob here changes the partition, and therefore which findings
 * exist, so `analyze` prints the values it used — see ADR-0012.
 */
export interface InterpretConfig {
  /**
   * What one unit of normalised co-change weighs against one unit of normalised
   * structural dependency. At 0 the clustering is purely structural.
   */
  couplingWeight: number;
  /** Smallest cluster worth describing. Smaller ones are still stored. */
  minClusterSize: number;
  /** Cap on clusters sent to the model, so a huge repository cannot run away. */
  maxClusters: number;
}

export const DEFAULT_INTERPRET: InterpretConfig = {
  couplingWeight: 1,
  minClusterSize: 2,
  maxClusters: 25,
};

/** Used when `llm.enabled` and nothing more specific was configured. */
export const DEFAULT_MODEL = 'claude-opus-5';

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
  interpret: InterpretConfig;
  /** The shared config file, if one was found. */
  source: string | null;
  /** The per-project, per-machine overrides file, if one was found. */
  localSource: string | null;
  /** The per-person file under the user config directory, if one was found. */
  userSource: string | null;
  /** `.env` files that were loaded into the environment, if any. */
  dotenvFiles: string[];
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
  model?: string | undefined;
  couplingWeight?: number | undefined;
  cwd?: string | undefined;
  /** Environment to resolve the user config directory from. Injected by tests. */
  env?: NodeJS.ProcessEnv | undefined;
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

const KNOWN_KEYS = new Set([
  'repo',
  'db',
  'include',
  'exclude',
  'llm',
  'java',
  'history',
  'interpret',
]);
const KNOWN_LLM_KEYS = new Set([
  'enabled',
  'model',
  'apiKey',
  'apiKeyFile',
  'apiKeyEnv',
  'sendSource',
]);
const KNOWN_JAVA_KEYS = new Set(['home', 'jar']);
const KNOWN_HISTORY_KEYS = new Set(['since', 'maxFilesPerCommit', 'minShared', 'minCommits']);
const KNOWN_INTERPRET_KEYS = new Set(['couplingWeight', 'minClusterSize', 'maxClusters']);

/**
 * Precedence, highest first:
 *
 *   CLI flags
 *   stratigraph.config.local.json   this machine, this project  (gitignored)
 *   stratigraph.config.json         this project, everyone      (committed)
 *   ~/.config/stratigraph/config.json   this person, every project
 *   defaults
 *
 * The two project files are looked up in the working directory first, then in
 * the repository being analysed. The user file is where a globally installed
 * copy keeps a credential, and is deliberately the weakest of the three: a
 * project's committed choices should win over a personal default, and anything
 * a person wants to override for one project goes in the local file.
 */
export function loadConfig(overrides: ConfigOverrides = {}): StratigraphConfig {
  const cwd = overrides.cwd ?? process.cwd();
  const env = overrides.env ?? process.env;
  const fromCli = overrides.repo;

  const explicitConfig = overrides.config ? absolute(overrides.config, cwd) : null;
  if (explicitConfig && !existsSync(explicitConfig)) {
    throw new ConfigError(`config file not found: ${explicitConfig}`);
  }

  const candidateRepo = fromCli ? absolute(fromCli, cwd) : cwd;
  const sharedPath =
    explicitConfig ??
    firstExisting([join(cwd, CONFIG_FILENAME), join(candidateRepo, CONFIG_FILENAME)]);

  // Alongside the shared file when there is one, otherwise looked up the same
  // way — so a person with no project config can still keep local settings.
  // Never the same file twice: `--config` may point straight at the local one.
  const localCandidate = firstExisting(
    sharedPath
      ? [join(dirOf(sharedPath), LOCAL_CONFIG_FILENAME)]
      : [join(cwd, LOCAL_CONFIG_FILENAME), join(candidateRepo, LOCAL_CONFIG_FILENAME)],
  );
  const localPath = localCandidate === sharedPath ? null : localCandidate;

  // Outside every repository, so an inline key is safe here. Skipped when
  // `--config` names it, so it is never read twice.
  const userPath = firstExisting([userConfigPath(env)]);
  const userConfig = userPath === null || userPath === sharedPath ? null : userPath;

  const configPath = sharedPath ?? localPath ?? userConfig;
  const userFile = userConfig ? readConfigFile(userConfig, { allowInlineKey: true }) : {};
  const sharedFile = sharedPath
    ? readConfigFile(sharedPath, { allowInlineKey: isLocalConfig(sharedPath) })
    : {};
  const localFile = localPath ? readConfigFile(localPath, { allowInlineKey: true }) : {};
  const file = mergeConfigFiles(userFile, sharedFile, localFile);

  // Which file's key won, so `doctor` names the one to edit. Same precedence
  // as the merge, so this cannot disagree with the value actually in use.
  const apiKeySource =
    (localFile.llm?.apiKey && localPath) ||
    (sharedFile.llm?.apiKey && sharedPath) ||
    (userFile.llm?.apiKey && userConfig) ||
    null;

  const repoRaw = fromCli ?? file.repo ?? cwd;
  const repoBase = configPath && !fromCli ? dirOf(configPath) : cwd;
  const repoPath = absolute(repoRaw, repoBase);

  if (!existsSync(repoPath)) {
    throw new ConfigError(`repository path does not exist: ${repoPath}`);
  }
  if (!statSync(repoPath).isDirectory()) {
    throw new ConfigError(`repository path is not a directory: ${repoPath}`);
  }

  // Loaded once the repository is known, and before anything reads a
  // credential. This *mutates* `env` — which for the default `process.env` is
  // the whole point, and is what every other .env reader does. A name already
  // set in the real environment always wins, so a committed .env cannot
  // override a secret CI exported.
  const dotenv = loadDotenv([cwd, repoPath], env);

  const dbRaw = overrides.db ?? file.db ?? join('.stratigraph', `${basename(repoPath)}.db`);
  const dbBase = overrides.db ? cwd : configPath && file.db ? dirOf(configPath) : cwd;

  return {
    repoPath,
    dbPath: absolute(dbRaw, dbBase),
    include: file.include ?? [],
    exclude: file.exclude ?? DEFAULT_EXCLUDES,
    llm: {
      enabled: overrides.llm ?? file.llm?.enabled ?? true,
      model: overrides.model ?? file.llm?.model ?? DEFAULT_MODEL,
      apiKey: file.llm?.apiKey ?? null,
      apiKeySource,
      apiKeyFile: file.llm?.apiKeyFile
        ? absolute(expandHome(file.llm.apiKeyFile), configPath ? dirOf(configPath) : cwd)
        : null,
      apiKeyEnv: file.llm?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
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
    interpret: {
      couplingWeight:
        overrides.couplingWeight ??
        file.interpret?.couplingWeight ??
        DEFAULT_INTERPRET.couplingWeight,
      minClusterSize: file.interpret?.minClusterSize ?? DEFAULT_INTERPRET.minClusterSize,
      maxClusters: file.interpret?.maxClusters ?? DEFAULT_INTERPRET.maxClusters,
    },
    source: sharedPath,
    localSource: localPath,
    userSource: userConfig,
    dotenvFiles: dotenv.files,
  };
}

/** Which files were read, weakest first, for `init` and `doctor` to report. */
export function describeSource(config: StratigraphConfig): string {
  const files = [config.userSource, config.source, config.localSource].filter(
    (path) => path !== null,
  );
  const described =
    files.length > 0 ? files.join(' + ') : `defaults (no ${CONFIG_FILENAME} found)`;
  return config.dotenvFiles.length > 0
    ? `${described} (+ ${config.dotenvFiles.join(', ')})`
    : described;
}

/** Later files win, key by key, over earlier ones. */
function mergeConfigFiles(...files: ConfigFile[]): ConfigFile {
  return files.reduce((merged, file) => ({
    ...merged,
    ...file,
    llm: { ...merged.llm, ...file.llm },
    java: { ...merged.java, ...file.java },
    history: { ...merged.history, ...file.history },
    interpret: { ...merged.interpret, ...file.interpret },
  }));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') || path.startsWith(`~${sep}`)
    ? join(homedir(), path.slice(2))
    : path;
}

interface ConfigFile {
  repo?: string;
  db?: string;
  include?: string[];
  exclude?: string[];
  llm?: {
    enabled?: boolean;
    model?: string;
    apiKey?: string;
    apiKeyFile?: string;
    apiKeyEnv?: string;
    sendSource?: boolean;
  };
  java?: { home?: string; jar?: string };
  history?: {
    since?: string;
    maxFilesPerCommit?: number;
    minShared?: number;
    minCommits?: number;
  };
  interpret?: {
    couplingWeight?: number;
    minClusterSize?: number;
    maxClusters?: number;
  };
}

function readConfigFile(path: string, options: { allowInlineKey: boolean }): ConfigFile {
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
  if (isSet(obj['repo'])) out.repo = expectString(path, 'repo', obj['repo']);
  if (isSet(obj['db'])) out.db = expectString(path, 'db', obj['db']);
  if (isSet(obj['include']))
    out.include = expectStringArray(path, 'include', obj['include']);
  if (isSet(obj['exclude']))
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
    if (isSet(llmObj['enabled']))
      out.llm.enabled = expectBoolean(path, 'llm.enabled', llmObj['enabled']);
    if (isSet(llmObj['model']))
      out.llm.model = expectString(path, 'llm.model', llmObj['model']);
    if (isSet(llmObj['apiKey'])) {
      // The shared config describes the project and belongs in version
      // control; a key in it is a key in the repository's history, and by the
      // time anyone notices it has to be rotated rather than deleted. Refused
      // rather than warned about, because a warning scrolls past.
      if (!options.allowInlineKey) {
        throw new ConfigError(
          `${path}: "llm.apiKey" must not go in ${CONFIG_FILENAME} — that file is meant ` +
            `to be committed. Put it in ${LOCAL_CONFIG_FILENAME} next to it (and add ` +
            `that to .gitignore), or in ${userConfigPath()}, or point "llm.apiKeyFile" ` +
            `at a file holding the key, or set ${DEFAULT_API_KEY_ENV}.`,
        );
      }
      out.llm.apiKey = expectString(path, 'llm.apiKey', llmObj['apiKey']);
    }
    if (isSet(llmObj['apiKeyFile']))
      out.llm.apiKeyFile = expectString(path, 'llm.apiKeyFile', llmObj['apiKeyFile']);
    if (isSet(llmObj['apiKeyEnv']))
      out.llm.apiKeyEnv = expectString(path, 'llm.apiKeyEnv', llmObj['apiKeyEnv']);
    if (isSet(llmObj['sendSource']))
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
    if (isSet(javaObj['home']))
      out.java.home = expectString(path, 'java.home', javaObj['home']);
    if (isSet(javaObj['jar']))
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
    if (isSet(historyObj['since']))
      out.history.since = expectString(path, 'history.since', historyObj['since']);
    if (isSet(historyObj['maxFilesPerCommit']))
      out.history.maxFilesPerCommit = expectPositiveInteger(
        path,
        'history.maxFilesPerCommit',
        historyObj['maxFilesPerCommit'],
      );
    if (isSet(historyObj['minShared']))
      out.history.minShared = expectPositiveInteger(
        path,
        'history.minShared',
        historyObj['minShared'],
      );
    if (isSet(historyObj['minCommits']))
      out.history.minCommits = expectPositiveInteger(
        path,
        'history.minCommits',
        historyObj['minCommits'],
      );
  }

  if (obj['interpret'] !== undefined) {
    const interpret = obj['interpret'];
    if (typeof interpret !== 'object' || interpret === null || Array.isArray(interpret)) {
      throw new ConfigError(`${path}: "interpret" must be an object`);
    }
    const interpretObj = interpret as Record<string, unknown>;
    for (const key of Object.keys(interpretObj)) {
      if (!KNOWN_INTERPRET_KEYS.has(key)) {
        throw new ConfigError(`${path}: unknown key "interpret.${key}"`);
      }
    }
    out.interpret = {};
    if (isSet(interpretObj['couplingWeight']))
      out.interpret.couplingWeight = expectNonNegativeNumber(
        path,
        'interpret.couplingWeight',
        interpretObj['couplingWeight'],
      );
    if (isSet(interpretObj['minClusterSize']))
      out.interpret.minClusterSize = expectPositiveInteger(
        path,
        'interpret.minClusterSize',
        interpretObj['minClusterSize'],
      );
    if (isSet(interpretObj['maxClusters']))
      out.interpret.maxClusters = expectPositiveInteger(
        path,
        'interpret.maxClusters',
        interpretObj['maxClusters'],
      );
  }

  return out;
}

/**
 * Whether a key carries a value.
 *
 * An explicit `null` means "use the default", so a config file can spell out
 * every option — which is what `init --write-config` produces, and what makes
 * that file readable as documentation. Without this the tool writes a config it
 * then refuses to load.
 */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Zero is meaningful here: it turns the history term off entirely. */
function expectNonNegativeNumber(path: string, key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${path}: "${key}" must be a number of at least 0`);
  }
  return value;
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

/**
 * Whether a config path may hold a secret.
 *
 * Only reached for `--config`, which can name either project file directly.
 * The user config is outside every repository and is always allowed.
 */
function isLocalConfig(path: string): boolean {
  return basename(path) === LOCAL_CONFIG_FILENAME;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
