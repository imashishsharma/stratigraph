/**
 * The entity-relationship model, read out of ORM mappings.
 *
 * An entity here is a **table** — the thing an ER diagram is about — reached
 * from the `maps_to` edge a parser wrote when it saw `@Entity` and `@Table`
 * together. Its columns are the mapped class's fields, including the ones it
 * inherits, because JPA maps a `@MappedSuperclass` chain into the same table
 * and a diagram that omitted the inherited primary key would be wrong.
 *
 * A relationship needs two things the store may or may not have: a cardinality
 * and a target. The cardinality comes from the JPA annotation on the field.
 * The target comes from the field's own type, or — for a collection, whose type
 * erases to `java.util.List` — from the type argument the extractor records
 * beside it. When the target cannot be read the relationship is **counted and
 * described, never drawn to a guessed table** (ADR-0022).
 */

import type { Db } from '../db/database.js';
import type { LayoutLine, LayoutLinkSpec, LayoutNodeSpec } from './layout.js';

/** JPA association annotations, and the cardinality each one states. */
const CARDINALITY: Record<string, ErCardinality> = {
  'jakarta.persistence.ManyToOne': 'many-to-one',
  'javax.persistence.ManyToOne': 'many-to-one',
  'jakarta.persistence.OneToMany': 'one-to-many',
  'javax.persistence.OneToMany': 'one-to-many',
  'jakarta.persistence.OneToOne': 'one-to-one',
  'javax.persistence.OneToOne': 'one-to-one',
  'jakarta.persistence.ManyToMany': 'many-to-many',
  'javax.persistence.ManyToMany': 'many-to-many',
};

const ID_ANNOTATIONS = new Set([
  'jakarta.persistence.Id',
  'javax.persistence.Id',
  'jakarta.persistence.EmbeddedId',
  'javax.persistence.EmbeddedId',
]);

const MAPPED_SUPERCLASS = new Set([
  'jakarta.persistence.MappedSuperclass',
  'javax.persistence.MappedSuperclass',
]);

const EMBEDDABLE = new Set(['jakarta.persistence.Embeddable', 'javax.persistence.Embeddable']);

/** Fields the ORM never maps to a column. */
const TRANSIENT_ANNOTATIONS = new Set([
  'jakarta.persistence.Transient',
  'javax.persistence.Transient',
]);

export type ErCardinality = 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many';

export interface ErColumn {
  /** The field's name, or the name `@Column` states when it states one. */
  name: string;
  /** The field name, when it differs from the column name. */
  field: string;
  /** The declared Java type, erased. */
  type: string;
  primaryKey: boolean;
  /** True when the column comes from a superclass rather than the entity itself. */
  inherited: boolean;
  /** Where the field was declared. */
  path: string | null;
  line: number | null;
}

export interface ErEntity {
  /** Diagram-safe identifier. */
  id: string;
  /** The table name, which is what the mapping declared. */
  table: string;
  /** The class mapped to it — the inheritance root when several share the table. */
  className: string;
  /** Every class mapped to this table, root first (single-table inheritance). */
  classes: string[];
  columns: ErColumn[];
  path: string | null;
  line: number | null;
}

export interface ErRelationship {
  fromTable: string;
  toTable: string;
  cardinality: ErCardinality;
  /** The field that declares it. */
  via: string;
  path: string | null;
  line: number | null;
}

/**
 * An association the store can see but cannot complete.
 *
 * Always because the target type was never attributed — a collection of a type
 * from a jar nobody read, or a field whose type argument the parser could not
 * resolve. Reported so an empty-looking ER diagram cannot be mistaken for a
 * schema with no relationships in it.
 */
export interface ErUnreadable {
  fromTable: string;
  via: string;
  cardinality: ErCardinality;
  /** What the field's type erased to, which is all we have. */
  declaredType: string;
  reason: string;
  path: string | null;
  line: number | null;
}

export interface ErModel {
  entities: ErEntity[];
  relationships: ErRelationship[];
  unreadable: ErUnreadable[];
  /** Stated omissions, as everywhere else. */
  notes: string[];
}

interface FieldRow {
  id: number;
  fqn: string;
  name: string;
  ownerFqn: string;
  attrs: string | null;
  path: string | null;
  line: number | null;
}

