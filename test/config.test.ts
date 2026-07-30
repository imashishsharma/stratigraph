import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_API_KEY_ENV,
  DEFAULT_MODEL,
  describeSource,
  loadConfig,
  LOCAL_CONFIG_FILENAME,
} from '../src/config.js';

/**
 * A config home that does not exist, so a real ~/.config/stratigraph/config.json
 * on the machine running these tests cannot change their outcome.
 */
const NO_USER_CONFIG = {
  STRATIGRAPH_CONFIG_HOME: join(tmpdir(), 'stratigraph-absent-user-config'),
} as NodeJS.ProcessEnv;

function sandbox(): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-config-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  return { dir, repo };
}

/** A user config directory with the given file contents in it. */
function userConfig(contents: object): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'stratigraph-userconf-'));
  mkdirSync(join(home, 'stratigraph'));
  writeFileSync(join(home, 'stratigraph', 'config.json'), JSON.stringify(contents));
  return { STRATIGRAPH_CONFIG_HOME: join(home, 'stratigraph') } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('defaults the database to .stratigraph/<repo-name>.db under the cwd', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG });
    expect(config.repoPath).toBe(repo);
    expect(config.dbPath).toBe(join(dir, '.stratigraph', 'repo.db'));
    expect(config.source).toBeNull();
  });

  it('never writes into the repository under analysis by default', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG }).dbPath.startsWith(repo)).toBe(false);
  });

  it('reads stratigraph.config.json from the cwd', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo: 'repo', db: 'facts.db', exclude: ['vendor'] }),
    );
    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG });
    expect(config.repoPath).toBe(repo);
    expect(config.dbPath).toBe(join(dir, 'facts.db'));
    expect(config.exclude).toEqual(['vendor']);
    expect(config.source).toBe(join(dir, CONFIG_FILENAME));
  });

  it('lets CLI flags win over the config file', () => {
    const { dir, repo } = sandbox();
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo: 'repo', db: 'a.db' }));
    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG, repo: other, db: 'b.db' });
    expect(config.repoPath).toBe(other);
    expect(config.dbPath).toBe(join(dir, 'b.db'));
  });

  it('defaults interpretation on and source-sending off', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG });
    expect(config.llm.enabled).toBe(true);
    expect(config.llm.sendSource).toBe(false);
  });

  it('honours --no-llm and --send-source', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG, llm: false, sendSource: true });
    expect(config.llm.enabled).toBe(false);
    expect(config.llm.sendSource).toBe(true);
  });

  it('carries an explicit java home through', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ java: { home: '/opt/jdk21' } }));
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG }).java.home).toBe('/opt/jdk21');
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG, javaHome: '/opt/jdk17' }).java.home).toBe('/opt/jdk17');
  });

  it('rejects an unknown config key rather than ignoring it', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo: 'repo', excludes: [] }));
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/unknown key "excludes"/);
  });

  it('rejects a wrongly typed config value', () => {
    const { dir } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ exclude: 'vendor' }));
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/"exclude" must be an array of strings/);
  });

  it('rejects invalid JSON with the file path', () => {
    const { dir } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), '{ nope');
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(ConfigError);
  });

  it('rejects a repo path that does not exist', () => {
    const { dir } = sandbox();
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG, repo: join(dir, 'nowhere') })).toThrow(
      /does not exist/,
    );
  });

  it('rejects a repo path that is a file', () => {
    const { dir } = sandbox();
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG, repo: file })).toThrow(/not a directory/);
  });

  it('rejects a missing --config file', () => {
    const { dir } = sandbox();
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG, config: join(dir, 'nope.json') })).toThrow(
      /config file not found/,
    );
  });
});

