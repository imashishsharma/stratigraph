import { describe, expect, it } from 'vitest';

import { louvain, type WeightedEdge, type WeightedGraph } from '../src/analysis/louvain.js';

/** Build a graph from `key` strings, assigning ids in the order given. */
function graph(keys: string[], edges: Array<[string, string, number]>): WeightedGraph {
  const id = new Map(keys.map((key, index) => [key, index + 1]));
  return {
    nodes: keys.map((key) => ({ id: id.get(key) as number, key })),
    edges: edges.map(([a, b, weight]) => ({
      a: id.get(a) as number,
      b: id.get(b) as number,
      weight,
    })),
  };
}

/** The partition as sets of keys, so assertions do not depend on ids. */
function communities(result: ReturnType<typeof louvain>, input: WeightedGraph): string[][] {
  const key = new Map(input.nodes.map((node) => [node.id, node.key]));
  return result.communities.map((members) =>
    members.map((id) => key.get(id) as string).sort(),
  );
}

/** Two triangles joined by one weak edge. The obvious partition is the two triangles. */
const TWO_TRIANGLES: Array<[string, string, number]> = [
  ['a1', 'a2', 1],
  ['a1', 'a3', 1],
  ['a2', 'a3', 1],
  ['b1', 'b2', 1],
  ['b1', 'b3', 1],
  ['b2', 'b3', 1],
  ['a1', 'b1', 0.1],
];

describe('louvain', () => {
  it('separates two weakly joined cliques', () => {
    const input = graph(['a1', 'a2', 'a3', 'b1', 'b2', 'b3'], TWO_TRIANGLES);
    const result = louvain(input);

    expect(communities(result, input)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result.modularity).toBeGreaterThan(0.3);
  });

  it('numbers communities by their lowest member key, not by input order', () => {
    // Same graph, nodes declared b-first. The b community must still come second.
    const input = graph(['b3', 'b2', 'b1', 'a3', 'a2', 'a1'], TWO_TRIANGLES);
    const result = louvain(input);

    expect(communities(result, input)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
  });

  it('is deterministic under shuffled input order', () => {
    // A partition that moves between runs makes every finding built on it
    // unfalsifiable, which is the whole reason ADR-0012 forbids a random order.
    const keys = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3'];
    const edges: Array<[string, string, number]> = [
      ...TWO_TRIANGLES,
      ['c1', 'c2', 1],
      ['c1', 'c3', 1],
      ['c2', 'c3', 1],
      ['c1', 'a2', 0.1],
      ['c2', 'b2', 0.1],
    ];

    const baseline = louvain(graph(keys, edges));
    const expected = communities(baseline, graph(keys, edges));

    // A deterministic shuffle: several distinct rotations of both lists.
    for (let shift = 1; shift < keys.length; shift += 1) {
      const rotatedKeys = [...keys.slice(shift), ...keys.slice(0, shift)];
      const rotatedEdges = [...edges.slice(shift % edges.length), ...edges.slice(0, shift % edges.length)];
      const reversedEdges: Array<[string, string, number]> = rotatedEdges.map(
        ([a, b, w]) => (shift % 2 === 0 ? [b, a, w] : [a, b, w]),
      );

      const input = graph(rotatedKeys, reversedEdges);
      expect(communities(louvain(input), input)).toEqual(expected);
      expect(louvain(input).modularity).toBeCloseTo(baseline.modularity, 10);
    }
  });

  it('puts every node in its own community when there are no edges', () => {
    const input = graph(['b', 'a', 'c'], []);
    const result = louvain(input);

    expect(communities(result, input)).toEqual([['a'], ['b'], ['c']]);
    expect(result.modularity).toBe(0);
    expect(result.communityOf.get(input.nodes[1]?.id as number)).toBe(0); // 'a' sorts first
  });

  it('handles a single node', () => {
    const input = graph(['only'], []);
    expect(communities(louvain(input), input)).toEqual([['only']]);
  });

  it('merges everything when the graph is a single clique', () => {
    const input = graph(['a', 'b', 'c'], [
      ['a', 'b', 1],
      ['b', 'c', 1],
      ['a', 'c', 1],
    ]);
    expect(communities(louvain(input), input)).toEqual([['a', 'b', 'c']]);
  });

  it('lets edge weight decide: a strong bridge merges what a weak one does not', () => {
    const weak = graph(['a1', 'a2', 'b1', 'b2'], [
      ['a1', 'a2', 1],
      ['b1', 'b2', 1],
      ['a1', 'b1', 0.01],
    ]);
    expect(louvain(weak).communities).toHaveLength(2);

    const strong = graph(['a1', 'a2', 'b1', 'b2'], [
      ['a1', 'a2', 1],
      ['b1', 'b2', 1],
      ['a1', 'b1', 10],
    ]);
    expect(louvain(strong).communities).toHaveLength(1);
  });

  it('counts a repeated pair once, however the caller supplies it', () => {
    // The combined graph adds a static and a temporal term for the same pair;
    // both arrive as separate edges and must sum rather than fight.
    const merged = graph(['a', 'b'], [['a', 'b', 3]]);
    const split: readonly WeightedEdge[] = graph(['a', 'b'], [
      ['a', 'b', 1],
      ['b', 'a', 2],
    ]).edges;

    const one = louvain(merged);
    const two = louvain({ nodes: merged.nodes, edges: split });
    expect(two.modularity).toBeCloseTo(one.modularity, 10);
    expect(two.communities).toEqual(one.communities);
  });

  it('ignores a self-loop for the purpose of grouping', () => {
    const input = graph(['a', 'b'], [
      ['a', 'a', 5],
      ['a', 'b', 1],
    ]);
    expect(communities(louvain(input), input)).toEqual([['a', 'b']]);
  });
});
