import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_API_KEY_ENV, type LlmConfig } from '../src/config.js';
import { InterpretError, resolveCredential } from '../src/interpret/client.js';

/** Config with no credential configured, so each test sets exactly one. */
function llm(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    enabled: true,
    model: 'claude-opus-5',
    apiKey: null,
    apiKeyFile: null,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    sendSource: false,
    ...overrides,
  };
}

/** An environment with nothing the SDK could pick up on its own. */
function bareEnv(): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_CONFIG_DIR: join(tmpdir(), 'stratigraph-no-such-config-dir'),
  } as NodeJS.ProcessEnv;
}

function keyFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratigraph-key-'));
  const path = join(dir, 'api-key');
  writeFileSync(path, contents);
  return path;
}

describe('resolveCredential', () => {
  it('takes the inline key first', () => {
    const credential = resolveCredential(llm({ apiKey: 'sk-inline' }), bareEnv());
    expect(credential).toMatchObject({ source: 'config', apiKey: 'sk-inline' });
    expect(credential?.describe).toContain('local.json');
  });

  it('reads a key file, trimming the trailing newline an editor leaves', () => {
    const path = keyFile('sk-from-file\n');
    expect(resolveCredential(llm({ apiKeyFile: path }), bareEnv())).toEqual({
      source: 'key-file',
      describe: path,
      apiKey: 'sk-from-file',
    });
  });

  it('reads the configured environment variable', () => {
    const env = { ...bareEnv(), WORK_KEY: 'sk-from-env' } as NodeJS.ProcessEnv;
    expect(resolveCredential(llm({ apiKeyEnv: 'WORK_KEY' }), env)).toMatchObject({
      source: 'environment',
      describe: '$WORK_KEY',
      apiKey: 'sk-from-env',
    });
  });

  it('defaults to ANTHROPIC_API_KEY', () => {
    const env = { ...bareEnv(), ANTHROPIC_API_KEY: 'sk-default' } as NodeJS.ProcessEnv;
    expect(resolveCredential(llm(), env)).toMatchObject({
      source: 'environment',
      apiKey: 'sk-default',
    });
  });

  it('leaves an auth token for the SDK to read rather than carrying it', () => {
    const env = { ...bareEnv(), ANTHROPIC_AUTH_TOKEN: 'token' } as NodeJS.ProcessEnv;
    expect(resolveCredential(llm(), env)).toEqual({
      source: 'auth-token',
      describe: '$ANTHROPIC_AUTH_TOKEN',
      apiKey: null,
    });
  });

  it('finds an `ant auth login` profile, so a logged-in user is not told to get a key', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'stratigraph-ant-'));
    mkdirSync(join(configDir, 'credentials'));
    const env = { ANTHROPIC_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;

    expect(resolveCredential(llm(), env)).toMatchObject({
      source: 'profile',
      apiKey: null,
    });
  });

  it('reports none when there is none', () => {
    expect(resolveCredential(llm(), bareEnv())).toBeNull();
  });

  it('prefers config over environment, so an edit is not silently ignored', () => {
    const env = { ...bareEnv(), ANTHROPIC_API_KEY: 'sk-env' } as NodeJS.ProcessEnv;
    expect(resolveCredential(llm({ apiKey: 'sk-config' }), env)?.apiKey).toBe('sk-config');
    expect(
      resolveCredential(llm({ apiKeyFile: keyFile('sk-file') }), env)?.apiKey,
    ).toBe('sk-file');
  });

  it('fails on an unreadable key file rather than falling through to another credential', () => {
    // Silently using a different credential than the one someone configured is
    // how the wrong account gets billed.
    const env = { ...bareEnv(), ANTHROPIC_API_KEY: 'sk-env' } as NodeJS.ProcessEnv;
    const missing = join(tmpdir(), 'stratigraph-no-such-key-file');

    expect(() => resolveCredential(llm({ apiKeyFile: missing }), env)).toThrow(InterpretError);
    expect(() => resolveCredential(llm({ apiKeyFile: missing }), env)).toThrow(
      /cannot read/,
    );
  });

  it('fails on an empty key file', () => {
    const path = keyFile('   \n');
    expect(() => resolveCredential(llm({ apiKeyFile: path }), bareEnv())).toThrow(/is empty/);
  });

  it('never puts the key in the description', () => {
    for (const credential of [
      resolveCredential(llm({ apiKey: 'sk-secret-inline' }), bareEnv()),
      resolveCredential(llm({ apiKeyFile: keyFile('sk-secret-file') }), bareEnv()),
      resolveCredential(llm(), {
        ...bareEnv(),
        ANTHROPIC_API_KEY: 'sk-secret-env',
      } as NodeJS.ProcessEnv),
    ]) {
      expect(credential?.describe).not.toContain('sk-secret');
    }
  });
});
