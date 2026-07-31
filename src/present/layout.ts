/**
 * A deterministic layered layout for a C4 diagram.
 *
 * Deterministic is the property that matters (ADR-0020): the same model must
 * produce the same coordinates on every machine and every run, so the SVG can
 * be asserted byte-for-byte in a fixture test and a report checked into a
 * repository produces an empty diff until the code changes. Every tie here is
 * broken by name, and nothing consults a clock, a hash or an iteration order
 * that could vary.
 *
 * The shape is the classic layered one, minus the parts that need a solver:
 * condense cycles, rank by longest path, order within a rank by a fixed number
 * of barycentre passes, then place on a grid.
 */

import { stronglyConnectedComponents } from '../analysis/tarjan.js';
import type { C4Diagram, C4ElementKind } from './c4.js';
import type { Confidence } from '../facts/types.js';

/** Monospace metrics. The stylesheet pins the same stack, so these hold. */
export const FONT_SIZE = 12;
const CHAR_WIDTH = 7.2;
const LINE_HEIGHT = 16;

const PAD_X = 12;
const PAD_Y = 10;
const MIN_BOX_WIDTH = 120;
const COLUMN_GAP = 72;
const ROW_GAP = 24;
const MARGIN = 20;

/** Longer labels are truncated. A box wide enough for any fqn is not a box. */
const MAX_CHARS = 34;

/**
 * Edge labels are truncated harder than box labels, because every character
 * widens the gutter they sit in — the whole diagram pays for one long one.
 */
const MAX_EDGE_CHARS = 22;

/** Roughly the advance of the 10px type the edge labels are drawn in. */
const EDGE_CHAR_WIDTH = 6;

/** Barycentre passes. Fixed, because "until it stops improving" is not deterministic. */
const ORDERING_PASSES = 4;

/**
 * Above this many relationships, edge labels are dropped — they overlap into
 * illegibility long before the diagram itself does. The layout says so in
 * `notes` rather than dropping them quietly.
 */
const LABEL_LIMIT = 15;

export type LineEmphasis = 'name' | 'detail' | 'group' | 'inference';

export interface LayoutLine {
  text: string;
  emphasis: LineEmphasis;
}

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: C4ElementKind;
  inference: boolean;
  lines: LayoutLine[];
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** An orthogonal polyline. At least two points. */
  points: Array<[number, number]>;
  label: string | null;
  /** Where to put the label, when there is one. */
  labelAt: [number, number] | null;
  confidence: Confidence;
  /**
   * True when the edge runs backwards or within a rank, and had to be routed
   * through the channel below the diagram. Always a cycle or a sibling
   * dependency — worth seeing, which is why it is not hidden.
   */
  routed: boolean;
}

export interface Layout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  edges: LayoutEdge[];
  /** What the layout itself dropped or could not draw. Never silent. */
  notes: string[];
}

