import * as m0001 from './0001_initial.js';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Migrations are TypeScript modules rather than loose .sql files so that they
 * are compiled into `dist` alongside everything else — no asset-copying build
 * step, and no chance of the published package shipping a schema that does not
 * match its code.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: m0001.name, up: m0001.up }];

export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
