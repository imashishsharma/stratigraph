import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DDL_NAME, isMigrationPath, MIGRATION_DIRS, run, type Streams } from '../extractors/typescript/src/migrations/main.js';
import { statements } from '../extractors/typescript/src/migrations/sql.js';

const FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'migrations');

async function extract(): Promise<string[]> {
  const lines: string[] = [];
  const streams: Streams = { stdout: { write: (line) => lines.push(line) }, stderr: { write: () => {} } };
  expect(await run(['--repo', FIXTURE], streams)).toBe(0);
  return lines.map((line) => line.replace(JSON.stringify(FIXTURE).slice(1, -1), '<repo>'));
}

type Fact = { type: string; kind?: string; fqn?: string; src?: { fqn: string }; dst?: { fqn: string }; file?: string; startLine?: number; attrs?: Record<string, unknown> };

describe('the migrations extractor (ADR-0037)', () => {
  it('emits exactly the golden facts', async () => {
    const actual = await extract();
    const golden = join(FIXTURE, 'expected-facts.ndjson');
    if (process.env['UPDATE_GOLDENS'] === '1' || !existsSync(golden)) {
      writeFileSync(golden, `${actual.join('\n')}\n`);
    }
    expect(actual.join('\n')).toBe(readFileSync(golden, 'utf8').trimEnd());
  });

  it('leaves the schema the migrations leave: renames applied, drops gone, test changelogs ignored', async () => {
    const facts = (await extract()).map((line) => JSON.parse(line) as Fact);
    const tables = facts.filter((f) => f.type === 'node' && f.kind === 'table').map((f) => f.fqn).sort();
    expect(tables).toEqual([
      'app_user',
      'invoice',
      'invoice_line',
      'owner',
      'payment',
      'report_run',
      'role',
      'user_authority',
    ]);

    const columns = (table: string) =>
      facts
        .filter((f) => f.type === 'node' && f.kind === 'column' && f.fqn?.startsWith(`${table}#`))
        .map((f) => `${f.fqn?.split('#')[1]}${f.attrs?.['primaryKey'] ? ' PK' : ''}`);
    expect(columns('owner')).toEqual(['id PK', 'first_name', 'user_id', 'last_name', 'telephone']);
    // V10 runs after V2 although "V10" sorts before "V2" by name.
    expect(columns('invoice')).toEqual(['id PK', 'amount_cents', 'status']);
    expect(columns('invoice_line')).toEqual(['id PK', 'invoice_id', 'description']);
    expect(columns('report_run')).toEqual(['id PK', 'started']);

    const fks = facts
      .filter((f) => f.type === 'edge' && f.kind === 'references')
      .map((f) => `${f.src?.fqn} -> ${f.dst?.fqn}`)
      .sort();
    expect(fks).toEqual([
      'invoice_line#invoice_id -> invoice',
      'owner#user_id -> app_user',
      'payment#invoice_id -> invoice',
      'user_authority#authority_name -> role',
      'user_authority#user_id -> app_user',
    ]);
  });

  it('cites each table at the change that created it', async () => {
    const facts = (await extract()).map((line) => JSON.parse(line) as Fact);
    const at = (fqn: string) => {
      const table = facts.find((f) => f.type === 'node' && f.kind === 'table' && f.fqn === fqn);
      return `${table?.file}:${table?.startLine}`;
    };
    expect(at('role')).toBe('api/src/main/resources/config/liquibase/changelog/00000000000000_initial_schema.xml:12');
    expect(at('owner')).toBe('api/src/main/resources/config/liquibase/changelog/20240101_added_entity_Owner.yaml:6');
    expect(at('invoice_line')).toBe('billing/src/main/resources/db/migration/V1__init.sql:8');
  });

  it('agrees with the role classifier about which directories hold migrations', () => {
    const roles = readFileSync(resolve(import.meta.dirname, '..', 'src', 'files', 'roles.ts'), 'utf8');
    const declared = /const MIGRATION_DIRS = (\[[^\]]*\])/.exec(roles)?.[1];
    expect(JSON.parse((declared ?? '[]').replace(/'/g, '"'))).toEqual(MIGRATION_DIRS);
    expect(isMigrationPath('src/main/resources/db/changelog/master.xml')).toBe(true);
    expect(isMigrationPath('src/test/resources/db/changelog/master.xml')).toBe(false);
    expect(isMigrationPath('src/main/resources/schema-postgres.sql')).toBe(true);
    expect(isMigrationPath('src/main/resources/META-INF/mysql-schema.sql')).toBe(true);
    expect(isMigrationPath('src/main/resources/data.sql')).toBe(false);
    // All three copies of the rule must agree (roles, language detection, extractor).
    const languages = readFileSync(resolve(import.meta.dirname, '..', 'src', 'toolchain', 'languages.ts'), 'utf8');
    const rule = DDL_NAME.source;
    expect(roles).toContain(rule);
    expect(languages).toContain(rule);
  });

  it('splits statements on semicolons outside quotes and comments, keeping line numbers', () => {
    expect(statements("-- a; b\nCREATE TABLE a (x text default ';');\n\n/* ; */ DROP TABLE b;")).toEqual([
      { text: "CREATE TABLE a (x text default ';')", line: 2 },
      { text: 'DROP TABLE b', line: 4 },
    ]);
  });
});
