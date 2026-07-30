import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDotenv, parseDotenv } from '../src/dotenv.js';

function dir(contents?: string): string {
  const path = mkdtempSync(join(tmpdir(), 'stratigraph-dotenv-'));
  if (contents !== undefined) writeFileSync(join(path, '.env'), contents);
  return path;
}

describe('parseDotenv', () => {
  it.each([
    ['ANTHROPIC_API_KEY=sk-ant-abc', { ANTHROPIC_API_KEY: 'sk-ant-abc' }],
    ['export ANTHROPIC_API_KEY=sk-ant-abc', { ANTHROPIC_API_KEY: 'sk-ant-abc' }],
    ['  KEY = value  ', { KEY: 'value' }],
    ['KEY="quoted value"', { KEY: 'quoted value' }],
    ["KEY='single'", { KEY: 'single' }],
    // A `#` inside quotes is part of the key, not a comment. Anthropic keys do
    // not contain one, but plenty of passwords do.
    ['KEY="has#hash"', { KEY: 'has#hash' }],
    ['KEY=value # trailing comment', { KEY: 'value' }],
    ['# just a comment', {}],
    ['', {}],
    ['NOTASETTING', {}],
    ['=novalue', {}],
    ['1INVALID=x', {}],
    ['KEY=', { KEY: '' }],
    ['A=1\nB=2\n\n# c\nC=3', { A: '1', B: '2', C: '3' }],
    ['A=1\r\nB=2', { A: '1', B: '2' }],
  ])('%j', (text, expected) => {
    expect(Object.fromEntries(parseDotenv(text))).toEqual(expected);
  });

  it('keeps an equals sign inside the value', () => {
    expect(parseDotenv('URL=https://x/?a=b').get('URL')).toBe('https://x/?a=b');
  });
});

describe('loadDotenv', () => {
  it('sets a name that is not already in the environment', () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = loadDotenv([dir('ANTHROPIC_API_KEY=sk-from-dotenv')], env);

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-from-dotenv');
    expect(result.applied).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.files).toHaveLength(1);
  });

  it('never overrides the real environment', () => {
    // The rule that makes CI work: a pipeline exports a secret and a committed
    // .env cannot quietly replace it.
    const env = { ANTHROPIC_API_KEY: 'sk-from-ci' } as NodeJS.ProcessEnv;
    loadDotenv([dir('ANTHROPIC_API_KEY=sk-from-dotenv')], env);

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-from-ci');
  });

  it('lets the first directory win over later ones', () => {
    const env = {} as NodeJS.ProcessEnv;
    const near = dir('ANTHROPIC_API_KEY=sk-near\nONLY_FAR=no');
    const far = dir('ANTHROPIC_API_KEY=sk-far\nONLY_FAR=yes');

    const result = loadDotenv([near, far], env);

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-near');
    // A name only the far file defines is still picked up.
    expect(env['ONLY_FAR']).toBe('no');
    expect(result.files).toHaveLength(2);
  });

  it('is a no-op when there is no .env anywhere', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(loadDotenv([dir(), dir()], env)).toEqual({ files: [], applied: [] });
    expect(Object.keys(env)).toEqual([]);
  });

  it('reports the names it set but never the values', () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = loadDotenv([dir('ANTHROPIC_API_KEY=sk-secret')], env);

    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });
});
