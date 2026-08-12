/**
 * Inline SVG for a laid-out diagram.
 *
 * No script, no external reference, no font it does not name a fallback for.
 * The output is a fragment rather than a document, so it drops straight into
 * the report's HTML and inherits its stylesheet (ADR-0020).
 *
 * Colours are set as attributes rather than left to CSS, because the same SVG
 * has to survive being copied out of the report into a wiki or an email, where
 * the stylesheet does not follow it.
 */

import type { DiagramPalette } from './brand.js';
import type { Layout, LayoutBox, LayoutEdge, LayoutLine } from './layout.js';
import { FONT_SIZE } from './layout.js';

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/**
 * One palette entry per element kind, plus the two line styles.
 *
 * Tuned for a light surface (ADR-0024): tinted fills, a coloured border and
 * dark ink, so a diagram reads like a document rather than a terminal. The
 * report keeps every figure on a white card in both colour schemes, and an
 * SVG copied out into a wiki or an email — light surfaces, all of them —
 * carries colours that were chosen for exactly that.
 */
const FILL: Record<string, string> = {
  system: '#b7d3f6',
  container: '#cde2fb',
  component: '#fcfcfb',
  datastore: '#f0efec',
  external: '#f0efec',
  entity: '#fcfcfb',
  type: '#fcfcfb',
};

const STROKE: Record<string, string> = {
  system: '#1c5cab',
  container: '#2a78d6',
  component: '#86b6ef',
  datastore: '#898781',
  external: '#898781',
  entity: '#c3c2b7',
  type: '#c3c2b7',
};

/** The header strip of a compartment box, so the title reads as a title. */
const HEADER_FILL: Record<string, string> = {
  entity: '#cde2fb',
  type: '#e9e8e3',
};

const TEXT = '#0b0b0b';
const MUTED = '#52514e';
/** Inference gets its own colour, everywhere it appears. */
const INFERRED = '#9a6700';
const LINE = '#6b6a66';
/** What an edge label sits on, and what a hollow arrowhead is hollow with. */
const SURFACE = '#ffffff';
const STEREOTYPE = '#1c5cab';

/** Today's palette, used whenever no brand supplies one (ADR-0025). */
const DEFAULT_PALETTE: DiagramPalette = {
  fill: FILL,
  stroke: STROKE,
  headerFill: HEADER_FILL,
  stereotype: STEREOTYPE,
};

/**
 * Render a fragment. `idPrefix` namespaces the marker ids, because several
 * diagrams share one HTML document and duplicate ids would make every arrow on
 * the page point at whichever marker was defined last.
 */
export function toSvg(layout: Layout, idPrefix: string, palette: DiagramPalette = DEFAULT_PALETTE): string {
  if (layout.boxes.length === 0) {
    return `<svg class="diagram" role="img" aria-label="empty diagram" width="0" height="0"></svg>`;
  }

  const arrow = `${idPrefix}-arrow`;
  const arrowInferred = `${idPrefix}-arrow-inferred`;

  const parts: string[] = [
    `<svg class="diagram" role="img" aria-label="${escapeAttr(describe(layout))}" ` +
      `viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" ` +
      `height="${layout.height}" xmlns="http://www.w3.org/2000/svg" font-family="${escapeAttr(FONT)}">`,
    '<defs>',
    marker(arrow, LINE),
    marker(arrowInferred, INFERRED),
    hollowMarker(`${arrow}-hollow`, LINE),
    '</defs>',
  ];

  // Edges first, so a line never covers the box it points at.
  for (const edge of layout.edges) parts.push(...renderEdge(edge, arrow, arrowInferred));
  for (const box of layout.boxes) parts.push(...renderBox(box, palette));

  parts.push('</svg>');
  return parts.join('\n');
}

function describe(layout: Layout): string {
  return `${layout.boxes.length} element(s), ${layout.edges.length} relationship(s)`;
}

function marker(id: string, colour: string): string {
  return (
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
    `markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${colour}"/></marker>`
  );
}

/** UML generalisation: a hollow triangle, unfilled so it reads as inheritance. */
function hollowMarker(id: string, colour: string): string {
  return (
    `<marker id="${id}" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" ` +
    `markerHeight="10" orient="auto-start-reverse">` +
    `<path d="M 1 1 L 11 6 L 1 11 z" fill="${SURFACE}" stroke="${colour}" stroke-width="1.5"/></marker>`
  );
}