/** Build the ER model for a run. Empty when nothing was mapped to a table. */
export function buildErModel(db: Db, runId: number): ErModel {
  const mappings = loadMappings(db, runId);
  if (mappings.length === 0) {
    return {
      entities: [],
      relationships: [],
      unreadable: [],
      notes: [
        'No class in this run is mapped to a table, so there is no ER model to ' +
          'draw. Only a declared O/R mapping produces one; a schema defined in ' +
          'SQL, XML or a migration tool is invisible to a source parser.',
      ],
    };
  }

  const tableOfClass = new Map(mappings.map((m) => [m.className, m.table]));
  const superclasses = loadSuperclasses(db, runId);
  const classAnnotations = loadClassAnnotations(db, runId);
  const fields = loadFields(db, runId);
  const fieldAnnotations = loadFieldAnnotations(db, runId);

  const byOwner = new Map<string, FieldRow[]>();
  for (const field of fields) {
    const existing = byOwner.get(field.ownerFqn);
    if (existing) existing.push(field);
    else byOwner.set(field.ownerFqn, [field]);
  }

  const isMappedSuperclass = (fqn: string) =>
    (classAnnotations.get(fqn) ?? []).some((a) => MAPPED_SUPERCLASS.has(a));
  const isEmbeddable = (fqn: string) =>
    (classAnnotations.get(fqn) ?? []).some((a) => EMBEDDABLE.has(a));

  // One entity per table. Single-table subclasses map to their root's table,
  // so several mappings can share one; the root — the class with no `root`
  // attribute — names the entity, and the others are listed with it.
  const byTable = new Map<string, Mapping[]>();
  for (const mapping of mappings) {
    const existing = byTable.get(mapping.table);
    if (existing) existing.push(mapping);
    else byTable.set(mapping.table, [mapping]);
  }

  const entities: ErEntity[] = [];
  const relationships: ErRelationship[] = [];
  const unreadable: ErUnreadable[] = [];

  for (const [table, group] of byTable) {
    const ordered = [...group].sort(
      (a, b) => Number(a.root !== null) - Number(b.root !== null) || depthOf(a.className, superclasses) - depthOf(b.className, superclasses),
    );
    const primary = ordered[0] as Mapping;
    const columns: ErColumn[] = [];
    const seen = new Set<string>();
    const push = (column: ErColumn) => {
      if (seen.has(column.name)) return;
      seen.add(column.name);
      columns.push(column);
    };

    for (const mapping of ordered) {
      // The class's own chain up to the next entity: mapped superclasses
      // contribute their fields, top-down; any other non-entity class
      // contributes nothing (JPA: its state is not persistent).
      const chain = ancestry(mapping.className, superclasses);
      const upToEntity: string[] = [mapping.className];
      let parentEntity: string | null = null;
      for (const ancestor of chain.slice(1)) {
        if (tableOfClass.has(ancestor)) {
          parentEntity = ancestor;
          break;
        }
        upToEntity.push(ancestor);
      }

      // A joined child's table is keyed by its parent's primary key.
      if (parentEntity !== null && mapping.inheritance === 'JOINED') {
        for (const column of primaryKeyColumns(parentEntity)) push({ ...column, inherited: true });
      }

      for (const owner of [...upToEntity].reverse()) {
        if (owner !== mapping.className && !isMappedSuperclass(owner)) continue;
        for (const field of byOwner.get(owner) ?? []) {
          addField(mapping, field, owner !== mapping.className && mapping.root === null);
        }
      }

      function primaryKeyColumns(entity: string): ErColumn[] {
        const keys: ErColumn[] = [];
        for (const owner of ancestry(entity, superclasses)) {
          if (owner !== entity && !isMappedSuperclass(owner) && !tableOfClass.has(owner)) continue;
          for (const field of byOwner.get(owner) ?? []) {
            const annotations = fieldAnnotations.get(field.id) ?? [];
            const attrs = parseAttrs(field.attrs);
            if (attrs['id'] === true || annotations.some((a) => ID_ANNOTATIONS.has(a))) {
              keys.push(toColumn(mapping, field, attrs, annotations, true));
            }
          }
        }
        return keys;
      }

      function addField(target: Mapping, field: FieldRow, inherited: boolean): void {
        const annotations = fieldAnnotations.get(field.id) ?? [];
        const attrs = parseAttrs(field.attrs);
        const modifiers = Array.isArray(attrs['modifiers']) ? attrs['modifiers'] : [];
        if (modifiers.includes('static') || modifiers.includes('transient')) return;
        if (annotations.some((a) => TRANSIENT_ANNOTATIONS.has(a))) return;

        const association = annotations.find((a) => a in CARDINALITY);
        const type = typeof attrs['type'] === 'string' ? attrs['type'] : '?';

        if (association !== undefined) {
          // The inverse side of a bidirectional association holds no key; the
          // owning side draws it (ADR-0036).
          if (typeof attrs['mappedBy'] === 'string') return;
          recordRelationship({
            mapping: { ...target, table },
            field,
            attrs,
            type,
            cardinality: CARDINALITY[association] as ErCardinality,
            tableOfClass,
            relationships,
            unreadable,
          });
          return;
        }

        const primaryKey = attrs['id'] === true || annotations.some((a) => ID_ANNOTATIONS.has(a));
        if (attrs['embedded'] === true || isEmbeddable(type)) {
          for (const part of byOwner.get(type) ?? []) {
            const partAttrs = parseAttrs(part.attrs);
            const partModifiers = Array.isArray(partAttrs['modifiers']) ? partAttrs['modifiers'] : [];
            if (partModifiers.includes('static') || partModifiers.includes('transient')) continue;
            push({ ...toColumn(target, part, partAttrs, [], primaryKey), inherited });
          }
          return;
        }
        push({ ...toColumn(target, field, attrs, annotations, primaryKey), inherited });
      }
    }

    entities.push({
      id: entityId(table),
      table,
      className: primary.className,
      classes: ordered.map((mapping) => mapping.className),
      columns,
      path: primary.path,
      line: primary.line,
    });
  }

  entities.sort((a, b) => a.table.localeCompare(b.table));
  relationships.sort(
    (a, b) =>
      a.fromTable.localeCompare(b.fromTable) ||
      a.toTable.localeCompare(b.toTable) ||
      a.via.localeCompare(b.via),
  );
  unreadable.sort((a, b) => a.fromTable.localeCompare(b.fromTable) || a.via.localeCompare(b.via));

  return { entities, relationships, unreadable, notes: notesFor(entities, unreadable) };
}

