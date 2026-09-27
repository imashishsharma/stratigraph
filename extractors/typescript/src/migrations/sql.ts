/**
 * DDL out of SQL migration scripts — Flyway `V*.sql`, Liquibase formatted SQL,
 * `schema.sql` (ADR-0037).
 *
 * Not a SQL parser. It reads the statements a schema is made of — CREATE
 * TABLE, ALTER TABLE ADD/DROP/RENAME, DROP TABLE, RENAME TABLE — across the
 * common dialects, and ignores everything else. Every statement it cannot read
 * is skipped, never half-applied.
 */

import { SchemaState, type Site } from './schema.js';

const IDENT = String.raw`(?:"[^"]+"|` + '`[^`]+`' + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const NAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;

/** Comments blanked to spaces, so offsets and line numbers survive. */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (quote !== null) {
      out += c;
      if (c === quote) quote = null;
      i += 1;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
    } else if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && next === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Statements, split on `;` outside quotes, with the line each starts on. */
export function statements(sql: string, firstLine = 1): Array<{ text: string; line: number }> {
  const clean = stripComments(sql);
  const out: Array<{ text: string; line: number }> = [];
  let start = 0;
  let quote: string | null = null;
  let dollar = false;
  for (let i = 0; i <= clean.length; i += 1) {
    const c = clean[i];
    if (c === '$' && clean[i + 1] === '$') {
      dollar = !dollar;
      i += 1;
      continue;
    }
    if (dollar) continue;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === ';' || c === undefined) {
      const raw = clean.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text.length > 0) {
        out.push({ text, line: firstLine + countNewlines(clean, 0, start + lead) });
      }
      start = i + 1;
    }
  }
  return out;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/** Top-level comma split: commas inside parentheses or quotes belong to their item. */
function splitTopLevel(text: string): Array<{ text: string; offset: number }> {
  const items: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if ((c === ',' && depth === 0) || c === undefined) {
      const raw = text.slice(start, i);
      items.push({ text: raw.trim(), offset: start + (raw.length - raw.trimStart().length) });
      start = i + 1;
    }
  }
  return items.filter((item) => item.text.length > 0);
}

function columnList(text: string): string[] {
  return splitTopLevel(text.replace(/^\(|\)$/g, '')).map((item) => item.text.split(/\s+/)[0] as string);
}

/** The body of the first balanced `( ... )` at or after `from`. */
function parenthesised(text: string, from: number): { body: string; start: number; end: number } | null {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), start: open + 1, end: i };
    }
  }
  return null;
}

