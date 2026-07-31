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

import type { Layout, LayoutBox, LayoutEdge, LayoutLine } from './layout.js';
import { FONT_SIZE } from './layout.js';

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** One palette entry per element kind, plus the two line styles. */
const FILL: Record<string, string> = {
  system: '#1f6feb',
  container: '#316dca',
  component: '#2d333b',
  datastore: '#495057',
  external: '#57606a',
};

const STROKE: Record<string, string> = {
  system: '#79c0ff',
  container: '#79c0ff',
  component: '#57606a',
  datastore: '#8b949e',
  external: '#8b949e',
};

const TEXT = '#f0f6fc';
const MUTED = '#c9d1d9';
/** Inference gets its own colour, everywhere it appears. */
const INFERRED = '#e3b341';
const LINE = '#8b949e';

/**
 * Render a fragment. `idPrefix` namespaces the marker ids, because several
 * diagrams share one HTML document and duplicate ids would make every arrow on
 * the page point at whichever marker was defined last.
 */
export function toSvg(layout: Layout, idPrefix: string): string {
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
    '</defs>',
  ];

  // Edges first, so a line never covers the box it points at.
  for (const edge of layout.edges) parts.push(...renderEdge(edge, arrow, arrowInferred));
  for (const box of layout.boxes) parts.push(...renderBox(box));

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

function renderBox(box: LayoutBox): string[] {
  const fill = FILL[box.kind] ?? FILL['component'];
  const stroke = box.inference ? INFERRED : (STROKE[box.kind] ?? LINE);
  const dashed = box.inference ? ' stroke-dasharray="5 3"' : '';
  // A store is drawn as a cylinder and an external system with a rounder
  // corner, because those are the shapes a C4 reader already knows.
  const radius = box.kind === 'external' ? 14 : box.kind === 'datastore' ? 4 : 6;

  const parts = [
    `<g>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ` +
      `rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dashed}/>`,
  ];

  let y = box.y + 10 + FONT_SIZE;
  for (const line of box.lines) {
    parts.push(renderLine(box, line, y));
    y += 16;
  }
  parts.push('</g>');
  return parts;
}

function renderLine(box: LayoutBox, line: LayoutLine, y: number): string {
  const x = box.x + box.width / 2;
  const attributes = styleFor(line);
  return (
    `<text x="${x}" y="${y}" text-anchor="middle" font-size="${attributes.size}" ` +
    `fill="${attributes.fill}"${attributes.style}>${escapeText(line.text)}</text>`
  );
}

function styleFor(line: LayoutLine): { size: number; fill: string; style: string } {
  switch (line.emphasis) {
    case 'name':
      return { size: FONT_SIZE, fill: TEXT, style: ' font-weight="600"' };
    case 'inference':
      return { size: FONT_SIZE - 2, fill: INFERRED, style: ' font-style="italic"' };
    case 'group':
      return { size: FONT_SIZE - 2, fill: MUTED, style: ' font-style="italic"' };
    default:
      return { size: FONT_SIZE - 2, fill: MUTED, style: '' };
  }
}

function renderEdge(edge: LayoutEdge, arrow: string, arrowInferred: string): string[] {
  const inferred = edge.confidence === 'inferred';
  const colour = inferred ? INFERRED : LINE;
  const marker = inferred ? arrowInferred : arrow;
  const dash = inferred ? ' stroke-dasharray="6 4"' : edge.routed ? ' stroke-dasharray="2 3"' : '';
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
        `fill="#161b22" opacity="0.9"/>`,
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