/** A field as a column, named the way the mapping's naming strategy names it. */
function toColumn(
  mapping: Mapping,
  field: FieldRow,
  attrs: Record<string, unknown>,
  annotations: string[],
  primaryKey: boolean,
): ErColumn {
  const type = typeof attrs['type'] === 'string' ? attrs['type'] : '?';
  const logical = typeof attrs['column'] === 'string' ? attrs['column'] : field.name;
  return {
    name: physicalName(logical, mapping.strategy),
    field: field.name,
    type: shortType(type),
    primaryKey: primaryKey || attrs['id'] === true || annotations.some((a) => ID_ANNOTATIONS.has(a)),
    inherited: false,
    path: field.path,
    line: field.line,
  };
}

/**
 * The physical name a naming strategy gives a logical one — the same rule the
 * Java extractor applied to the table, named on the `maps_to` edge (ADR-0036).
 */
export function physicalName(logical: string, strategy: string | null): string {
  if (logical.length > 1 && (logical.startsWith('`') || logical.startsWith('"'))) {
    return logical.slice(1, -1);
  }
  if (strategy !== 'spring-boot-snake-case') return logical;
  const chars = [...logical.replace(/\./g, '_')];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    const before = chars[i - 1];
    const after = chars[i + 1];
    if (
      i > 0 &&
      i < chars.length - 1 &&
      before !== undefined &&
      after !== undefined &&
      (isLower(before) || isDigit(before)) &&
      isUpper(c) &&
      (isLower(after) || isDigit(after))
    ) {
      out.push('_');
    }
    out.push(c);
  }
  return out.join('').toLowerCase();
}

function isLower(c: string): boolean {
  return c !== c.toUpperCase() && c === c.toLowerCase();
}
function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function depthOf(className: string, superclasses: Map<string, string>): number {
  return ancestry(className, superclasses).length;
}

function recordRelationship(input: {
  mapping: Mapping;
  field: FieldRow;
  attrs: Record<string, unknown>;
  type: string;
  cardinality: ErCardinality;
  tableOfClass: Map<string, string>;
  relationships: ErRelationship[];
  unreadable: ErUnreadable[];
}): void {
  const { mapping, field, attrs, type, cardinality, tableOfClass } = input;

  // The field's own type first — a `@ManyToOne Customer` names its target
  // outright. Then the recorded type arguments, which is where a collection
  // keeps the target its erased type dropped.
  const candidates = [type, ...typeArguments(attrs)];
  const target = candidates.find((candidate) => tableOfClass.has(candidate));

  if (target !== undefined) {
    input.relationships.push({
      fromTable: mapping.table,
      toTable: tableOfClass.get(target) as string,
      cardinality,
      via: field.name,
      path: field.path,
      line: field.line,
    });
    return;
  }

  input.unreadable.push({
    fromTable: mapping.table,
    via: field.name,
    cardinality,
    declaredType: type,
    reason:
      typeArguments(attrs).length === 0
        ? `the declared type erases to ${shortType(type)} and no type argument was attributed`
        : `no type it names (${typeArguments(attrs).map(shortType).join(', ')}) is mapped to a table in this run`,
    path: field.path,
    line: field.line,
  });
}