describe('history config', () => {
  it('defaults to the thresholds ADR-0011 records', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG }).history).toEqual({
      since: null,
      maxFilesPerCommit: 50,
      minShared: 5,
      minCommits: 5,
    });
  });

  it('reads the block from the config file', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, history: { since: '2 years ago', maxFilesPerCommit: 20 } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).history).toEqual({
      since: '2 years ago',
      maxFilesPerCommit: 20,
      minShared: 5,
      minCommits: 5,
    });
  });

  it('lets flags win over the file', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, history: { since: '2 years ago', maxFilesPerCommit: 20 } }),
    );
    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG, since: '2020-01-01', maxFilesPerCommit: 5 });
    expect(config.history).toMatchObject({ since: '2020-01-01', maxFilesPerCommit: 5 });
  });

  it('rejects a threshold that is not a positive integer', () => {
    const { dir, repo } = sandbox();
    for (const value of [0, -1, 2.5, '10']) {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({ repo, history: { minShared: value } }),
      );
      expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG }), `minShared: ${JSON.stringify(value)}`).toThrow(
        /"history.minShared" must be a positive integer/,
      );
    }
  });

  it('rejects an unknown history key rather than ignoring it', () => {
    // A misspelled threshold that is silently ignored looks exactly like one
    // that had no effect.
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, history: { maxFilesPerCommmit: 20 } }),
    );
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/unknown key "history.maxFilesPerCommmit"/);
  });

  it('defaults the interpretation knobs, model included', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG });
    expect(config.interpret).toEqual({
      couplingWeight: 1,
      minClusterSize: 2,
      maxClusters: 25,
    });
    expect(config.llm.model).toBe(DEFAULT_MODEL);
  });

  it('reads the interpret section and lets flags win over it', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        repo,
        interpret: { couplingWeight: 0.5, minClusterSize: 3, maxClusters: 8 },
        llm: { model: 'claude-sonnet-5' },
      }),
    );

    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).interpret.couplingWeight).toBe(0.5);
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).llm.model).toBe('claude-sonnet-5');
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG, couplingWeight: 0 }).interpret.couplingWeight).toBe(0);
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG, model: 'claude-opus-5' }).llm.model).toBe('claude-opus-5');
  });

  it('accepts a coupling weight of zero, which turns the history term off', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, interpret: { couplingWeight: 0 } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).interpret.couplingWeight).toBe(0);
  });

  it('rejects a negative or non-numeric coupling weight', () => {
    // NaN and Infinity are absent deliberately: JSON.stringify turns both into
    // `null`, so they cannot reach the parser through a config file.
    for (const value of [-1, '1', true, []]) {
      const { dir, repo } = sandbox();
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({ repo, interpret: { couplingWeight: value } }),
      );
      expect(
        () => loadConfig({ cwd: dir, env: NO_USER_CONFIG }),
        `couplingWeight: ${JSON.stringify(value)}`,
      ).toThrow(/"interpret.couplingWeight" must be a number of at least 0/);
    }
  });

  it('treats an explicit null as "use the default"', () => {
    // The scaffolded config spells every option out, and `null` is how JSON
    // says unset. Without this, `init --write-config` writes a file the tool
    // then refuses to load.
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        repo,
        interpret: { couplingWeight: null },
        history: { since: null },
        java: { home: null, jar: null },
      }),
    );

    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG });
    expect(config.interpret.couplingWeight).toBe(1);
    expect(config.history.since).toBeNull();
    expect(config.java.home).toBeNull();
  });

  it('rejects an unknown interpret key rather than ignoring it', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, interpret: { couplingWieght: 2 } }),
    );
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/unknown key "interpret.couplingWieght"/);
  });
});

describe('loadConfig — the local overrides file', () => {
  it('merges stratigraph.config.local.json over the shared one', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { model: 'claude-sonnet-5' }, interpret: { maxClusters: 4 } }),
    );
    writeFileSync(
      join(dir, LOCAL_CONFIG_FILENAME),
      JSON.stringify({ llm: { model: 'claude-opus-5' } }),
    );

    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG });
    expect(config.llm.model).toBe('claude-opus-5');
    // Untouched keys survive the merge, section by section.
    expect(config.interpret.maxClusters).toBe(4);
    expect(config.source).toBe(join(dir, CONFIG_FILENAME));
    expect(config.localSource).toBe(join(dir, LOCAL_CONFIG_FILENAME));
    expect(describeSource(config)).toContain(LOCAL_CONFIG_FILENAME);
  });

  it('works with no shared config at all', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, LOCAL_CONFIG_FILENAME), JSON.stringify({ repo, llm: { apiKey: 'sk-local' } }));

    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG });
    expect(config.source).toBeNull();
    expect(config.localSource).toBe(join(dir, LOCAL_CONFIG_FILENAME));
    expect(config.llm.apiKey).toBe('sk-local');
  });

  it('still lets a CLI flag win over the local file', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, LOCAL_CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { model: 'claude-sonnet-5' } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG, model: 'claude-opus-5' }).llm.model).toBe('claude-opus-5');
  });
});

