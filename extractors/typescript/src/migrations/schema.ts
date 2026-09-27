/**
 * The database as the migrations leave it (ADR-0037).
 *
 * Changes are applied in the order the migration tool would apply them —
 * create, add, rename, drop — and only the final state is emitted, each table
 * and column cited at the change that created it. A table dropped later is not
 * in the schema; a renamed one keeps its creation site and takes its new name.
 */

export interface Site {
  file: string;
  line: number;
}

export interface Column {
  name: string;
  type: string | null;
  primaryKey: boolean;
  nullable: boolean | null;
  site: Site;
}

export interface ForeignKey {
  columns: string[];
  table: string;
  refColumns: string[];
  site: Site;
}

export interface Table {
  /** As first written, schema-qualified when the migration qualified it. */
  name: string;
  site: Site;
  columns: Map<string, Column>;
  foreignKeys: ForeignKey[];
}

/** Identifier as written, without its quoting. */
export function unquote(identifier: string): string {
  return identifier
    .split('.')
    .map((part) => part.trim().replace(/^[`"[]|[`"\]]$/g, ''))
    .join('.');
}

/** Identity: case-insensitive, like the fact store's table fqn. */
export function key(identifier: string): string {
  return unquote(identifier).toLowerCase();
}

export class SchemaState {
  readonly tables = new Map<string, Table>();

  createTable(name: string, site: Site): Table {
    const k = key(name);
    const existing = this.tables.get(k);
    if (existing) return existing; // CREATE TABLE IF NOT EXISTS, or a dialect variant
    const table: Table = { name: unquote(name), site, columns: new Map(), foreignKeys: [] };
    this.tables.set(k, table);
    return table;
  }

  /** A table referenced by a change but never created: created at that change, as the tool would fail otherwise. */
  private table(name: string, site: Site): Table {
    return this.tables.get(key(name)) ?? this.createTable(name, site);
  }

  addColumn(tableName: string, column: Column): void {
    const table = this.table(tableName, column.site);
    const k = key(column.name);
    const existing = table.columns.get(k);
    if (existing) {
      existing.primaryKey ||= column.primaryKey;
      existing.type ??= column.type;
      return;
    }
    table.columns.set(k, { ...column, name: unquote(column.name) });
  }

  addPrimaryKey(tableName: string, columns: string[], site: Site): void {
    const table = this.table(tableName, site);
    for (const name of columns) {
      const column = table.columns.get(key(name));
      if (column) column.primaryKey = true;
      else table.columns.set(key(name), { name: unquote(name), type: null, primaryKey: true, nullable: false, site });
    }
  }

  addForeignKey(tableName: string, fk: ForeignKey): void {
    const table = this.table(tableName, fk.site);
    const already = table.foreignKeys.some(
      (existing) =>
        existing.columns.join(',').toLowerCase() === fk.columns.join(',').toLowerCase() &&
        key(existing.table) === key(fk.table),
    );
    if (!already) table.foreignKeys.push({ ...fk, table: unquote(fk.table) });
  }

  dropTable(name: string): void {
    const k = key(name);
    this.tables.delete(k);
    for (const table of this.tables.values()) {
      table.foreignKeys = table.foreignKeys.filter((fk) => key(fk.table) !== k);
    }
  }

  renameTable(from: string, to: string): void {
    const k = key(from);
    const table = this.tables.get(k);
    if (!table) return;
    this.tables.delete(k);
    table.name = unquote(to);
    this.tables.set(key(to), table);
    for (const other of this.tables.values()) {
      for (const fk of other.foreignKeys) if (key(fk.table) === k) fk.table = unquote(to);
    }
  }

  dropColumn(tableName: string, column: string): void {
    const table = this.tables.get(key(tableName));
    if (!table) return;
    table.columns.delete(key(column));
    table.foreignKeys = table.foreignKeys.filter(
      (fk) => !fk.columns.some((name) => key(name) === key(column)),
    );
  }

  renameColumn(tableName: string, from: string, to: string): void {
    const table = this.tables.get(key(tableName));
    const column = table?.columns.get(key(from));
    if (!table || !column) return;
    table.columns.delete(key(from));
    column.name = unquote(to);
    table.columns.set(key(to), column);
    for (const fk of table.foreignKeys) {
      fk.columns = fk.columns.map((name) => (key(name) === key(from) ? unquote(to) : name));
    }
  }
}
