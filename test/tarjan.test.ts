import { describe, expect, it } from 'vitest';

import {
  cyclicComponents,
  stronglyConnectedComponents,
  type DirectedGraph,
} from '../src/analysis/tarjan.js';

function graph(nodes: number[], pairs: Array<[number, number]>): DirectedGraph {
  const edges = new Map<number, number[]>();
  for (const [src, dst] of pairs) {
    const existing = edges.get(src);
    if (existing) existing.push(dst);
    else edges.set(src, [dst]);
  }
  return { nodes, edges };
}

/** Components come back unordered internally; compare as sorted sets. */
function normalise(components: number[][]): number[][] {
  return components.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!);
}

describe('stronglyConnectedComponents', () => {
  it('puts every node in exactly one component', () => {
    const result = stronglyConnectedComponents(
      graph([1, 2, 3, 4], [
        [1, 2],
        [2, 3],
        [3, 1],
        [3, 4],
      ]),
    );
    expect(normalise(result)).toEqual([[1, 2, 3], [4]]);
  });

  it('handles a graph with no edges at all', () => {
    const result = stronglyConnectedComponents(graph([1, 2, 3], []));
    expect(normalise(result)).toEqual([[1], [2], [3]]);
  });

  it('handles disconnected subgraphs', () => {
    const result = stronglyConnectedComponents(
      graph([1, 2, 3, 4], [
        [1, 2],
        [2, 1],
        [3, 4],
        [4, 3],
      ]),
    );
    expect(normalise(result)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('treats a self-loop as its own single-node component', () => {
    const result = stronglyConnectedComponents(graph([1, 2], [[1, 1], [1, 2]]));
    expect(normalise(result)).toEqual([[1], [2]]);
  });

  it('merges nested cycles into one component', () => {
    // Two triangles sharing an edge are one SCC, not two.
    const result = stronglyConnectedComponents(
      graph([1, 2, 3, 4], [
        [1, 2],
        [2, 3],
        [3, 1],
        [2, 4],
        [4, 2],
      ]),
    );
    expect(normalise(result)).toEqual([[1, 2, 3, 4]]);
  });

  it('emits components in reverse topological order', () => {
    // 1 -> 2 -> 3, so the dependency (3) must come out before its dependents.
    const result = stronglyConnectedComponents(
      graph([1, 2, 3], [
        [1, 2],
        [2, 3],
      ]),
    );
    expect(result).toEqual([[3], [2], [1]]);
  });

  it('tolerates an edge to a node not listed in nodes', () => {
    // Extractors can emit an edge whose target no analysis pass enumerated.
    const result = stronglyConnectedComponents(graph([1], [[1, 99]]));
    expect(normalise(result)).toEqual([[1], [99]]);
  });

  it('survives a graph deep enough to overflow a recursive implementation', () => {
    // A 200k-node chain. The textbook recursive Tarjan dies here; this is the
    // shape a large monolith's package graph actually has.
    const size = 200_000;
    const nodes = Array.from({ length: size }, (_, i) => i);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < size - 1; i += 1) pairs.push([i, i + 1]);
    pairs.push([size - 1, 0]); // close it into one giant cycle

    const result = stronglyConnectedComponents(graph(nodes, pairs));
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(size);
  });
});

describe('cyclicComponents', () => {
  it('excludes single nodes, including self-loops', () => {
    // A package referring to itself is every package ever written, not a finding.
    const result = cyclicComponents(
      graph([1, 2, 3], [
        [1, 1],
        [2, 3],
        [3, 2],
      ]),
    );
    expect(normalise(result)).toEqual([[2, 3]]);
  });

  it('returns nothing for an acyclic graph', () => {
    expect(cyclicComponents(graph([1, 2, 3], [[1, 2], [2, 3]]))).toEqual([]);
  });
});
