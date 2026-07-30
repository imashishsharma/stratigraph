import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runConfigPaths, runConfigSetKey } from '../src/commands/config.js';
import { runInit } from '../src/commands/init.js';
import { configTemplate } from '../src/config-template.js';
import { CONFIG_FILENAME, ConfigError, loadConfig } from '../src/config.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let userHome: string;
let env: NodeJS.ProcessEnv;
let printed: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-cfgcmd-'));
  userHome = join(mkdtempSync(join(tmpdir(), 'stratigraph-cfghome-')), 'stratigraph');
  // Every credential source must be pointed somewhere empty, not just the
  // stratigraph one: `ant auth login` writes a profile under
  // ANTHROPIC_CONFIG_DIR, and a developer who has run it would otherwise see
  // these tests find a real credential and fail.
  env = {
    STRATIGRAPH_CONFIG_HOME: userHome,
    ANTHROPIC_CONFIG_DIR: join(cwd, 'no-anthropic-profile'),
  } as NodeJS.ProcessEnv;

  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stdout(): string {
  return printed.join('');
}

describe('init --write-config', () => {
  it('writes a config file that the tool can read back', () => {
    // The scaffolding wrote `"java": {"home": null}` and the parser demanded a
    // string, so `init --write-config` produced a file the next command
    // refused to load. Anything init writes must round-trip.
    const result = runInit({ repo: FIXTURE, cwd, env, writeConfig: true });

    expect(result.configWritten).toBe(join(cwd, CONFIG_FILENAME));
    expect(() => loadConfig({ cwd, env })).not.toThrow();
    expect(loadConfig({ cwd, env }).repoPath).toBe(FIXTURE);
  });

  it('writes nothing unless asked', () => {
    const result = runInit({ repo: FIXTURE, cwd, env });
    expect(result.configWritten).toBeNull();
    expect(existsSync(join(cwd, CONFIG_FILENAME))).toBe(false);
  });

  it('never overwrites a config someone edited', () => {
    writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify({ exclude: ['mine'] }));

    const result = runInit({ repo: FIXTURE, cwd, env, writeConfig: true });

    expect(result.configWritten).toBeNull();
    expect(loadConfig({ cwd, env }).exclude).toEqual(['mine']);
  });

  it('leaves the key out of the file it writes, since that file is committed', () => {
    runInit({ repo: FIXTURE, cwd, env, writeConfig: true });
    const written = readFileSync(join(cwd, CONFIG_FILENAME), 'utf8');

    expect(written).not.toContain('apiKey"');
    // It does name the environment variable, which is the safe half.
    expect(written).toContain('apiKeyEnv');
  });
});

describe('configTemplate', () => {
  it('produces defaults that parse, with every section present', () => {
    const path = join(cwd, CONFIG_FILENAME);
    writeFileSync(path, configTemplate({ repo: FIXTURE }));

    const config = loadConfig({ cwd, env });
    expect(config.repoPath).toBe(FIXTURE);
    expect(config.history.maxFilesPerCommit).toBe(50);
    expect(config.interpret.couplingWeight).toBe(1);
    expect(config.llm.enabled).toBe(true);
  });

  it('changes nothing on its own — every value is already the default', () => {
    const bare = loadConfig({ repo: FIXTURE, cwd, env });
    writeFileSync(join(cwd, CONFIG_FILENAME), configTemplate({ repo: FIXTURE }));
    const templated = loadConfig({ cwd, env });

    expect(templated.history).toEqual(bare.history);
    expect(templated.interpret).toEqual(bare.interpret);
    expect(templated.llm.model).toBe(bare.llm.model);
    expect(templated.exclude).toEqual(bare.exclude);
  });

  it('matches the example file the README points people at', () => {
    // The file someone reads and the file the tool writes must configure the
    // same things, or one of them is quietly wrong.
    const example = JSON.parse(
      readFileSync(join(REPO_ROOT, 'stratigraph.config.example.json'), 'utf8'),
    ) as Record<string, unknown>;
    const template = JSON.parse(configTemplate({ repo: '.' })) as Record<string, unknown>;

    expect(Object.keys(template).sort()).toEqual(
      Object.keys(example).filter((key) => key !== 'db').sort(),
    );
    for (const section of ['history', 'interpret', 'llm', 'java']) {
      expect(
        Object.keys(template[section] as object).sort(),
        `section ${section}`,
      ).toEqual(Object.keys(example[section] as object).sort());
    }
  });
});