/** Lay out one diagram. */
export function layout(diagram: C4Diagram): Layout {
  const boxes = diagram.elements.map(toBox);
  if (boxes.length === 0) {
    return { width: 0, height: 0, boxes: [], edges: [], notes: [] };
  }

  const index = new Map(boxes.map((box, n) => [box.id, n]));
  const edges = diagram.relationships.filter(
    (relationship) => index.has(relationship.from) && index.has(relationship.to),
  );

  const notes: string[] = [];
  const withLabels = edges.length <= LABEL_LIMIT;
  if (!withLabels) {
    notes.push(
      `${edges.length} relationships: line labels are omitted above ${LABEL_LIMIT} ` +
        `because they overlap. The relationship table below lists every one.`,
    );
  }

  // The gutter has to fit the labels that sit in it. Boxes are drawn over the
  // lines, so a label wider than the gap between two columns is not merely
  // cramped — it disappears behind the box it overhangs.
  const widestLabel = withLabels
    ? Math.max(
        0,
        ...edges.map((edge) => truncateEdgeLabel(edge.label).length * EDGE_CHAR_WIDTH),
      )
    : 0;
  const columnGap = Math.max(COLUMN_GAP, round(widestLabel) + 20);

  const ranks = assignRanks(boxes, edges, index);
  const orders = orderWithinRanks(boxes, edges, index, ranks);
  place(boxes, ranks, orders, columnGap);

  const byId = new Map(boxes.map((box) => [box.id, box]));
  const contentBottom = Math.max(...boxes.map((box) => box.y + box.height));
  const routed: LayoutEdge[] = [];
  let channel = 0;

  for (const relationship of edges) {
    const from = byId.get(relationship.from) as LayoutBox;
    const to = byId.get(relationship.to) as LayoutBox;
    const label = withLabels ? truncateEdgeLabel(relationship.label) : null;

    if (to.x > from.x + from.width) {
      routed.push(forwardEdge(from, to, label, relationship.confidence));
      continue;
    }
    channel += 1;
    routed.push(
      channelEdge(from, to, label, relationship.confidence, contentBottom + channel * 14),
    );
  }

  const width =
    Math.max(...boxes.map((box) => box.x + box.width), ...routed.flatMap(xsOf)) + MARGIN;
  const height =
    Math.max(...boxes.map((box) => box.y + box.height), ...routed.flatMap(ysOf)) + MARGIN;

  return { width: round(width), height: round(height), boxes, edges: routed, notes };
}

function xsOf(edge: LayoutEdge): number[] {
  return edge.points.map(([x]) => x);
}

function ysOf(edge: LayoutEdge): number[] {
  return edge.points.map(([, y]) => y);
}

// ------------------------------------------------------------------- content

function toBox(element: C4Diagram['elements'][number]): LayoutBox {
  const lines: LayoutLine[] = [{ text: truncate(element.name), emphasis: 'name' }];
  if (element.technology !== null) {
    lines.push({ text: truncate(`[${element.technology}]`), emphasis: 'detail' });
  }
  if (element.description !== null) {
    lines.push({ text: truncate(element.description), emphasis: 'detail' });
  }
  if (element.group !== null) {
    lines.push({
      text: truncate(element.group),
      emphasis: element.groupInference ? 'inference' : 'group',
    });
  }
  if (element.inference) {
    lines.push({ text: 'name is inference', emphasis: 'inference' });
  }

  const widest = Math.max(...lines.map((line) => line.text.length));
  return {
    id: element.id,
    x: 0,
    y: 0,
    width: Math.max(MIN_BOX_WIDTH, round(widest * CHAR_WIDTH + PAD_X * 2)),
    height: lines.length * LINE_HEIGHT + PAD_Y * 2,
    kind: element.kind,
    inference: element.inference,
    lines,
  };
}

export function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  // Keep the tail: the distinguishing part of `com.example.shop.billing.tax`
  // is the end of it, not the company name every package shares.
  return `…${text.slice(text.length - (MAX_CHARS - 1))}`;
}

/**
 * The head, not the tail — the opposite of {@link truncate}, and for the same
 * reason. An edge label is a list of edge kinds, so `injects, calls, imports`
 * loses least by dropping the end.
 */
export function truncateEdgeLabel(text: string): string {
  if (text.length <= MAX_EDGE_CHARS) return text;
  return `${text.slice(0, MAX_EDGE_CHARS - 1)}…`;
}

// ------------------------------------------------------------------- ranking

interface Relation {
  from: string;
  to: string;
}

/**
 * Rank by longest path over the condensation.
 *
 * The graph is condensed first because a dependency graph with a cycle in it
 * has no topological order, and cycles are exactly what this tool is built to
 * find — a layout that assumed acyclicity would fail on the most interesting
 * repositories.
 */