function notesFor(entities: ErEntity[], unreadable: ErUnreadable[]): string[] {
  const notes: string[] = [
    'Every table here was declared by an O/R mapping a parser read. A table ' +
      'that exists only in SQL, in a migration or in a view is not in this ' +
      'diagram, and its absence is not evidence that it does not exist.',
    'Column types are the declared Java types, not the SQL types the provider ' +
      'chose. Nothing in the source states the latter.',
  ];
  if (unreadable.length > 0) {
    notes.push(
      `${unreadable.length} declared association(s) could not be drawn because ` +
        'their target could not be read. They are listed below rather than ' +
        'guessed at from the field name.',
    );
  }
  if (entities.length > 0 && entities.every((entity) => entity.columns.length === 0)) {
    notes.push('No column was readable on any entity — check the extractor diagnostics.');
  }
  return notes;
}

interface Mapping {
  className: string;
  table: string;
  path: string | null;
  line: number | null;
  /** The naming strategy the extractor applied, from the edge; null when it recorded none. */
  strategy: string | null;
  /** `JOINED`, `SINGLE_TABLE`, `TABLE_PER_CLASS`, or null outside a hierarchy. */
  inheritance: string | null;
  /** The single-table root this class shares a table with, or null. */
  root: string | null;
}

function loadMappings(db: Db, runId: number): Mapping[] {
  return db
    .prepare(
      /* sql */ `
      SELECT src.fqn AS className, dst.fqn AS table_, f.path AS path, src.start_line AS line,
             e.attrs AS attrs
        FROM edge e
        JOIN node src ON src.id = e.src_id
        JOIN node dst ON dst.id = e.dst_id AND dst.kind = 'table'
        LEFT JOIN source_file f ON f.id = src.file_id
       WHERE e.run_id = @runId AND e.kind = 'maps_to' AND e.confidence = 'fact'
       ORDER BY dst.fqn`,
    )
    .all({ runId })
    .map((row) => {
      const typed = row as {
        className: string;
        table_: string;
        path: string | null;
        line: number | null;
        attrs: string | null;
      };
      const attrs = parseAttrs(typed.attrs);
      return {
        className: typed.className,
        table: typed.table_,
        path: typed.path,
        line: typed.line,
        strategy: typeof attrs['strategy'] === 'string' ? attrs['strategy'] : null,
        inheritance: typeof attrs['inheritance'] === 'string' ? attrs['inheritance'] : null,
        root: typeof attrs['root'] === 'string' ? attrs['root'] : null,
      };
    });
}

/** Direct superclass per class, for walking a mapped-superclass chain. */
function loadSuperclasses(db: Db, runId: number): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT src.fqn AS child, dst.fqn AS parent
         FROM edge e
         JOIN node src ON src.id = e.src_id
         JOIN node dst ON dst.id = e.dst_id
        WHERE e.run_id = @runId AND e.kind = 'extends' AND e.confidence = 'fact'`,
    )
    .all({ runId }) as Array<{ child: string; parent: string }>;
  return new Map(rows.map((row) => [row.child, row.parent]));
}

/**
 * A class and its superclasses, nearest first.
 *
 * Bounded rather than trusting the graph to be acyclic: an `extends` cycle is
 * impossible in valid Java and perfectly possible in a fact table assembled
 * from a repository that does not compile.
 */
function ancestry(className: string, superclasses: Map<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current !== undefined && !seen.has(current) && chain.length < 16) {
    chain.push(current);
    seen.add(current);
    current = superclasses.get(current);
  }
  return chain;
}

function loadFields(db: Db, runId: number): FieldRow[] {
  return db
    .prepare(
      /* sql */ `
      SELECT n.id AS id, n.fqn AS fqn, n.name AS name, p.fqn AS ownerFqn,
             n.attrs AS attrs, f.path AS path, n.start_line AS line
        FROM node n
        JOIN node p ON p.id = n.parent_id
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = @runId AND n.kind = 'field' AND n.is_stub = 0
       ORDER BY n.id`,
    )
    .all({ runId }) as FieldRow[];
}

/** Annotations on types, for `@MappedSuperclass` and `@Embeddable`. */
function loadClassAnnotations(db: Db, runId: number): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT src.fqn AS owner, dst.fqn AS annotation
         FROM edge e
         JOIN node src ON src.id = e.src_id AND src.kind IN ('class', 'interface', 'enum')
         JOIN node dst ON dst.id = e.dst_id
        WHERE e.run_id = @runId AND e.kind = 'annotated_with'`,
    )
    .all({ runId }) as Array<{ owner: string; annotation: string }>;
  const byClass = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byClass.get(row.owner);
    if (existing) existing.push(row.annotation);
    else byClass.set(row.owner, [row.annotation]);
  }
  return byClass;
}

