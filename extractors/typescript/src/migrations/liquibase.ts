/**
 * Liquibase changelogs — XML, YAML and JSON (ADR-0037).
 *
 * Read as data, not executed: every change type that shapes the schema is
 * applied to a {@link SchemaState} in changelog order, following `include` and
 * `includeAll` the way Liquibase does. Preconditions, contexts and `dbms`
 * filters are not evaluated; the schema is the union of what every changeset
 * would create, which for a multi-dialect changelog is the same tables.
 */

import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';

import { SchemaState, type Site } from './schema.js';
import { applySql } from './sql.js';

export interface ChangelogHost {
  /** File text by repo-relative path, or null when it does not exist. */
  read(path: string): string | null;
  /** Resolve an include from `from` to a repo-relative path, or null. */
  resolve(from: string, reference: string, relativeToChangelog: boolean): string | null;
  /** Files under an includeAll directory, sorted as Liquibase sorts them. */
  list(from: string, directory: string, relativeToChangelog: boolean): string[];
  /** Called once per changelog actually read, for the file fact. */
  seen(path: string, language: string): void;
  warn(message: string, file: string, line?: number): void;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
  line: number;
  /** Offset just after the tag, for reading element text. */
  end: number;
  start: number;
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function tags(xml: string): Tag[] {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const out: Tag[] = [];
  let line = 1;
  let last = 0;
  for (const match of clean.matchAll(TAG)) {
    const index = match.index ?? 0;
    for (let i = last; i < index; i += 1) if (clean[i] === '\n') line += 1;
    last = index;
    const attrs: Record<string, string> = {};
    for (const attr of (match[3] ?? '').matchAll(ATTR)) {
      attrs[localName(attr[1] as string)] = decode(attr[2] ?? attr[3] ?? '');
    }
    out.push({
      name: localName(match[2] as string),
      attrs,
      closing: match[1] === '/',
      selfClosing: match[4] === '/',
      line,
      start: index,
      end: index + match[0].length,
    });
  }
  return out;
}

function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function list(text: string | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `references="jhi_user(id)"` → table and columns. */
function parseReference(text: string): { table: string; columns: string[] } | null {
  const match = /^\s*([^()\s]+)\s*(?:\(([^)]*)\))?\s*$/.exec(text);
  return match ? { table: match[1] as string, columns: list(match[2]) } : null;
}

export class LiquibaseReader {
  private readonly visited = new Set<string>();

  constructor(
    private readonly state: SchemaState,
    private readonly host: ChangelogHost,
  ) {}

  read(path: string): void {
    if (this.visited.has(path)) return;
    this.visited.add(path);
    const text = this.host.read(path);
    if (text === null) return;
    const lower = path.toLowerCase();
    if (lower.endsWith('.xml')) {
      this.host.seen(path, 'liquibase-xml');
      this.readXml(path, text);
    } else if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.json')) {
      this.host.seen(path, lower.endsWith('.json') ? 'liquibase-json' : 'liquibase-yaml');
      this.readYaml(path, text);
    } else if (lower.endsWith('.sql')) {
      this.host.seen(path, 'sql');
      applySql(this.state, text, path);
    }
  }

  // ------------------------------------------------------------------ XML

