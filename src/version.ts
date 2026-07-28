import { readFileSync } from 'node:fs';

/** Resolves to the package root from both `src/` (tsx) and `dist/` (built). */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string };

export const TOOL_VERSION = pkg.version ?? '0.0.0';
