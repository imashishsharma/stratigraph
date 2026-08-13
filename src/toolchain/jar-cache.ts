/**
 * The downloaded Java extractor jar, and where it lives.
 *
 * ADR-0004: the jar is not in the npm tarball — it is 22 MB of JVM bytecode and
 * most installs never analyse Java. It is fetched from the GitHub release
 * matching the installed package version, verified against a checksum pinned
 * into the package at release time, and cached per version so a downgrade does
 * not silently run yesterday's extractor.
 *
 * The fetch is a command of its own rather than something `extract` does on its
 * way past. CLAUDE.md says extraction and history mining touch no network, and
 * the honest way to keep that true is for the one networked operation in the
 * tool to be a thing you typed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The jar's filename, defined here rather than in `extractor-jar.ts`.
 *
 * That module needs the cache path, so the dependency has to run in this
 * direction; putting the name at the other end would make the two import each
 * other. A tool that reports package cycles should not ship one.
 */
export const JAR_NAME = 'stratigraph-java-extractor.jar';

/** Where the release publishes the jar. `{version}` is the package version. */
export const RELEASE_URL_TEMPLATE =
  'https://github.com/imashishsharma/stratigraph/releases/download/v{version}/' + JAR_NAME;

export const CACHE_ENV_VAR = 'STRATIGRAPH_CACHE_HOME';

export interface CacheOptions {
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The platform cache root.
 *
 * `STRATIGRAPH_CACHE_HOME` first, so an air-gapped or CI environment can point
 * at a pre-populated directory and never reach the network at all; then
 * `XDG_CACHE_HOME`; then the platform default. A cache, not config — this holds
 * a file that can always be fetched again, and nothing that cannot.
 */
export function cacheRoot(options: CacheOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env[CACHE_ENV_VAR];
  if (override) return join(override, 'java-extractor');

  if (process.platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    if (local) return join(local, 'stratigraph', 'cache', 'java-extractor');
  }
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg) return join(xdg, 'stratigraph', 'java-extractor');
  return join(homedir(), '.cache', 'stratigraph', 'java-extractor');
}

/**
 * Where the jar for one version sits.
 *
 * Keyed by version because the extractor and the core are released together and
 * are allowed to disagree about the fact protocol between versions. A single
 * shared path would mean an `npm install stratigraph@1.4` silently ran the 1.5
 * extractor.
 */
export function cachedJarPath(version: string, options: CacheOptions = {}): string {
  return join(cacheRoot(options), version, JAR_NAME);
}

/** The cached jar for this version, if it is there. */
export function findCachedJar(version: string, options: CacheOptions = {}): string | null {
  const path = cachedJarPath(version, options);
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

/**
 * The SHA-256 the release workflow recorded for this version's jar.
 *
 * Written into the package immediately before `npm publish`, from the very jar
 * the same job attaches to the release, so the published package can only ever
 * carry the digest of the artefact it is paired with. A checkout has no such
 * file — a developer builds the jar with maven instead, and the fetch refuses
 * rather than downloading something it cannot check.
 */
export function pinnedChecksum(): string | null {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const path = join(packageRoot, 'extractor-checksum.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sha256?: unknown };
    return typeof parsed.sha256 === 'string' && /^[0-9a-f]{64}$/.test(parsed.sha256)
      ? parsed.sha256
      : null;
  } catch {
    return null;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class JarFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JarFetchError';
  }
}

export interface FetchJarOptions extends CacheOptions {
  version: string;
  /** Download even if the cache already holds this version. */
  force?: boolean | undefined;
  /** Where to fetch from. Defaults to the release for `version`. */
  url?: string | undefined;
  /** The digest to require. Defaults to the one pinned in the package. */
  checksum?: string | null | undefined;
  /** Injectable so tests never reach the network. */
  download?: ((url: string) => Promise<Uint8Array>) | undefined;
}

export interface FetchJarResult {
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  /** True when the cache already held it and nothing was downloaded. */
  cached: boolean;
}

/**
 * Fetch the jar into the cache, or report why it will not.
 *
 * Verification is not optional and there is no flag to skip it: a 22 MB
 * executable pulled over the network and handed to a JVM is the one place in
 * this tool where "probably fine" is not good enough.
 */
export async function fetchJar(options: FetchJarOptions): Promise<FetchJarResult> {
  const { version, force = false } = options;
  const target = cachedJarPath(version, options);

  if (!force) {
    const existing = findCachedJar(version, options);
    if (existing !== null) {
      const bytes = readFileSync(existing);
      return {
        path: existing,
        url: options.url ?? releaseUrl(version),
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        cached: true,
      };
    }
  }

  const expected = options.checksum === undefined ? pinnedChecksum() : options.checksum;
  if (expected === null) {
    throw new JarFetchError(
      `this build of stratigraph carries no pinned checksum for the extractor jar, so a ` +
        `download could not be verified. That is normal in a checkout: build the jar instead ` +
        `with \`cd extractors/java && ./mvnw package\`, or point at one you already trust ` +
        `with --extractor-jar <path>.`,
    );
  }

  const url = options.url ?? releaseUrl(version);
  const download = options.download ?? httpDownload;

  let bytes: Uint8Array;
  try {
    bytes = await download(url);
  } catch (err) {
    throw new JarFetchError(
      `could not download the extractor jar from ${url}: ${(err as Error).message}\n` +
        `If this machine has no network access, fetch the jar elsewhere and put it at\n` +
        `  ${target}\n` +
        `or set ${CACHE_ENV_VAR} to a directory that already holds one.`,
    );
  }

  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new JarFetchError(
      `the extractor jar downloaded from ${url} does not match the checksum pinned in this ` +
        `package.\n  expected ${expected}\n  received ${actual}\n` +
        `Nothing was written. Do not run this jar; report it if the URL is the official release.`,
    );
  }

  mkdirSync(join(target, '..'), { recursive: true });
  // Written beside the target and renamed, so an interrupted download can never
  // leave a truncated jar in the cache for the next run to find and execute.
  const partial = `${target}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, target);

  return { path: target, url, sha256: actual, bytes: bytes.byteLength, cached: false };
}

export function releaseUrl(version: string): string {
  return RELEASE_URL_TEMPLATE.replace('{version}', version);
}

async function httpDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `404 — no jar is attached to that release yet`
        : `${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