const CREATE = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged|cached|memory)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${NAME})`,
  'i',
);
const ALTER = new RegExp(String.raw`^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(${NAME})\s+([\s\S]*)$`, 'i');
const DROP = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+cascade(?:\s+constraints)?|\s+restrict)?$/i;
const RENAME = new RegExp(String.raw`^rename\s+table\s+(${NAME})\s+to\s+(${NAME})`, 'i');
const REFERENCES = new RegExp(String.raw`references\s+(${NAME})\s*(\([^)]*\))?`, 'i');

/** Apply every schema statement in one SQL file. */
export function applySql(state: SchemaState, sql: string, file: string, firstLine = 1): void {
  for (const statement of statements(sql, firstLine)) {
    const site: Site = { file, line: statement.line };
    const text = statement.text;

    const create = CREATE.exec(text);
    if (create) {
      const tableName = create[1] as string;
      const body = parenthesised(text, create[0].length);
      if (body === null) continue; // CREATE TABLE ... AS SELECT: no column list to read
      state.createTable(tableName, site);
      for (const item of splitTopLevel(body.body)) {
        const line = statement.line + countNewlines(text, 0, body.start + item.offset);
        applyTableElement(state, tableName, item.text, { file, line });
      }
      continue;
    }

    const alter = ALTER.exec(text);
    if (alter) {
      const tableName = alter[1] as string;
      for (const action of splitTopLevel(alter[2] as string)) {
        applyAlter(state, tableName, action.text, site);
      }
      continue;
    }

    const drop = DROP.exec(text);
    if (drop) {
      for (const name of (drop[1] as string).split(',')) state.dropTable(name.trim());
      continue;
    }

    const rename = RENAME.exec(text);
    if (rename) state.renameTable(rename[1] as string, rename[2] as string);
  }
}

/** One element of a CREATE TABLE body: a column or a table constraint. */
function applyTableElement(state: SchemaState, table: string, element: string, site: Site): void {
  const body = element.replace(/^constraint\s+\S+\s+/i, '');
  const pk = /^primary\s+key\s*(\([^)]*\))/i.exec(body);
  if (pk) {
    state.addPrimaryKey(table, columnList(pk[1] as string), site);
    return;
  }
  const fk = /^foreign\s+key\s*(\([^)]*\))\s*/i.exec(body);
  if (fk) {
    const ref = REFERENCES.exec(body.slice(fk[0].length));
    if (ref) {
      state.addForeignKey(table, {
        columns: columnList(fk[1] as string),
        table: ref[1] as string,
        refColumns: ref[2] ? columnList(ref[2]) : [],
        site,
      });
    }
    return;
  }
  if (/^(unique|key|index|check|exclude|fulltext|spatial|period)\b/i.test(body)) return;
  applyColumnDefinition(state, table, element, site);
}

function applyColumnDefinition(state: SchemaState, table: string, definition: string, site: Site): void {
  const match = new RegExp(String.raw`^(${IDENT})\s*([\s\S]*)$`).exec(definition);
  if (!match) return;
  const name = match[1] as string;
  const rest = match[2] as string;
  const type = /^([A-Za-z_][\w ]*?(?:\([^)]*\))?(?:\s*\[\])?)(?=\s|$)/.exec(rest)?.[1]?.trim() ?? null;
  state.addColumn(table, {
    name,
    type: type === null || type === '' ? null : type.toLowerCase(),
    primaryKey: /\bprimary\s+key\b/i.test(rest),
    nullable: /\bnot\s+null\b/i.test(rest) ? false : /\bprimary\s+key\b/i.test(rest) ? false : null,
    site,
  });
  const ref = REFERENCES.exec(rest);
  if (ref) {
    state.addForeignKey(table, {
      columns: [name],
      table: ref[1] as string,
      refColumns: ref[2] ? columnList(ref[2]) : [],
      site,
    });
  }
}

function applyAlter(state: SchemaState, table: string, action: string, site: Site): void {
  const renameTo = new RegExp(String.raw`^rename\s+to\s+(${NAME})`, 'i').exec(action);
  if (renameTo) {
    state.renameTable(table, renameTo[1] as string);
    return;
  }
  const renameColumn = new RegExp(String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`, 'i').exec(action);
  if (renameColumn) {
    state.renameColumn(table, renameColumn[1] as string, renameColumn[2] as string);
    return;
  }
  const dropColumn = new RegExp(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})\s*$`, 'i').exec(action);
  if (dropColumn && !/^drop\s+(constraint|primary|foreign|index|key)\b/i.test(action)) {
    state.dropColumn(table, dropColumn[1] as string);
    return;
  }
  const add = /^add\s+(?!constraint\b|primary\b|foreign\b|unique\b|index\b|key\b|check\b)(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(action);
  if (add) {
    const body = (add[1] as string).trim();
    // MySQL's `ADD (a int, b int)`.
    if (body.startsWith('(')) {
      const inner = parenthesised(body, 0);
      for (const item of splitTopLevel(inner?.body ?? '')) applyColumnDefinition(state, table, item.text, site);
    } else {
      applyColumnDefinition(state, table, body, site);
    }
    return;
  }
  const constraint = /^add\s+([\s\S]+)$/i.exec(action);
  if (constraint) applyTableElement(state, table, constraint[1] as string, site);
}