function assignRanks(
  boxes: LayoutBox[],
  edges: Relation[],
  index: Map<string, number>,
): Map<string, number> {
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const from = index.get(edge.from) as number;
    const to = index.get(edge.to) as number;
    if (from === to) continue;
    const existing = adjacency.get(from);
    if (existing) existing.push(to);
    else adjacency.set(from, [to]);
  }

  const components = stronglyConnectedComponents({
    nodes: boxes.map((_, n) => n),
    edges: adjacency,
  });
  const componentOf = new Map<number, number>();
  for (const [n, component] of components.entries()) {
    for (const member of component) componentOf.set(member, n);
  }

  // The condensed DAG, deduplicated.
  const successors = new Map<number, Set<number>>();
  const inDegree = new Map<number, number>(components.map((_, n) => [n, 0]));
  for (const [from, targets] of adjacency) {
    const source = componentOf.get(from) as number;
    for (const to of targets) {
      const target = componentOf.get(to) as number;
      if (source === target) continue;
      let out = successors.get(source);
      if (out === undefined) {
        out = new Set();
        successors.set(source, out);
      }
      if (out.has(target)) continue;
      out.add(target);
      inDegree.set(target, (inDegree.get(target) as number) + 1);
    }
  }

  // Kahn's algorithm, with the frontier kept sorted so the traversal order —
  // and therefore every downstream tie-break — is fixed.
  const rank = new Map<number, number>(components.map((_, n) => [n, 0]));
  const frontier = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([component]) => component)
    .sort((a, b) => a - b);

  while (frontier.length > 0) {
    const component = frontier.shift() as number;
    const here = rank.get(component) as number;
    for (const target of [...(successors.get(component) ?? [])].sort((a, b) => a - b)) {
      rank.set(target, Math.max(rank.get(target) as number, here + 1));
      const remaining = (inDegree.get(target) as number) - 1;
      inDegree.set(target, remaining);
      if (remaining === 0) {
        frontier.push(target);
        frontier.sort((a, b) => a - b);
      }
    }
  }

  const byBox = new Map<string, number>();
  for (const [n, box] of boxes.entries()) {
    byBox.set(box.id, rank.get(componentOf.get(n) as number) as number);
  }
  return byBox;
}

// ------------------------------------------------------------------ ordering

/**
 * Order the boxes within each rank, reducing crossings by barycentre.
 *
 * A fixed number of passes rather than "until it converges": convergence is
 * not guaranteed, and stopping on a threshold makes the output depend on
 * floating-point details that are not worth defending in a fixture test.
 */
