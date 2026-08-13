import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { findExtractorJar, missingJarMessage } from '../src/toolchain/extractor-jar.js';
import {
  CACHE_ENV_VAR,
  cacheRoot,
  cachedJarPath,
  fetchJar,
  findCachedJar,
  JAR_NAME,
  JarFetchError,
  releaseUrl,
  sha256,
} from '../src/toolchain/jar-cache.js';

const VERSION = '9.9.9';
const PAYLOAD = new TextEncoder().encode('not really a jar, but bytes are bytes');
const DIGEST = sha256(PAYLOAD);

let cache: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'stratigraph-cache-'));
  env = { [CACHE_ENV_VAR]: cache };
});

/** A download that never touches the network. */
function serves(bytes: Uint8Array): (url: string) => Promise<Uint8Array> {
  return () => Promise.resolve(bytes);
}

describe('the cache location', () => {
  it('honours the override, so an air-gapped machine can pre-populate one', () => {
    expect(cacheRoot({ env })).toBe(join(cache, 'java-extractor'));
  });

  it('keys the jar by version, so a downgrade cannot run the newer extractor', () => {
    expect(cachedJarPath('1.4.0', { env })).toBe(
      join(cache, 'java-extractor', '1.4.0', JAR_NAME),
    );
    expect(cachedJarPath('1.5.0', { env })).not.toBe(cachedJarPath('1.4.0', { env }));
  });

  it('falls back to XDG_CACHE_HOME when there is no override', () => {
    expect(cacheRoot({ env: { XDG_CACHE_HOME: '/x' } })).toBe('/x/stratigraph/java-extractor');
  });
});

describe('fetching the jar', () => {
  it('writes it to the cache once the checksum matches', async () => {
    const result = await fetchJar({
      version: VERSION,
      env,
      checksum: DIGEST,
      download: serves(PAYLOAD),
    });

    expect(result.cached).toBe(false);
    expect(result.sha256).toBe(DIGEST);
    expect(result.path).toBe(cachedJarPath(VERSION, { env }));
    expect(readFileSync(result.path)).toEqual(Buffer.from(PAYLOAD));
  });

  it('refuses a jar whose digest is not the pinned one, and writes nothing', async () => {
    await expect(
      fetchJar({
        version: VERSION,
        env,
        checksum: DIGEST,
        download: serves(new TextEncoder().encode('a different file entirely')),
      }),
    ).rejects.toThrow(/does not match the checksum pinned/);

    expect(findCachedJar(VERSION, { env })).toBeNull();
  });

  it('leaves no partial file behind when the download fails', async () => {
    await expect(
      fetchJar({
        version: VERSION,
        env,
        checksum: DIGEST,
        download: () => Promise.reject(new Error('ECONNRESET')),
      }),
    ).rejects.toThrow(/could not download/);

    expect(findCachedJar(VERSION, { env })).toBeNull();
    // Not merely "no jar": nothing at all, so there is no `.partial` for a
    // later run to trip over and no empty directory implying a half-fetch.
    expect(existsSync(join(cache, 'java-extractor', VERSION))).toBe(false);
  });

  it('names the offline route when the network is unreachable', async () => {
    await expect(
      fetchJar({
        version: VERSION,
        env,
        checksum: DIGEST,
        download: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      }),
    ).rejects.toThrow(new RegExp(CACHE_ENV_VAR));
  });

  it('refuses to download at all when the build pins no checksum', async () => {
    let asked = false;
    await expect(
      fetchJar({
        version: VERSION,
        env,
        checksum: null,
        download: () => {
          asked = true;
          return Promise.resolve(PAYLOAD);
        },
      }),
    ).rejects.toThrow(JarFetchError);

    // The point is that it never reaches the network, not merely that it errors.
    expect(asked).toBe(false);
  });

  it('does not download again when the version is already cached', async () => {
    await fetchJar({ version: VERSION, env, checksum: DIGEST, download: serves(PAYLOAD) });

    let asked = false;
    const second = await fetchJar({
      version: VERSION,
      env,
      checksum: DIGEST,
      download: () => {
        asked = true;
        return Promise.resolve(PAYLOAD);
      },
    });

    expect(second.cached).toBe(true);
    expect(asked).toBe(false);
  });

  it('downloads again under --force', async () => {
    await fetchJar({ version: VERSION, env, checksum: DIGEST, download: serves(PAYLOAD) });
    const again = await fetchJar({
      version: VERSION,
      env,
      force: true,
      checksum: DIGEST,
      download: serves(PAYLOAD),
    });
    expect(again.cached).toBe(false);
  });

  it('points at the release for the version it was asked for', () => {
    expect(releaseUrl('1.5.0')).toBe(
      `https://github.com/imashishsharma/stratigraph/releases/download/v1.5.0/${JAR_NAME}`,
    );
  });
});

describe('finding a jar', () => {
  it('finds the one the fetch cached, with no flag', () => {
    const path = cachedJarPath(VERSION, { env });
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, PAYLOAD);

    const found = findExtractorJar({ env, version: VERSION, buildOutput: '/nope' });
    expect(found).toEqual({ path, source: 'cache' });
  });

  it('prefers a locally built jar over the cached one', () => {
    const cached = cachedJarPath(VERSION, { env });
    mkdirSync(join(cached, '..'), { recursive: true });
    writeFileSync(cached, PAYLOAD);

    const built = join(cache, 'built.jar');
    writeFileSync(built, PAYLOAD);

    expect(findExtractorJar({ env, version: VERSION, buildOutput: built })).toEqual({
      path: built,
      source: 'build',
    });
  });

  it('offers the fetch command when it lists where it looked', () => {
    const message = missingJarMessage({ env, version: VERSION, buildOutput: '/nope' });
    expect(message).toContain('stratigraph fetch-extractor');
    expect(message).toContain(cachedJarPath(VERSION, { env }));
    expect(message).toContain('./mvnw package');
  });
});