function renderBox(box: LayoutBox, palette: DiagramPalette): string[] {
  const fill = palette.fill[box.kind] ?? palette.fill['component'];
  const stroke = box.inference ? INFERRED : (palette.stroke[box.kind] ?? LINE);
  const dashed = box.inference ? ' stroke-dasharray="5 3"' : '';
  // A store is drawn as a cylinder and an external system with a rounder
  // corner, because those are the shapes a C4 reader already knows. A
  // compartment box is square, because that is what a class and a table are.
  const radius = box.compartment ? 3 : box.kind === 'external' ? 14 : box.kind === 'datastore' ? 4 : 6;

  const parts = [
    `<g>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ` +
      `rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dashed}/>`,
  ];

  if (box.compartment && box.dividerAfter > 0) {
    // A filled header strip and a rule under it: the two marks that make a
    // stack of text read as a class or a table rather than as a paragraph.
    const headerHeight = box.dividerAfter * 16 + 8;
    const headerFill = palette.headerFill[box.kind] ?? '#e9e8e3';
    parts.push(
      `<path d="M ${box.x} ${box.y + radius} a ${radius} ${radius} 0 0 1 ${radius} ${-radius} ` +
        `h ${box.width - radius * 2} a ${radius} ${radius} 0 0 1 ${radius} ${radius} ` +
        `v ${headerHeight - radius} h ${-box.width} z" fill="${headerFill}"/>`,
      `<line x1="${box.x}" y1="${box.y + headerHeight}" x2="${box.x + box.width}" ` +
        `y2="${box.y + headerHeight}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }

  let y = box.y + 10 + FONT_SIZE;
  for (const line of box.lines) {
    parts.push(renderLine(box, line, y, palette));
    y += 16;
  }
  parts.push('</g>');
  return parts;
}

/**
 * One line of text.
 *
 * Compartment rows are left-aligned and header lines are centred, which is the
 * UML convention and also the only way a column list reads as a list.
 */
function renderLine(box: LayoutBox, line: LayoutLine, y: number, palette: DiagramPalette): string {
  const attributes = styleFor(line, palette);
  const leftAligned = box.compartment && line.emphasis === 'member';
  const x = leftAligned ? box.x + 10 : box.x + box.width / 2;
  const anchor = leftAligned ? 'start' : 'middle';
  return (
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${attributes.size}" ` +
    `fill="${attributes.fill}"${attributes.style}>${escapeText(line.text)}</text>`
  );
}

function styleFor(line: LayoutLine, palette: DiagramPalette): { size: number; fill: string; style: string } {
  switch (line.emphasis) {
    case 'name':
      return { size: FONT_SIZE, fill: TEXT, style: ' font-weight="600"' };
    case 'inference':
      return { size: FONT_SIZE - 2, fill: INFERRED, style: ' font-style="italic"' };
    case 'group':
      return { size: FONT_SIZE - 2, fill: MUTED, style: ' font-style="italic"' };
    case 'stereotype':
      return { size: FONT_SIZE - 2, fill: palette.stereotype, style: ' font-style="italic"' };
    case 'member':
      return { size: FONT_SIZE - 1, fill: TEXT, style: '' };
    default:
      return { size: FONT_SIZE - 2, fill: MUTED, style: '' };
  }
}

function renderEdge(edge: LayoutEdge, arrow: string, arrowInferred: string): string[] {
  const inferred = edge.confidence === 'inferred';
  const colour = inferred ? INFERRED : LINE;
  // UML: a hollow triangle for generalisation, dashed for realisation. Drawing
  // inheritance the same as a call is what makes a class diagram unreadable.
  const marker =
    edge.style === 'extends' || edge.style === 'implements'
      ? `${arrow}-hollow`
      : inferred
        ? arrowInferred
        : arrow;
  const dash = inferred
    ? ' stroke-dasharray="6 4"'
    : edge.style === 'implements'
      ? ' stroke-dasharray="7 4"'
      : edge.routed
        ? ' stroke-dasharray="2 3"'
        : '';
  const points = edge.points.map(([x, y]) => `${x},${y}`).join(' ');

  const parts = [
    `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="1.5"` +
      `${dash} marker-end="url(#${marker})"/>`,
  ];

  if (edge.label !== null && edge.labelAt !== null) {
    const [x, y] = edge.labelAt;
    // A backing rect, because a label sitting on a line is unreadable and the
    // report has no JavaScript to move it out of the way.
    const width = edge.label.length * 6 + 8;
    parts.push(
      `<rect x="${x - width / 2}" y="${y - 11}" width="${width}" height="14" rx="3" ` +
        `fill="${SURFACE}" opacity="0.9"/>`,
      `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="${colour}">` +
        `${escapeText(edge.label)}</text>`,
    );
  }
  return parts;
}

/**
 * Escape text content.
 *
 * `&` first, or every entity this produces gets its own ampersand escaped
 * afterwards. A package fqn really can contain `<` — a TypeScript one carries a
 * file path, and a Java one a generic signature.
 */
export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Attribute values additionally have to survive the quoting. */
export function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
