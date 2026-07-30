/**
 * Finding the TypeScript extractor.
 *
 * Unlike the Java extractor (ADR-0004: a jar fetched on first use), this one
 * ships inside the npm package — it is TypeScript, compiled by the same build
 * into `dist/extractors/typescript/`. It is still a separate *process*, which
 * is what ADR-0001 actually requires: a parser that runs out of memory on a
 * 10,000-file workspace takes down one extractor and not the analysis.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TsExtractorSource = 'built' | 'source';

export interface TsExtractor {
  /** Arguments to put before the extractor's own, after `process.execPath`. */
  nodeArgs: string[];
  /** The entry point. */
  entry: string;
  source: TsExtractorSource;
}

/** The package root, from both `src/toolchain/` and `dist/toolchain/`. */
function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function findTsExtractor(root = packageRoot()): TsExtractor | null {
  const built = join(root, 'dist', 'extractors', 'typescript', 'main.js');
  if (existsSync(built)) {
    return { nodeArgs: [], entry: built, source: 'built' };
  }

  // A checkout that has not been built yet. `tsx` is a devDependency, so this
  // path exists for a developer and never for an installed user — which is why
  // the message below tells them to build rather than to install anything.
  const fromSource = join(root, 'extractors', 'typescript', 'src', 'main.ts');
  if (existsSync(fromSource)) {
    return { nodeArgs: ['--import', 'tsx'], entry: fromSource, source: 'source' };
  }

  return null;
}

export function missingTsExtractorMessage(root = packageRoot()): string {
  return [
    'the TypeScript extractor was not found. Looked at:',
    `  ${join(root, 'dist', 'extractors', 'typescript', 'main.js')}`,
    `  ${join(root, 'extractors', 'typescript', 'src', 'main.ts')}`,
    '',
    'Build it from a checkout with `npm run build`.',
  ].join('\n');
}
