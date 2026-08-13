/**
 * `stratigraph fetch-extractor` — download the Java extractor jar.
 *
 * The one command in this tool that touches the network on purpose, and the
 * reason it is a command rather than something `extract` does silently: every
 * other operation runs entirely locally, and the way to keep that claim true is
 * for the exception to be a thing the user typed (ADR-0004, CLAUDE.md).
 *
 * The jar is 22 MB and is not in the npm tarball, so before this existed the
 * only route to Java analysis was cloning the repository and running maven.
 * That is a fine instruction for a contributor and a wall for everyone else.
 */

import { statSync } from 'node:fs';

import { info, print } from '../log.js';
import {
  CACHE_ENV_VAR,
  cachedJarPath,
  fetchJar,
  findCachedJar,
  pinnedChecksum,
  releaseUrl,
  type FetchJarResult,
} from '../toolchain/jar-cache.js';
import { TOOL_VERSION } from '../version.js';

export interface FetchExtractorOptions {
  /** Download again even if the cache already holds this version. */
  force?: boolean | undefined;
  /** Report what would happen; download nothing. */
  dryRun?: boolean | undefined;
  /** Overridable for tests; defaults to this package's version. */
  version?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Injectable so tests never reach the network. */
  download?: ((url: string) => Promise<Uint8Array>) | undefined;
}

export async function runFetchExtractor(
  options: FetchExtractorOptions = {},
): Promise<FetchJarResult> {
  const version = options.version ?? TOOL_VERSION;
  const env = options.env ?? process.env;
  const target = cachedJarPath(version, { env });

  if (options.dryRun) {
    const cached = findCachedJar(version, { env });
    const checksum = pinnedChecksum();
    print(`version    ${version}`);
    print(`source     ${releaseUrl(version)}`);
    print(`target     ${target}`);
    print(`checksum   ${checksum ?? 'none pinned in this build — a download would be refused'}`);
    print(
      cached === null
        ? 'state      not cached; a fetch would download it'
        : `state      already cached (${size(statSync(cached).size)}); a fetch would do nothing`,
    );
    return {
      path: target,
      url: releaseUrl(version),
      sha256: checksum ?? '',
      bytes: cached === null ? 0 : statSync(cached).size,
      cached: cached !== null,
    };
  }

  // Announced only once it is actually going to happen. Saying "downloading"
  // and then refusing for want of a checksum describes a network request that
  // was never made.
  const willDownload =
    (options.force || findCachedJar(version, { env }) === null) && pinnedChecksum() !== null;
  if (willDownload) {
    info(`downloading the Java extractor ${version} from ${releaseUrl(version)}`);
  }

  const result = await fetchJar({
    version,
    force: options.force,
    env,
    download: options.download,
  });

  if (result.cached) {
    info(`the Java extractor ${version} is already cached — nothing downloaded.`);
  } else {
    info(`verified sha256 ${result.sha256}`);
    info(`${size(result.bytes)} written to ${result.path}`);
  }

  print(result.path);
  print('');
  print(
    result.cached
      ? `Already in place. Re-download with --force, or set ${CACHE_ENV_VAR} to use another cache.`
      : 'The Java extractor is ready. `stratigraph extract` will find it without a flag.',
  );

  return result;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