describe('config paths', () => {
  it('lists every file that can matter, present or not', () => {
    const result = runConfigPaths({ repo: FIXTURE, cwd, env });

    expect(result.entries.map((entry) => entry.exists)).toEqual([false, false, false, false]);
    expect(stdout()).toContain('weakest first');
    // Absent files are listed too: someone asking this needs to know what to create.
    expect(stdout()).toContain('absent');
    expect(stdout()).toContain('.env');
  });

  it('marks the committed file as one that may not hold a key', () => {
    const result = runConfigPaths({ repo: FIXTURE, cwd, env });
    const shared = result.entries.find((entry) => entry.path.endsWith(CONFIG_FILENAME));

    expect(shared?.mayHoldKey).toBe(false);
    expect(stdout()).toContain('(no key here)');
  });

  it('names the credential in use without printing it', () => {
    runConfigSetKey('sk-ant-secret-value', { env });
    printed = [];

    const result = runConfigPaths({ repo: FIXTURE, cwd, env });

    expect(result.credential?.source).toBe('config');
    expect(stdout()).toContain(userHome);
    expect(stdout()).not.toContain('sk-ant-secret-value');
  });

  it('tells you how to set one when there is none', () => {
    runConfigPaths({ repo: FIXTURE, cwd, env });
    expect(stdout()).toContain('config set-key');
    expect(stdout()).toContain('ANTHROPIC_API_KEY');
  });
});

describe('config set-key', () => {
  it('creates the file and its directory', () => {
    const result = runConfigSetKey('sk-ant-new', { env });

    expect(result).toEqual({ path: join(userHome, 'config.json'), replaced: false });
    expect(loadConfig({ repo: FIXTURE, cwd, env }).llm.apiKey).toBe('sk-ant-new');
  });

  it('writes it read-only to the owner', () => {
    // The default umask would leave a credential world-readable.
    const { path } = runConfigSetKey('sk-ant-new', { env });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('keeps other settings in the file', () => {
    mkdirSync(userHome, { recursive: true });
    writeFileSync(
      join(userHome, 'config.json'),
      JSON.stringify({ llm: { model: 'claude-sonnet-5' }, interpret: { maxClusters: 3 } }),
    );

    const result = runConfigSetKey('sk-ant-new', { env });

    expect(result.replaced).toBe(false);
    const config = loadConfig({ repo: FIXTURE, cwd, env });
    expect(config.llm.apiKey).toBe('sk-ant-new');
    expect(config.llm.model).toBe('claude-sonnet-5');
    expect(config.interpret.maxClusters).toBe(3);
  });

  it('reports replacing an existing key rather than silently swapping it', () => {
    runConfigSetKey('sk-ant-first', { env });
    expect(runConfigSetKey('sk-ant-second', { env }).replaced).toBe(true);
    expect(loadConfig({ repo: FIXTURE, cwd, env }).llm.apiKey).toBe('sk-ant-second');
  });

  it('refuses an empty key', () => {
    expect(() => runConfigSetKey('   ', { env })).toThrow(ConfigError);
    expect(existsSync(join(userHome, 'config.json'))).toBe(false);
  });

  it('trims whitespace a paste leaves behind', () => {
    runConfigSetKey('  sk-ant-pasted\n', { env });
    expect(loadConfig({ repo: FIXTURE, cwd, env }).llm.apiKey).toBe('sk-ant-pasted');
  });

  it('refuses to overwrite a file it cannot parse', () => {
    // Replacing settings nobody can read back is not a recoverable mistake.
    mkdirSync(userHome, { recursive: true });
    const path = join(userHome, 'config.json');
    writeFileSync(path, '{ this is not json');

    expect(() => runConfigSetKey('sk-ant-new', { env })).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });
});

describe('.env', () => {
  it('supplies the key, and analyze can see it', () => {
    writeFileSync(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-ant-from-dotenv\n');
    const isolated = { ...env } as NodeJS.ProcessEnv;

    const config = loadConfig({ repo: FIXTURE, cwd, env: isolated });

    expect(config.dotenvFiles).toEqual([join(cwd, '.env')]);
    expect(isolated['ANTHROPIC_API_KEY']).toBe('sk-ant-from-dotenv');
  });

  it('does not override a variable already exported', () => {
    writeFileSync(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-ant-from-dotenv\n');
    const isolated = { ...env, ANTHROPIC_API_KEY: 'sk-ant-from-ci' } as NodeJS.ProcessEnv;

    loadConfig({ repo: FIXTURE, cwd, env: isolated });

    expect(isolated['ANTHROPIC_API_KEY']).toBe('sk-ant-from-ci');
  });

  it('is reported alongside the config files', () => {
    writeFileSync(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-ant-x\n');
    runConfigPaths({ repo: FIXTURE, cwd, env });
    expect(stdout()).toContain('found');
  });
});
