/**
 * C4 level 4 — code. One class diagram per package.
 *
 * Everything drawn here was declared: a type's kind, its members and their
 * declared types, the stereotype an annotation gave it, and the three edge
 * kinds UML cares about. Nothing is inferred, and nothing is a model's opinion.
 *
 * Per package rather than per repository, because 200 classes on one canvas is
 * a texture, not a diagram — and per package rather than per cluster because a
 * package is something the source states, while a cluster is something an
 * algorithm decided (ADR-0022).
 */

import type { Db } from '../db/database.js';
import type { LayoutLine, LayoutLinkSpec, LayoutNodeSpec } from './layout.js';

/** Members listed per box before it says "and N more". */
const MEMBERS_PER_BOX = 8;

/**
 * Framework annotations worth printing as a stereotype.
 *
 * A closed list: a class carrying forty annotations should not produce a box
 * with forty lines, and these are the ones that say what a type is *for*.
 */
const STEREOTYPES: Record<string, string> = {
  'jakarta.persistence.Entity': 'entity',
  'javax.persistence.Entity': 'entity',
  'jakarta.persistence.MappedSuperclass': 'mapped superclass',
  'javax.persistence.MappedSuperclass': 'mapped superclass',
  'jakarta.persistence.Embeddable': 'embeddable',
  'org.springframework.stereotype.Service': 'service',
  'org.springframework.stereotype.Repository': 'repository',
  'org.springframework.stereotype.Component': 'component',
  'org.springframework.stereotype.Controller': 'controller',
  'org.springframework.web.bind.annotation.RestController': 'rest controller',
  'org.springframework.context.annotation.Configuration': 'configuration',
  'org.springframework.boot.autoconfigure.SpringBootApplication': 'application',
};

export interface ClassMember {
  text: string;
  kind: 'field' | 'method';
  path: string | null;
  line: number | null;
}

export interface ClassBox {
  id: string;
  /** Simple name; the package is the diagram's scope. */
  name: string;
  fqn: string;
  /** `class`, `interface`, `enum`. */
  kind: string;
  /** What an annotation says this type is for, or null. */
  stereotype: string | null;
  fields: ClassMember[];
  methods: ClassMember[];
  /** Members beyond the cap, counted rather than dropped. */
  hiddenMembers: number;
  path: string | null;
  line: number | null;
}

export interface ClassLink {
  from: string;
  to: string;
  kind: 'extends' | 'implements' | 'association';
  /** The field that creates an association. Null for the other two. */
  via: string | null;
  /** Target outside this package, kept for the table even when not drawn. */
  external: boolean;
  toFqn: string;
  path: string | null;
  line: number | null;
}

export interface ClassDiagram {
  /** The package this diagram is of. */
  packageFqn: string;
  classes: ClassBox[];
  links: ClassLink[];
  notes: string[];
}

export interface ClassOptions {
  /** Maximum classes drawn per package diagram. */
  top: number;
  /** Maximum package diagrams produced. */
  maxDiagrams: number;
}

interface TypeRow {
  id: number;
  fqn: string;
  name: string;
  kind: string;
  packageFqn: string;
  path: string | null;
  line: number | null;
  attrs: string | null;
}

interface MemberRow {
  ownerId: number;
  name: string;
  kind: string;
  attrs: string | null;
  path: string | null;
  line: number | null;
}

/**
 * One diagram per package that declares a type, biggest first.
 *
 * "Biggest" is by declared type count, because a package with one class in it
 * produces a diagram that says less than the component diagram already did.
 */