function orderWithinRanks(
  boxes: LayoutBox[],
  edges: Relation[],
  index: Map<string, number>,
  ranks: Map<string, number>,
): Map<string, number> {
  const byRank = new Map<number, LayoutBox[]>();
  for (const box of boxes) {
    const rank = ranks.get(box.id) as number;
    const existing = byRank.get(rank);
    if (existing) existing.push(box);
    else byRank.set(rank, [box]);
  }
  for (const group of byRank.values()) group.sort((a, b) => a.id.localeCompare(b.id));

  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const existing = neighbours.get(a);
    if (existing) existing.push(b);
    else neighbours.set(a, [b]);
  };
  for (const edge of edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    if (ranks.get(edge.from) === ranks.get(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const position = new Map<string, number>();
  const record = (): void => {
    for (const group of byRank.values()) {
      for (const [n, box] of group.entries()) position.set(box.id, n);
    }
  };
  record();

  const rankNumbers = [...byRank.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < ORDERING_PASSES; pass += 1) {
    const order = pass % 2 === 0 ? rankNumbers : [...rankNumbers].reverse();
    for (const rank of order) {
      const group = byRank.get(rank) as LayoutBox[];
      const barycentre = new Map<string, number>();
      for (const box of group) {
        const linked = (neighbours.get(box.id) ?? [])
          .map((other) => position.get(other))
          .filter((value): value is number => value !== undefined);
        barycentre.set(
          box.id,
          linked.length === 0
            ? (position.get(box.id) as number)
            : linked.reduce((sum, value) => sum + value, 0) / linked.length,
        );
      }
      group.sort(
        (a, b) =>
          (barycentre.get(a.id) as number) - (barycentre.get(b.id) as number) ||
          a.id.localeCompare(b.id),
      );
      record();
    }
  }

  return position;
}

// ----------------------------------------------------------------- placement

/** Grid placement: one column per rank, columns as wide as their widest box. */
function place(
  boxes: LayoutBox[],
  ranks: Map<string, number>,
  orders: Map<string, number>,
  columnGap: number,
): void {
  const byRank = new Map<number, LayoutBox[]>();
  for (const box of boxes) {
    const rank = ranks.get(box.id) as number;
    const existing = byRank.get(rank);
    if (existing) existing.push(box);
    else byRank.set(rank, [box]);
  }
  for (const group of byRank.values()) {
    group.sort((a, b) => (orders.get(a.id) as number) - (orders.get(b.id) as number));
  }

  const rankNumbers = [...byRank.keys()].sort((a, b) => a - b);
  const columnWidth = new Map<number, number>();
  const columnHeight = new Map<number, number>();
  for (const rank of rankNumbers) {
    const group = byRank.get(rank) as LayoutBox[];
    columnWidth.set(rank, Math.max(...group.map((box) => box.width)));
    columnHeight.set(
      rank,
      group.reduce((sum, box) => sum + box.height, 0) + ROW_GAP * (group.length - 1),
    );
  }
  const tallest = Math.max(...columnHeight.values());

  let x = MARGIN;
  for (const rank of rankNumbers) {
    const group = byRank.get(rank) as LayoutBox[];
    const width = columnWidth.get(rank) as number;
    // Centre each column against the tallest, so a two-box column beside a
    // ten-box one reads as connected rather than as an afterthought.
    let y = MARGIN + round((tallest - (columnHeight.get(rank) as number)) / 2);
    for (const box of group) {
      box.x = x;
      box.y = y;
      box.width = width;
      y += box.height + ROW_GAP;
    }
    x += width + columnGap;
  }
}

// ------------------------------------------------------------------- routing

/** Left to right, with one bend if the rows differ. */
function forwardEdge(
  from: LayoutBox,
  to: LayoutBox,
  label: string | null,
  confidence: Confidence,
): LayoutEdge {
  const x1 = from.x + from.width;
  const y1 = round(from.y + from.height / 2);
  const x2 = to.x;
  const y2 = round(to.y + to.height / 2);
  const mid = round((x1 + x2) / 2);

  const points: Array<[number, number]> =
    y1 === y2
      ? [
          [x1, y1],
          [x2, y2],
        ]
      : [
          [x1, y1],
          [mid, y1],
          [mid, y2],
          [x2, y2],
        ];

  return {
    from: from.id,
    to: to.id,
    points,
    label,
    labelAt: label === null ? null : [mid, round(Math.min(y1, y2) + Math.abs(y2 - y1) / 2) - 4],
    confidence,
    routed: false,
  };
}

/**
 * Down, across, and back up: for an edge that runs backwards or within a rank.
 *
 * These are the cycles and the sibling dependencies. Routing them through a
 * channel under the diagram keeps them from crossing the boxes, and gives each
 * one its own depth so two never overlap into a single ambiguous line.
 */
function channelEdge(
  from: LayoutBox,
  to: LayoutBox,
  label: string | null,
  confidence: Confidence,
  channelY: number,
): LayoutEdge {
  const x1 = round(from.x + from.width / 2);
  const y1 = from.y + from.height;
  const x2 = round(to.x + to.width / 2);
  const y2 = to.y + to.height;

  return {
    from: from.id,
    to: to.id,
    points: [
      [x1, y1],
      [x1, channelY],
      [x2, channelY],
      [x2, y2],
    ],
    label,
    labelAt: label === null ? null : [round((x1 + x2) / 2), channelY - 4],
    confidence,
    routed: true,
  };
}

/** Half-pixel coordinates render blurry and vary between renderers. */
function round(value: number): number {
  return Math.round(value);
}
