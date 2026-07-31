import { describe, expect, it } from 'vitest';

import type { C4Diagram, C4Element, C4Relationship } from '../src/present/c4.js';
import { layout, truncate, type Layout } from '../src/present/layout.js';
import { escapeAttr, escapeText, toSvg } from '../src/present/svg.js';

function element(
  id: string,
  overrides: Partial<C4Element> = {},
): C4Element {
  return {
    id,
    name: id,
    kind: 'component',
    technology: null,
    description: null,
    inference: false,
    group: null,
    groupInference: false,
    evidence: [],
    ...overrides,
  };
}

function relationship(from: string, to: string, overrides: Partial<C4Relationship> = {}): C4Relationship {
  return { from, to, label: 'imports', count: 1, confidence: 'fact', evidence: [], ...overrides };
}

function diagram(elements: C4Element[], relationships: C4Relationship[] = []): C4Diagram {
  return {
    level: 'component',
    scope: null,
    title: 'test',
    elements,
    relationships,
    notes: [],
  };
}

function boxAt(result: Layout, id: string) {
  return result.boxes.find((box) => box.id === id);
}

describe('ranking', () => {
  it('puts a dependency to the right of what depends on it', () => {
    const result = layout(
      diagram([element('a'), element('b'), element('c')], [
        relationship('a', 'b'),
        relationship('b', 'c'),
      ]),
    );

    const [a, b, c] = ['a', 'b', 'c'].map((id) => boxAt(result, id));
    expect(a?.x).toBeLessThan(b?.x as number);
    expect(b?.x).toBeLessThan(c?.x as number);
  });

  it('ranks by longest path, not by first path found', () => {
    // a → b → c and a → c. `c` belongs in rank 2, behind the longer route,
    // or the a→c line would run backwards through b's column.
    const result = layout(
      diagram([element('a'), element('b'), element('c')], [
        relationship('a', 'b'),
        relationship('b', 'c'),
        relationship('a', 'c'),
      ]),
    );
    const columns = new Set(result.boxes.map((box) => box.x));
    expect(columns.size).toBe(3);
  });

  it('lays out a cycle rather than failing on it', () => {
    // The whole tool exists to find cycles, so the layout cannot assume a
    // topological order exists.
    const result = layout(
      diagram([element('a'), element('b')], [relationship('a', 'b'), relationship('b', 'a')]),
    );

    expect(result.boxes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    // Same strongly connected component, so the same rank and therefore the
    // same column; one of the two edges is routed under the diagram.
    expect(boxAt(result, 'a')?.x).toBe(boxAt(result, 'b')?.x);
    expect(result.edges.filter((edge) => edge.routed)).toHaveLength(2);
  });

  it('places an element nothing points at', () => {
    const result = layout(diagram([element('lonely')]));
    expect(boxAt(result, 'lonely')).toMatchObject({ x: 20, y: 20 });
  });

  it('ignores a relationship naming an element the diagram does not hold', () => {
    const result = layout(diagram([element('a')], [relationship('a', 'gone')]));
    expect(result.edges).toEqual([]);
  });
});

describe('placement', () => {
  it('is deterministic to the pixel', () => {
    const build = (): Layout =>
      layout(
        diagram(
          [element('a'), element('b'), element('c'), element('d')],
          [relationship('a', 'b'), relationship('a', 'c'), relationship('b', 'd'), relationship('c', 'd')],
        ),
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('gives an element the same coordinates whatever order it arrives in', () => {
    const coordinates = (result: Layout): string =>
      JSON.stringify(
        result.boxes
          .map((box) => [box.id, box.x, box.y])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );

    expect(coordinates(layout(diagram([element('a'), element('b')], [relationship('a', 'b')])))).toBe(
      coordinates(layout(diagram([element('b'), element('a')], [relationship('a', 'b')]))),
    );
  });

  it('gives every box in a column the same width', () => {
    const result = layout(
      diagram([
        element('short'),
        element('a-considerably-longer-component-name'),
      ]),
    );
    const widths = new Set(result.boxes.map((box) => box.width));
    expect(widths.size).toBe(1);
  });

  it('grows a box for each line it has to show', () => {
    const plain = layout(diagram([element('a')]));
    const detailed = layout(
      diagram([
        element('a', { technology: 'java', description: '2 packages', group: 'Ordering' }),
      ]),
    );
    expect(detailed.boxes[0]?.height).toBeGreaterThan(plain.boxes[0]?.height as number);
  });

  it('lays out nothing for an empty diagram', () => {
    expect(layout(diagram([]))).toEqual({
      width: 0,
      height: 0,
      boxes: [],
      edges: [],
      notes: [],
    });
  });
});

describe('routing', () => {
  it('draws a straight line between two boxes on the same row', () => {
    const result = layout(diagram([element('a'), element('b')], [relationship('a', 'b')]));
    const edge = result.edges[0];
    expect(edge?.points).toHaveLength(2);
    expect(edge?.points[0]?.[1]).toBe(edge?.points[1]?.[1]);
    expect(edge?.routed).toBe(false);
  });

  it('bends once when the rows differ', () => {
    const result = layout(
      diagram([element('a'), element('b'), element('c')], [
        relationship('a', 'b'),
        relationship('a', 'c'),
      ]),
    );
    expect(result.edges[0]?.points).toHaveLength(4);
  });

  it('routes every edge of a cycle through a channel below the diagram', () => {
    // a → b → c → a is one strongly connected component, so all three share a
    // rank and therefore a column, and no edge among them runs left to right.
    // The column is what makes the cycle visible; the channels are what keep
    // the three lines from merging into one.
    const result = layout(
      diagram([element('a'), element('b'), element('c')], [
        relationship('a', 'b'),
        relationship('b', 'c'),
        relationship('c', 'a'),
      ]),
    );
    const back = result.edges.filter((edge) => edge.routed);
    expect(back).toHaveLength(3);

    const contentBottom = Math.max(...result.boxes.map((box) => box.y + box.height));
    for (const edge of back) {
      expect(edge.points[1]?.[1]).toBeGreaterThan(contentBottom);
      expect(result.height).toBeGreaterThan(edge.points[1]?.[1] as number);
    }
  });

  it('gives two routed edges different channels so they do not merge', () => {
    const result = layout(
      diagram([element('a'), element('b'), element('c')], [
        relationship('a', 'b'),
        relationship('b', 'a'),
        relationship('c', 'a'),
      ]),
    );
    const depths = result.edges.filter((e) => e.routed).map((e) => e.points[1]?.[1]);
    expect(new Set(depths).size).toBe(depths.length);
  });

  it('drops line labels past the limit and says that it did', () => {
    const elements = Array.from({ length: 20 }, (_, n) => element(`n${n}`));
    const relationships = Array.from({ length: 16 }, (_, n) =>
      relationship('n0', `n${n + 1}`),
    );
    const result = layout(diagram(elements, relationships));

    expect(result.edges.every((edge) => edge.label === null)).toBe(true);
    expect(result.notes.join('\n')).toContain('line labels are omitted');
  });

  it('keeps line labels below the limit', () => {
    const result = layout(diagram([element('a'), element('b')], [relationship('a', 'b')]));
    expect(result.edges[0]?.label).toBe('imports');
    expect(result.notes).toEqual([]);
  });

  it('widens the gutter so a long label is not overdrawn by the boxes', () => {
    // Boxes are painted over the lines, so a label wider than the gap between
    // two columns disappears behind the box it overhangs.
    const short = layout(diagram([element('a'), element('b')], [relationship('a', 'b')]));
    const long = layout(
      diagram([element('a'), element('b')], [
        relationship('a', 'b', { label: 'injects, calls, imports' }),
      ]),
    );

    const gutter = (result: Layout): number => {
      const [first, second] = result.boxes;
      return (second?.x as number) - ((first?.x as number) + (first?.width as number));
    };
    expect(gutter(long)).toBeGreaterThan(gutter(short));

    const label = long.edges[0]?.label as string;
    expect(gutter(long)).toBeGreaterThanOrEqual(label.length * 6);
  });

  it('truncates an edge label from the end, where it loses least', () => {
    const result = layout(
      diagram([element('a'), element('b')], [
        relationship('a', 'b', { label: 'injects, calls, imports, extends, implements' }),
      ]),
    );
    expect(result.edges[0]?.label).toBe('injects, calls, impor…');
  });
});

describe('truncate', () => {
  it('keeps the tail, which is the part that distinguishes an fqn', () => {
    const truncated = truncate('com.example.shop.billing.tax.Calculator');
    expect(truncated).toBe('…ample.shop.billing.tax.Calculator');
    expect(truncated).toHaveLength(34);
    expect(truncate('short.name')).toBe('short.name');
  });
});

describe('SVG output', () => {
  it('renders a two-box diagram exactly', () => {
    // Every number here is checkable by hand, which is the point of asserting
    // the whole string: box 20..140, one 72px gutter, box 212..332, plus a
    // 20px margin gives 352. The label is 7 characters at 6px plus 8 of
    // padding, centred on the midpoint of a 140→212 line.
    const result = layout(diagram([element('a'), element('b')], [relationship('a', 'b')]));
    expect(toSvg(result, 'd1')).toBe(
      [
        '<svg class="diagram" role="img" aria-label="2 element(s), 1 relationship(s)" viewBox="0 0 352 76" width="352" height="76" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, &#39;DejaVu Sans Mono&#39;, monospace">',
        '<defs>',
        '<marker id="d1-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e"/></marker>',
        '<marker id="d1-arrow-inferred" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#e3b341"/></marker>',
        '</defs>',
        '<polyline points="140,38 212,38" fill="none" stroke="#8b949e" stroke-width="1.5" marker-end="url(#d1-arrow)"/>',
        '<rect x="151" y="23" width="50" height="14" rx="3" fill="#161b22" opacity="0.9"/>',
        '<text x="176" y="34" text-anchor="middle" font-size="10" fill="#8b949e">imports</text>',
        '<g>',
        '<rect x="20" y="20" width="120" height="36" rx="6" fill="#2d333b" stroke="#57606a" stroke-width="1.5"/>',
        '<text x="80" y="42" text-anchor="middle" font-size="12" fill="#f0f6fc" font-weight="600">a</text>',
        '</g>',
        '<g>',
        '<rect x="212" y="20" width="120" height="36" rx="6" fill="#2d333b" stroke="#57606a" stroke-width="1.5"/>',
        '<text x="272" y="42" text-anchor="middle" font-size="12" fill="#f0f6fc" font-weight="600">b</text>',
        '</g>',
        '</svg>',
      ].join('\n'),
    );
  });

  it('draws an inferred relationship dashed and in the inference colour', () => {
    const result = layout(
      diagram([element('a'), element('b')], [
        relationship('a', 'b', { confidence: 'inferred' }),
      ]),
    );
    const svg = toSvg(result, 'd');
    expect(svg).toContain('stroke="#e3b341"');
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('marker-end="url(#d-arrow-inferred)"');
  });

  it('draws a model-authored element with a dashed border', () => {
    const result = layout(diagram([element('a', { inference: true })]));
    const svg = toSvg(result, 'd');
    expect(svg).toContain('stroke="#e3b341" stroke-width="1.5" stroke-dasharray="5 3"');
    expect(svg).toContain('name is inference');
  });

  it('namespaces markers so two diagrams on one page do not collide', () => {
    const result = layout(diagram([element('a'), element('b')], [relationship('a', 'b')]));
    expect(toSvg(result, 'context')).toContain('id="context-arrow"');
    expect(toSvg(result, 'container')).toContain('id="container-arrow"');
  });

  it('renders nothing but an empty element for an empty diagram', () => {
    expect(toSvg(layout(diagram([])), 'd')).toContain('width="0" height="0"');
  });

  it('contains no script and no external reference', () => {
    const result = layout(
      diagram([element('a', { technology: 'java' }), element('b')], [relationship('a', 'b')]),
    );
    const svg = toSvg(result, 'd');
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe('SVG escaping', () => {
  it('escapes the ampersand first, so its own entities survive', () => {
    expect(escapeText('a & b < c')).toBe('a &amp; b &lt; c');
    expect(escapeText('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes quotes in an attribute value', () => {
    expect(escapeAttr(`a "b" 'c'`)).toBe('a &quot;b&quot; &#39;c&#39;');
  });

  it('escapes an element name containing markup', () => {
    const result = layout(diagram([element('x', { name: '<img src=x>' })]));
    const svg = toSvg(result, 'd');
    expect(svg).toContain('&lt;img src=x&gt;');
    expect(svg).not.toContain('<img');
  });
});
