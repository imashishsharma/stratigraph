import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONFIG_FILENAME, ConfigError, loadConfig } from '../src/config.js';

function sandbox(): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-config-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  return { dir, repo };
}

describe('loadConfig', () => {
  it('defaults the database to .stratigraph/<repo-name>.db under the cwd', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir });
    expect(config.repoPath).toBe(repo);
    expect(config.dbPath).toBe(join(dir, '.stratigraph', 'repo.db'));
    expect(config.source).toBeNull();
  });

  it('never writes into the repository under analysis by default', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir }).dbPath.startsWith(repo)).toBe(false);
  });

  it('reads stratigraph.config.json from the cwd', () => {
    const { dir, repo } = sandbox();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ repo: 'repo', db: 'facts.db', exclude: ['vendor'] }),
    );
    const config = loadConfig({ cwd: dir });
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
    const config = loadConfig({ cwd: dir, repo: other, db: 'b.db' });
    expect(config.repoPath).toBe(other);
    expect(config.dbPath).toBe(join(dir, 'b.db'));
  });

  it('defaults interpretation on and source-sending off', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir });
    expect(config.llm.enabled).toBe(true);
    expect(config.llm.sendSource).toBe(false);
  });

  it('honours --no-llm and --send-source', () => {
    const { dir, repo } = sandbox();
    const config = loadConfig({ repo, cwd: dir, llm: false, sendSource: true });
    expect(config.llm.enabled).toBe(false);
    expect(config.llm.sendSource).toBe(true);
  });

  it('carries an explicit java home through', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ java: { home: '/opt/jdk21' } }));
    expect(loadConfig({ repo, cwd: dir }).java.home).toBe('/opt/jdk21');
    expect(loadConfig({ repo, cwd: dir, javaHome: '/opt/jdk17' }).java.home).toBe('/opt/jdk17');
  });

  it('rejects an unknown config key rather than ignoring it', () => {
    const { dir, repo } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ repo: 'repo', excludes: [] }));
    expect(() => loadConfig({ cwd: dir })).toThrow(/unknown key "excludes"/);
  });

  it('rejects a wrongly typed config value', () => {
    const { dir } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ exclude: 'vendor' }));
    expect(() => loadConfig({ cwd: dir })).toThrow(/"exclude" must be an array of strings/);
  });

  it('rejects invalid JSON with the file path', () => {
    const { dir } = sandbox();
    writeFileSync(join(dir, CONFIG_FILENAME), '{ nope');
    expect(() => loadConfig({ cwd: dir })).toThrow(ConfigError);
  });

  it('rejects a repo path that does not exist', () => {
    const { dir } = sandbox();
    expect(() => loadConfig({ cwd: dir, repo: join(dir, 'nowhere') })).toThrow(
      /does not exist/,
    );
  });

  it('rejects a repo path that is a file', () => {
    const { dir } = sandbox();
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    expect(() => loadConfig({ cwd: dir, repo: file })).toThrow(/not a directory/);
  });

  it('rejects a missing --config file', () => {
    const { dir } = sandbox();
    expect(() => loadConfig({ cwd: dir, config: join(dir, 'nope.json') })).toThrow(
      /config file not found/,
    );
  });
});

describe('history config', () => {
  it('defaults to the thresholds ADR-0011 records', () => {
    const { dir, repo } = sandbox();
    expect(loadConfig({ repo, cwd: dir }).history).toEqual({
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
    expect(loadConfig({ cwd: dir }).history).toEqual({
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
    const config = loadConfig({ cwd: dir, since: '2020-01-01', maxFilesPerCommit: 5 });
    expect(config.history).toMatchObject({ since: '2020-01-01', maxFilesPerCommit: 5 });
  });

  it('rejects a threshold that is not a positive integer', () => {
    const { dir, repo } = sandbox();
    for (const value of [0, -1, 2.5, '10']) {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({ repo, history: { minShared: value } }),
      );
      expect(() => loadConfig({ cwd: dir }), `minShared: ${JSON.stringify(value)}`).toThrow(
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
    expect(() => loadConfig({ cwd: dir })).toThrow(/unknown key "history.maxFilesPerCommmit"/);
  });
});