  private readXml(path: string, xml: string): void {
    const all = tags(xml);
    let table: { name: string; kind: 'create' | 'add' } | null = null;
    for (let i = 0; i < all.length; i += 1) {
      const tag = all[i] as Tag;
      if (tag.closing) {
        if (tag.name === 'createTable' || tag.name === 'addColumn') table = null;
        continue;
      }
      const a = tag.attrs;
      const site: Site = { file: path, line: tag.line };
      switch (tag.name) {
        case 'include':
          if (a['file']) this.include(path, a['file'], a['relativeToChangelogFile'] === 'true', site);
          break;
        case 'includeAll':
          if (a['path']) {
            for (const child of this.host.list(path, a['path'], a['relativeToChangelogFile'] === 'true')) {
              this.read(child);
            }
          }
          break;
        case 'createTable':
          if (a['tableName']) {
            const name = qualify(a['schemaName'], a['tableName']);
            this.state.createTable(name, site);
            table = tag.selfClosing ? null : { name, kind: 'create' };
          }
          break;
        case 'addColumn':
          if (a['tableName']) {
            table = tag.selfClosing ? null : { name: qualify(a['schemaName'], a['tableName']), kind: 'add' };
          }
          break;
        case 'column':
          if (table !== null && a['name']) {
            const constraints = !tag.selfClosing && all[i + 1]?.name === 'constraints' ? all[i + 1] : undefined;
            this.column(table.name, a['name'], a['type'] ?? null, constraints?.attrs ?? {}, site);
          }
          break;
        case 'dropTable':
          if (a['tableName']) this.state.dropTable(qualify(a['schemaName'], a['tableName']));
          break;
        case 'renameTable':
          if (a['oldTableName'] && a['newTableName']) {
            this.state.renameTable(qualify(a['schemaName'], a['oldTableName']), qualify(a['schemaName'], a['newTableName']));
          }
          break;
        case 'dropColumn':
          if (a['tableName'] && a['columnName']) {
            this.state.dropColumn(qualify(a['schemaName'], a['tableName']), a['columnName']);
          }
          break;
        case 'renameColumn':
          if (a['tableName'] && a['oldColumnName'] && a['newColumnName']) {
            this.state.renameColumn(qualify(a['schemaName'], a['tableName']), a['oldColumnName'], a['newColumnName']);
          }
          break;
        case 'addForeignKeyConstraint':
          if (a['baseTableName'] && a['referencedTableName']) {
            this.state.addForeignKey(qualify(a['baseTableSchemaName'], a['baseTableName']), {
              columns: list(a['baseColumnNames']),
              table: qualify(a['referencedTableSchemaName'], a['referencedTableName']),
              refColumns: list(a['referencedColumnNames']),
              site,
            });
          }
          break;
        case 'addPrimaryKey':
          if (a['tableName']) {
            this.state.addPrimaryKey(qualify(a['schemaName'], a['tableName']), list(a['columnNames']), site);
          }
          break;
        case 'sql':
          if (!tag.selfClosing) {
            const close = all.slice(i + 1).find((t) => t.closing && t.name === 'sql');
            if (close) {
              const body = xml.slice(tag.end, close.start).replace(/<!\[CDATA\[|\]\]>/g, (m) => ' '.repeat(m.length));
              applySql(this.state, decode(body), path, tag.line);
            }
          }
          break;
        case 'sqlFile':
          if (a['path']) {
            const target = this.host.resolve(path, a['path'], a['relativeToChangelogFile'] === 'true');
            const text = target === null ? null : this.host.read(target);
            if (target !== null && text !== null) {
              this.host.seen(target, 'sql');
              applySql(this.state, text, target);
            } else {
              this.host.warn(`sqlFile ${a['path']} could not be found; its changes are not in the schema`, path, tag.line);
            }
          }
          break;
        default:
          break;
      }
    }
  }

  private column(table: string, name: string, type: string | null, c: Record<string, string>, site: Site): void {
    this.state.addColumn(table, {
      name,
      type: type === null ? null : type.toLowerCase(),
      primaryKey: c['primaryKey'] === 'true',
      nullable: c['nullable'] === 'false' ? false : c['nullable'] === 'true' ? true : null,
      site,
    });
    const reference = c['references'] ? parseReference(c['references']) : null;
    const target = c['referencedTableName'] ?? reference?.table;
    if (target) {
      this.state.addForeignKey(table, {
        columns: [name],
        table: target,
        refColumns: c['referencedColumnNames'] ? list(c['referencedColumnNames']) : reference?.columns ?? [],
        site,
      });
    }
  }

  private include(from: string, reference: string, relative: boolean, site: Site): void {
    const target = this.host.resolve(from, reference, relative);
    if (target === null) {
      this.host.warn(`included changelog ${reference} could not be found; its changes are not in the schema`, site.file, site.line);
      return;
    }
    this.read(target);
  }

  // ----------------------------------------------------------- YAML/JSON