function loadFieldAnnotations(db: Db, runId: number): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT e.src_id AS fieldId, dst.fqn AS annotation
         FROM edge e
         JOIN node src ON src.id = e.src_id AND src.kind = 'field'
         JOIN node dst ON dst.id = e.dst_id
        WHERE e.run_id = @runId AND e.kind = 'annotated_with'`,
    )
    .all({ runId }) as Array<{ fieldId: number; annotation: string }>;

  const byField = new Map<number, string[]>();
  for (const row of rows) {
    const existing = byField.get(row.fieldId);
    if (existing) existing.push(row.annotation);
    else byField.set(row.fieldId, [row.annotation]);
  }
  return byField;
}

function parseAttrs(attrs: string | null): Record<string, unknown> {
  if (attrs === null) return {};
  try {
    const parsed: unknown = JSON.parse(attrs);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    /* c8 ignore next */
    return {};
  }
}

function typeArguments(attrs: Record<string, unknown>): string[] {
  const value = attrs['typeArguments'];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `java.lang.String` reads as `String` in a column list, and loses nothing. */
export function shortType(type: string): string {
  const generic = type.replace(/^java\.(lang|util|time|math)\./, '');
  return generic.includes('.') ? (generic.split('.').pop() ?? generic) : generic;
}

export function entityId(table: string): string {
  return `er_${table.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table'}`;
}

/** Crow's-foot in words, for a label and a table cell. */
export const CARDINALITY_LABEL: Record<ErCardinality, string> = {
  'many-to-one': 'many → 1',
  'one-to-many': '1 → many',
  'one-to-one': '1 → 1',
  'many-to-many': 'many ↔ many',
};

/** How many columns a single entity box will show before it says "and N more". */
const COLUMNS_PER_BOX = 10;

/**
 * The ER model as boxes and links the shared layout can place.
 *
 * The primary key sorts first and inherited columns last, which is how anyone
 * reads a table definition, and is the order that makes two entities sharing a
 * mapped superclass line up visually.
 */
export function erLayoutInput(model: ErModel): {
  nodes: LayoutNodeSpec[];
  links: LayoutLinkSpec[];
} {
  const nodes: LayoutNodeSpec[] = model.entities.map((entity) => {
    const lines: LayoutLine[] = [
      { text: entity.table, emphasis: 'name' },
      { text: `«${shortType(entity.className)}»`, emphasis: 'stereotype' },
    ];

    const ordered = [...entity.columns].sort(
      (a, b) =>
        Number(b.primaryKey) - Number(a.primaryKey) ||
        Number(a.inherited) - Number(b.inherited) ||
        a.name.localeCompare(b.name),
    );
    for (const column of ordered.slice(0, COLUMNS_PER_BOX)) {
      const marks = [column.primaryKey ? 'PK' : '', column.inherited ? '^' : '']
        .filter(Boolean)
        .join('');
      lines.push({
        text: `${marks === '' ? '' : `${marks} `}${column.name}: ${column.type}`,
        emphasis: 'member',
      });
    }
    if (ordered.length > COLUMNS_PER_BOX) {
      lines.push({
        text: `… and ${ordered.length - COLUMNS_PER_BOX} more`,
        emphasis: 'detail',
      });
    }

    return {
      id: entity.id,
      kind: 'entity' as const,
      lines,
      inference: false,
      compartment: true,
      dividerAfter: 2,
    };
  });

  const links: LayoutLinkSpec[] = model.relationships.map((relationship) => ({
    from: entityId(relationship.fromTable),
    to: entityId(relationship.toTable),
    label: `${relationship.via} (${CARDINALITY_LABEL[relationship.cardinality]})`,
    confidence: 'fact' as const,
    style: 'association' as const,
  }));

  return { nodes, links };
}