describe('loadConfig — the key', () => {
  it('refuses an inline key in the shared config, which is meant to be committed', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { apiKey: 'sk-ant-oops' } }),
    );

    // Refused rather than warned about: a warning scrolls past, and by the time
    // anyone notices the key is in the repository's history.
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/must not go in stratigraph\.config\.json/);
    // The error names every alternative, so it is actionable on its own.
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/stratigraph\.config\.local\.json/);
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/llm\.apiKeyFile/);
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts an inline key from the local file', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo }));
    writeFileSync(
      join(dir, LOCAL_CONFIG_FILENAME),
      JSON.stringify({ llm: { apiKey: 'sk-ant-local' } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).llm.apiKey).toBe('sk-ant-local');
  });

  it('resolves apiKeyFile relative to the config file, and expands ~', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { apiKeyFile: 'secrets/key.txt' } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).llm.apiKeyFile).toBe(join(dir, 'secrets', 'key.txt'));

    const { dir: other, repo: otherRepo } = sandbox();
    writeFileSync(
      join(other, CONFIG_FILENAME),
      JSON.stringify({ repo: otherRepo, llm: { apiKeyFile: '~/keys/anthropic' } }),
    );
    expect(loadConfig({ cwd: other, env: NO_USER_CONFIG }).llm.apiKeyFile).toBe(
      join(homedir(), 'keys', 'anthropic'),
    );
  });

  it('defaults apiKeyEnv, and lets a project point at its own variable', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG }).llm.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV);

    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { apiKeyEnv: 'WORK_ANTHROPIC_KEY' } }),
    );
    expect(loadConfig({ cwd: dir, env: NO_USER_CONFIG }).llm.apiKeyEnv).toBe('WORK_ANTHROPIC_KEY');
  });

  it('rejects an unknown llm key rather than ignoring it', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo, llm: { apikey: 'x' } }));
    expect(() => loadConfig({ cwd: dir, env: NO_USER_CONFIG })).toThrow(/unknown key "llm.apikey"/);
  });
});

describe('loadConfig — --config pointing at the local file', () => {
  it('reads it once, not twice', () => {
    const { dir, repo } = sandbox();
    const path = join(dir, LOCAL_CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ repo, llm: { apiKey: 'sk-explicit' } }));

    const config = loadConfig({ cwd: dir, env: NO_USER_CONFIG, config: path });
    expect(config.llm.apiKey).toBe('sk-explicit');
    expect(config.source).toBe(path);
    expect(config.localSource).toBeNull();
    expect(describeSource(config)).toBe(path);
  });
});

describe('loadConfig — the user config file', () => {
  it('supplies a key and a model for every project, with no project config at all', () => {
    // The globally-installed case: nothing in the working directory, and the
    // tool still knows the credential.
    const { dir, repo } = sandbox();
    const env = userConfig({ llm: { model: 'claude-sonnet-5', apiKey: 'sk-user' } });

    const config = loadConfig({ repo, cwd: dir, env });
    expect(config.llm.model).toBe('claude-sonnet-5');
    expect(config.llm.apiKey).toBe('sk-user');
    expect(config.userSource).toBe(join(env['STRATIGRAPH_CONFIG_HOME'] as string, 'config.json'));
    expect(config.source).toBeNull();
  });

  it('allows an inline key, being outside every repository', () => {
    const { dir, repo } = sandbox();
    const env = userConfig({ llm: { apiKey: 'sk-user' } });
    expect(loadConfig({ repo, cwd: dir, env }).llm.apiKey).toBe('sk-user');
  });

  it("loses to a project's committed choices, and keeps its own key", () => {
    // A project pinning a model should win over a personal default; the key is
    // never in the project file, so it survives.
    const { dir, repo } = sandbox();
    const env = userConfig({ llm: { model: 'claude-sonnet-5', apiKey: 'sk-user' } });
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { model: 'claude-opus-5' } }),
    );

    const config = loadConfig({ cwd: dir, env });
    expect(config.llm.model).toBe('claude-opus-5');
    expect(config.llm.apiKey).toBe('sk-user');
  });

  it('loses to the local file too', () => {
    const { dir, repo } = sandbox();
    const env = userConfig({ llm: { apiKey: 'sk-user' } });
    writeFileSync(
      join(dir, LOCAL_CONFIG_FILENAME),
      JSON.stringify({ repo, llm: { apiKey: 'sk-project-local' } }),
    );
    expect(loadConfig({ cwd: dir, env }).llm.apiKey).toBe('sk-project-local');
  });

  it('reports all three files it read, weakest first', () => {
    const { dir, repo } = sandbox();
    const env = userConfig({ llm: { apiKey: 'sk-user' } });
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo }));
    writeFileSync(join(dir, LOCAL_CONFIG_FILENAME), JSON.stringify({ llm: { model: 'm' } }));

    const described = describeSource(loadConfig({ cwd: dir, env }));
    expect(described.indexOf('config.json')).toBeLessThan(described.indexOf(CONFIG_FILENAME));
    expect(described.indexOf(CONFIG_FILENAME)).toBeLessThan(
      described.indexOf(LOCAL_CONFIG_FILENAME),
    );
  });

  it('is absent without complaint when there is no user config', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir, env: NO_USER_CONFIG }).userSource).toBeNull();
  });
});
