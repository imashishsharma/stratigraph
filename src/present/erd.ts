/**
 * Drawing the entity-relationship model. The model itself is built in
 * `src/analysis/data-model.ts`; this file lays it out.
 */

import {
  CARDINALITY_LABEL,
  entityId,
  shortType,
  type ErModel,
} from '../analysis/data-model.js';
import type { LayoutLine, LayoutLinkSpec, LayoutNodeSpec } from './layout.js';

export {
  buildErModel,
  CARDINALITY_LABEL,
  entityId,
  physicalName,
  shortType,
  type ErCardinality,
  type ErColumn,
  type ErEntity,
  type ErModel,
  type ErRelationship,
  type ErUnreadable,
} from '../analysis/data-model.js';

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
      {
        text: entity.className === null ? '«table, no mapped class»' : `«${shortType(entity.className)}»`,
        emphasis: 'stereotype',
      },
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