  private readYaml(path: string, text: string): void {
    const counter = new LineCounter();
    let doc;
    try {
      doc = parseDocument(text, { lineCounter: counter });
    } catch {
      this.host.warn('changelog could not be parsed as YAML/JSON', path);
      return;
    }
    const lineOf = (node: unknown): number => {
      const range = (node as { range?: [number, number, number] } | null)?.range;
      return range ? counter.linePos(range[0]).line : 1;
    };
    const root = doc.contents;
    const changelog = isMap(root) ? root.get('databaseChangeLog', true) : null;
    if (!isSeq(changelog)) return;

    for (const entry of changelog.items) {
      if (!isMap(entry)) continue;
      const include = entry.get('include', true);
      if (isMap(include)) {
        const file = scalar(include.get('file', true));
        if (file) this.include(path, file, scalar(include.get('relativeToChangelogFile', true)) === 'true', { file: path, line: lineOf(include) });
        continue;
      }
      const includeAll = entry.get('includeAll', true);
      if (isMap(includeAll)) {
        const dir = scalar(includeAll.get('path', true));
        if (dir) {
          for (const child of this.host.list(path, dir, scalar(includeAll.get('relativeToChangelogFile', true)) === 'true')) {
            this.read(child);
          }
        }
        continue;
      }
      const changeSet = entry.get('changeSet', true);
      if (!isMap(changeSet)) continue;
      const changes = changeSet.get('changes', true);
      if (!isSeq(changes)) continue;
      for (const change of changes.items) {
        if (!isMap(change)) continue;
        for (const pair of change.items) {
          if (!isPair(pair) || !isScalar(pair.key) || !isMap(pair.value)) continue;
          this.yamlChange(String(pair.key.value), pair.value as YamlNode, { file: path, line: lineOf(pair.key) }, lineOf);
        }
      }
    }
  }

  private yamlChange(
    type: string,
    node: YamlNode,
    site: Site,
    lineOf: (node: unknown) => number,
  ): void {
    if (!isMap(node)) return;
    const get = (name: string) => scalar(node.get(name, true));
    const table = get('tableName') ? qualify(get('schemaName'), get('tableName') as string) : null;
    const columns = () => {
      const items = node.get('columns', true);
      if (!isSeq(items) || table === null) return;
      for (const item of items.items) {
        const column = isMap(item) ? item.get('column', true) : null;
        if (!isMap(column)) continue;
        const name = scalar(column.get('name', true));
        if (!name) continue;
        const constraints: Record<string, string> = {};
        const c = column.get('constraints', true);
        if (isMap(c)) {
          for (const pair of c.items) {
            if (isPair(pair) && isScalar(pair.key) && isScalar(pair.value)) {
              constraints[String(pair.key.value)] = String(pair.value.value);
            }
          }
        }
        this.column(table, name, scalar(column.get('type', true)) ?? null, constraints, { file: site.file, line: lineOf(item) });
      }
    };

    switch (type) {
      case 'createTable':
        if (table !== null) {
          this.state.createTable(table, site);
          columns();
        }
        break;
      case 'addColumn':
        columns();
        break;
      case 'dropTable':
        if (table !== null) this.state.dropTable(table);
        break;
      case 'renameTable': {
        const from = get('oldTableName');
        const to = get('newTableName');
        if (from && to) this.state.renameTable(qualify(get('schemaName'), from), qualify(get('schemaName'), to));
        break;
      }
      case 'dropColumn':
        if (table !== null && get('columnName')) this.state.dropColumn(table, get('columnName') as string);
        break;
      case 'renameColumn':
        if (table !== null && get('oldColumnName') && get('newColumnName')) {
          this.state.renameColumn(table, get('oldColumnName') as string, get('newColumnName') as string);
        }
        break;
      case 'addForeignKeyConstraint': {
        const base = get('baseTableName');
        const target = get('referencedTableName');
        if (base && target) {
          this.state.addForeignKey(qualify(get('baseTableSchemaName'), base), {
            columns: list(get('baseColumnNames')),
            table: qualify(get('referencedTableSchemaName'), target),
            refColumns: list(get('referencedColumnNames')),
            site,
          });
        }
        break;
      }
      case 'addPrimaryKey':
        if (table !== null) this.state.addPrimaryKey(table, list(get('columnNames')), site);
        break;
      case 'sql': {
        const sql = get('sql');
        if (sql) applySql(this.state, sql, site.file, site.line);
        break;
      }
      default:
        break;
    }
  }
}

function scalar(node: unknown): string | undefined {
  if (isScalar(node) && node.value !== null && node.value !== undefined) return String(node.value);
  return undefined;
}

function qualify(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}