export function buildClassDiagrams(
  db: Db,
  runId: number,
  options: ClassOptions,
): { diagrams: ClassDiagram[]; skipped: number } {
  const types = loadTypes(db, runId);
  if (types.length === 0) return { diagrams: [], skipped: 0 };

  const members = loadMembers(db, runId);
  const stereotypes = loadStereotypes(db, runId);
  const inheritance = loadInheritance(db, runId);
  const byFqn = new Map(types.map((type) => [type.fqn, type]));

  const byPackage = new Map<string, TypeRow[]>();
  for (const type of types) {
    const existing = byPackage.get(type.packageFqn);
    if (existing) existing.push(type);
    else byPackage.set(type.packageFqn, [type]);
  }

  const ordered = [...byPackage.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const chosen = ordered.slice(0, options.maxDiagrams);

  const diagrams = chosen.map(([packageFqn, packageTypes]) =>
    buildOne(packageFqn, packageTypes, { members, stereotypes, inheritance, byFqn }, options),
  );

  return { diagrams, skipped: ordered.length - chosen.length };
}

function buildOne(
  packageFqn: string,
  packageTypes: TypeRow[],
  data: {
    members: Map<number, MemberRow[]>;
    stereotypes: Map<number, string[]>;
    inheritance: Array<{ srcFqn: string; dstFqn: string; kind: string; path: string | null; line: number | null }>;
    byFqn: Map<string, TypeRow>;
  },
  options: ClassOptions,
): ClassDiagram {
  // Rank by how much a type declares, so a capped diagram keeps the classes
  // that carry the package rather than the alphabetically luckiest ones.
  const ranked = [...packageTypes].sort(
    (a, b) =>
      (data.members.get(b.id)?.length ?? 0) - (data.members.get(a.id)?.length ?? 0) ||
      a.fqn.localeCompare(b.fqn),
  );
  const shown = ranked.slice(0, options.top);
  const shownFqns = new Set(shown.map((type) => type.fqn));

  const classes: ClassBox[] = shown
    .map((type) => {
      const all = data.members.get(type.id) ?? [];
      const fields = all.filter((m) => m.kind === 'field').map(toField);
      const methods = all.filter((m) => m.kind === 'method').map(toMethod);
      const shownFields = fields.slice(0, MEMBERS_PER_BOX);
      const shownMethods = methods.slice(0, MEMBERS_PER_BOX);

      return {
        id: classId(type.fqn),
        name: type.name,
        fqn: type.fqn,
        kind: type.kind,
        stereotype: stereotypeOf(data.stereotypes.get(type.id) ?? []),
        fields: shownFields,
        methods: shownMethods,
        hiddenMembers:
          fields.length - shownFields.length + (methods.length - shownMethods.length),
        path: type.path,
        line: type.line,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const links: ClassLink[] = [];

  for (const edge of data.inheritance) {
    if (!shownFqns.has(edge.srcFqn)) continue;
    links.push({
      from: classId(edge.srcFqn),
      to: classId(edge.dstFqn),
      kind: edge.kind === 'extends' ? 'extends' : 'implements',
      via: null,
      external: !shownFqns.has(edge.dstFqn),
      toFqn: edge.dstFqn,
      path: edge.path,
      line: edge.line,
    });
  }

  // An association is a field whose declared type is another type in this
  // package. A field typed from a jar nobody read resolves to nothing and
  // produces no line, which is the same refusal the package graph makes.
  for (const type of shown) {
    for (const member of data.members.get(type.id) ?? []) {
      if (member.kind !== 'field') continue;
      const attrs = parseAttrs(member.attrs);
      for (const candidate of [attrs['type'], ...typeArguments(attrs)]) {
        if (typeof candidate !== 'string') continue;
        if (candidate === type.fqn || !shownFqns.has(candidate)) continue;
        links.push({
          from: classId(type.fqn),
          to: classId(candidate),
          kind: 'association',
          via: member.name,
          external: false,
          toFqn: candidate,
          path: member.path,
          line: member.line,
        });
      }
    }
  }

  links.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );

  const notes: string[] = [];
  if (ranked.length > shown.length) {
    notes.push(
      `Showing ${shown.length} of ${ranked.length} types in this package, the ones ` +
        `declaring the most members first. Raise --top for more.`,
    );
  }
  const hidden = classes.reduce((sum, box) => sum + box.hiddenMembers, 0);
  if (hidden > 0) {
    notes.push(
      `${hidden} member(s) are past the per-class cap of ${MEMBERS_PER_BOX} and are ` +
        `counted on the box rather than listed.`,
    );
  }
  const external = links.filter((link) => link.external).length;
  if (external > 0) {
    notes.push(
      `${external} supertype(s) are declared outside this package and are listed in ` +
        `the table rather than drawn.`,
    );
  }

  return { packageFqn, classes, links, notes };
}

function toField(member: MemberRow): ClassMember {
  const attrs = parseAttrs(member.attrs);
  const type = typeof attrs['type'] === 'string' ? shortName(attrs['type']) : '?';
  const args = typeArguments(attrs).map(shortName);
  const rendered = args.length === 0 ? type : `${type}<${args.join(', ')}>`;
  return {
    text: `${visibility(attrs)}${member.name}: ${rendered}`,
    kind: 'field',
    path: member.path,
    line: member.line,
  };
}

function toMethod(member: MemberRow): ClassMember {
  const attrs = parseAttrs(member.attrs);
  const returns = typeof attrs['returns'] === 'string' ? shortName(attrs['returns']) : '';
  return {
    text: `${visibility(attrs)}${member.name}()${returns === '' ? '' : `: ${returns}`}`,
    kind: 'method',
    path: member.path,
    line: member.line,
  };
}

/** UML visibility, from the modifiers a parser read. */
function visibility(attrs: Record<string, unknown>): string {
  const modifiers = Array.isArray(attrs['modifiers'])
    ? (attrs['modifiers'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  if (modifiers.includes('public')) return '+';
  if (modifiers.includes('private')) return '-';
  if (modifiers.includes('protected')) return '#';
  return '~';
}

function stereotypeOf(annotations: string[]): string | null {
  for (const annotation of annotations) {
    const stereotype = STEREOTYPES[annotation];
    if (stereotype !== undefined) return stereotype;
  }
  return null;
}

function loadTypes(db: Db, runId: number): TypeRow[] {
  return db
    .prepare(
      /* sql */ `
      SELECT n.id AS id, n.fqn AS fqn, n.name AS name, n.kind AS kind,
             p.fqn AS packageFqn, f.path AS path, n.start_line AS line, n.attrs AS attrs
        FROM node n
        JOIN node p ON p.id = n.parent_id AND p.kind = 'package'
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = @runId AND n.is_stub = 0
         AND n.kind IN ('class', 'interface', 'enum')
       ORDER BY n.fqn`,
    )
    .all({ runId }) as TypeRow[];
}

function loadMembers(db: Db, runId: number): Map<number, MemberRow[]> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT n.parent_id AS ownerId, n.name AS name, n.kind AS kind, n.attrs AS attrs,
             f.path AS path, n.start_line AS line
        FROM node n
        LEFT JOIN source_file f ON f.id = n.file_id
       WHERE n.run_id = @runId AND n.is_stub = 0 AND n.kind IN ('field', 'method')
         AND n.parent_id IS NOT NULL
       ORDER BY n.kind, n.id`,
    )
    .all({ runId }) as MemberRow[];

  const byOwner = new Map<number, MemberRow[]>();
  for (const row of rows) {
    const existing = byOwner.get(row.ownerId);
    if (existing) existing.push(row);
    else byOwner.set(row.ownerId, [row]);
  }
  return byOwner;
}

function loadStereotypes(db: Db, runId: number): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT e.src_id AS typeId, dst.fqn AS annotation
         FROM edge e
         JOIN node src ON src.id = e.src_id AND src.kind IN ('class','interface','enum')
         JOIN node dst ON dst.id = e.dst_id
        WHERE e.run_id = @runId AND e.kind = 'annotated_with'`,
    )
    .all({ runId }) as Array<{ typeId: number; annotation: string }>;

  const byType = new Map<number, string[]>();
  for (const row of rows) {
    const existing = byType.get(row.typeId);
    if (existing) existing.push(row.annotation);
    else byType.set(row.typeId, [row.annotation]);
  }
  return byType;
}

function loadInheritance(
  db: Db,
  runId: number,
): Array<{ srcFqn: string; dstFqn: string; kind: string; path: string | null; line: number | null }> {
  return db
    .prepare(
      `SELECT src.fqn AS srcFqn, dst.fqn AS dstFqn, e.kind AS kind,
              f.path AS path, e.line AS line
         FROM edge e
         JOIN node src ON src.id = e.src_id
         JOIN node dst ON dst.id = e.dst_id
         LEFT JOIN source_file f ON f.id = e.file_id
        WHERE e.run_id = @runId AND e.kind IN ('extends', 'implements')
          AND e.confidence = 'fact'
        ORDER BY e.id`,
    )
    .all({ runId }) as Array<{
    srcFqn: string;
    dstFqn: string;
    kind: string;
    path: string | null;
    line: number | null;
  }>;
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

export function shortName(fqn: string): string {
  const withoutGenerics = fqn.replace(/<.*$/, '');
  return withoutGenerics.split('.').pop() ?? withoutGenerics;
}

export function classId(fqn: string): string {
  return `cls_${fqn.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'type'}`;
}

/** The class diagram as boxes and links the shared layout can place. */
export function classLayoutInput(diagram: ClassDiagram): {
  nodes: LayoutNodeSpec[];
  links: LayoutLinkSpec[];
} {
  const nodes: LayoutNodeSpec[] = diagram.classes.map((box) => {
    const lines: LayoutLine[] = [{ text: box.name, emphasis: 'name' }];
    const label = box.stereotype ?? (box.kind === 'class' ? null : box.kind);
    if (label !== null) lines.push({ text: `«${label}»`, emphasis: 'stereotype' });
    const dividerAfter = lines.length;

    for (const field of box.fields) lines.push({ text: field.text, emphasis: 'member' });
    for (const method of box.methods) lines.push({ text: method.text, emphasis: 'member' });
    if (box.hiddenMembers > 0) {
      lines.push({ text: `… and ${box.hiddenMembers} more`, emphasis: 'detail' });
    }

    return { id: box.id, kind: 'type' as const, lines, inference: false, compartment: true, dividerAfter };
  });

  const drawn = new Set(diagram.classes.map((box) => box.id));
  const links: LayoutLinkSpec[] = diagram.links
    .filter((link) => drawn.has(link.from) && drawn.has(link.to))
    .map((link) => ({
      from: link.from,
      to: link.to,
      label: link.kind === 'association' ? (link.via ?? 'has') : link.kind,
      confidence: 'fact' as const,
      style: link.kind,
    }));

  return { nodes, links };
}
