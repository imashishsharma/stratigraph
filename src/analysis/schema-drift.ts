/**
 * Where the classes and the database disagree — ADR-0037.
 *
 * Only asked when both sides were read: a run with no migrations says nothing
 * about the database, and a run with no mappings (MyBatis, JDBI, plain JDBC)
 * has no classes to disagree with it. Each finding cites both sides it
 * compares, so it can be checked by opening two files.
 */

import type { Db } from '../db/database.js';
import { buildErModel } from './data-model.js';

export const RULE = 'schema-drift';

export interface SchemaDrift {
  /** Mapped columns no migration creates. */
  unbackedColumns: number;
  /** Mapped tables no migration creates. */
  unmigratedTables: number;
  /** Migrated tables no class maps and no join-table shape explains. */
  unmappedTables: number;
  /** False when one side was missing, so nothing was compared. */
  compared: boolean;
}

export function detectSchemaDrift(db: Db, runId: number): SchemaDrift {
  const model = buildErModel(db, runId);
  const migrated = model.entities.filter((entity) => entity.source !== 'jpa');
  const mapped = model.entities.filter((entity) => entity.source !== 'migration');
  const result: SchemaDrift = { unbackedColumns: 0, unmigratedTables: 0, unmappedTables: 0, compared: false };

  db.transaction(() => {
    db.prepare('DELETE FROM finding WHERE run_id = ? AND rule = ?').run(runId, RULE);
    if (migrated.length === 0 || mapped.length === 0) return;
    result.compared = true;

    const fileId = db.prepare('SELECT id FROM source_file WHERE run_id = ? AND path = ?');
    const insertFinding = db.prepare(
      `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
       VALUES (@runId, @rule, @title, @detail, @severity, 'algorithm')`,
    );
    const insertCitation = db.prepare(
      `INSERT INTO citation (finding_id, kind, file_id, line) VALUES (?, 'file', ?, ?)`,
    );
    const record = (
      title: string,
      detail: string,
      severity: 'low' | 'medium',
      sites: Array<{ path: string | null; line: number | null }>,
    ) => {
      const id = Number(insertFinding.run({ runId, rule: RULE, title, detail, severity }).lastInsertRowid);
      for (const site of sites) {
        if (site.path === null) continue;
        const file = fileId.get(runId, site.path) as { id: number } | undefined;
        if (file) insertCitation.run(id, file.id, site.line);
      }
    };

    for (const entity of model.entities) {
      const cls = entity.className ?? '';
      const short = cls.split('.').pop() ?? cls;
      if (entity.source === 'both') {
        for (const column of entity.unbacked) {
          result.unbackedColumns += 1;
          record(
            `${short}.${column.field} maps to column ${entity.table}.${column.name}, which no migration creates`,
            `The class ${cls} maps field ${column.field} to column ${column.name} of table ` +
              `${entity.table}. The migrations create ${entity.table} (${site(entity)}) without that ` +
              'column, so either the column is created outside the migrations or the mapping ' +
              'will fail against a migrated database.',
            'medium',
            [{ path: column.path, line: column.line }, { path: entity.path, line: entity.line }],
          );
        }
      } else if (entity.source === 'jpa') {
        result.unmigratedTables += 1;
        record(
          `${short} maps to table ${entity.table}, which no migration creates`,
          `${cls} is mapped to ${entity.table}, and no migration or DDL file read in this run ` +
            'creates a table of that name. It may be created by schema generation, by a ' +
            'migration outside the paths read, or not at all.',
          'medium',
          [{ path: entity.path, line: entity.line }],
        );
      } else if (!isJoinTable(entity.table, model.relationships, entity.columns.length)) {
        result.unmappedTables += 1;
        record(
          `Table ${entity.table} is created by a migration and mapped by no class`,
          `The migrations create ${entity.table} (${site(entity)}), and no @Entity in this run ` +
            'maps to it. It may be used through SQL, by another application, or not at all.',
          'low',
          [{ path: entity.path, line: entity.line }],
        );
      }
    }
  })();
  return result;
}

function site(entity: { path: string | null; line: number | null }): string {
  return entity.path === null ? 'location not recorded' : `${entity.path}:${entity.line ?? '?'}`;
}

/**
 * A many-to-many join table has no entity by design: at least two foreign
 * keys, and no more columns than its keys plus one. A shape test, stated as
 * one, so a join table is not reported as unmapped.
 */
function isJoinTable(
  table: string,
  relationships: ReadonlyArray<{ fromTable: string }>,
  columns: number,
): boolean {
  const keys = relationships.filter((r) => r.fromTable.toLowerCase() === table.toLowerCase()).length;
  return keys >= 2 && columns <= keys + 1;
}
