/**
 * Louvain modularity optimisation, with every source of randomness removed.
 *
 * The usual description of this algorithm visits nodes in a random order, which
 * on a large repository produces a visibly different partition per run:
 * different clusters, different names, different findings. ADR-0008 requires a
 * finding to be checkable by hand, and a finding that moves when you re-run the
 * tool is not. So ADR-0012 fixes the order instead.
 *
 * Two rules give that:
 *
 * 1. Nodes are visited in `key` order — the package fqn, not the database id.
 *    Ids are assigned by insertion and differ between two databases built from
 *    the same repository; fqns do not.
 * 2. A tie in modularity gain resolves to the lowest-numbered community, and
 *    candidate communities are examined in ascending order so that near-ties in
 *    floating point resolve the same way regardless of input order.
 *
 * Nothing here reads the database, and nothing here is specific to packages.
 */

/** A node, identified by `id` and ordered by `key`. */
export interface GraphNode {
  id: number;
  /** Determines visit order, and therefore the partition. Use a stable name. */
  key: string;
}

/**
 * An undirected edge. Direction is ignored, and a pair supplied more than once
 * has its weights summed — which is how the combined graph adds a static and a
 * temporal term for the same package pair (ADR-0012).
 */
export interface WeightedEdge {
  a: number;
  b: number;
  weight: number;
}

export interface WeightedGraph {
  nodes: readonly GraphNode[];
  edges: readonly WeightedEdge[];
}

export interface Partition {
  /** Members per community, ordered by each community's lowest member key. */
  communities: number[][];
  /** Node id to index into `communities`. */
  communityOf: Map<number, number>;
  /** Newman-Girvan modularity of the returned partition, over the input graph. */
  modularity: number;
}

/**
 * Comparing floating-point modularity gains. Weights arriving from
 * `combined-graph.ts` are normalised into 0..1, so gains are O(1) and an
 * absolute tolerance is meaningful.
 */
const EPSILON = 1e-12;

/** Guards against a non-converging level; far above what any real graph needs. */
const MAX_ITERATIONS = 100;

/** Guards against a non-converging aggregation. Each level strictly shrinks. */
const MAX_LEVELS = 50;

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * An adjacency structure at one level of the aggregation.
 *
 * `selfWeight` holds a node's internal weight — a self-loop at level 0, and the
 * edges inside a community at every level above. It is counted once in `m` and
 * twice in `degree`, which is the convention that keeps `sum(degree) === 2m`.
 */
interface Level {
  size: number;
  neighbours: Array<Map<number, number>>;
  selfWeight: number[];
  degree: number[];
  m: number;
}

export function louvain(graph: WeightedGraph): Partition {
  // Key order, not id order, and not the caller's order.
  const ordered = [...graph.nodes].sort((a, b) => a.key.localeCompare(b.key) || a.id - b.id);
  const indexOf = new Map<number, number>();
  for (const [index, node] of ordered.entries()) indexOf.set(node.id, index);

  const base = buildLevel(ordered.length, graph.edges, indexOf);

  // With no edges every node is its own community and modularity is undefined
  // by the usual formula; zero is the honest value and singletons the honest
  // partition. Returning early also keeps `2m` out of a denominator.
  if (base.m === 0) {
    return assemble(
      ordered.map((_, index) => [index]),
      ordered,
      base,
    );
  }

  // `membership[i]` is the index, in the current level, of the community that
  // original node i has ended up in.
  let membership = ordered.map((_, index) => index);
  let level = base;

  for (let pass = 0; pass < MAX_LEVELS; pass += 1) {
    const local = optimiseLevel(level);
    if (!local.moved) break;

    const dense = renumber(local.community, level.size);
    membership = membership.map(
      (at) => dense.map[local.community[at] as number] as number,
    );
    if (dense.count === level.size) break; // nothing merged; aggregating changes nothing
    level = aggregate(level, local.community, dense.map, dense.count);
  }

  const grouped: number[][] = [];
  for (const [index] of ordered.entries()) {
    const community = membership[index] as number;
    (grouped[community] ??= []).push(index);
  }

  return assemble(grouped.filter((members) => members !== undefined), ordered, base);
}

/** Index the edge list into adjacency, summing repeats and ignoring direction. */
function buildLevel(
  size: number,
  edges: readonly WeightedEdge[],
  indexOf: Map<number, number>,
): Level {
  const neighbours: Array<Map<number, number>> = Array.from({ length: size }, () => new Map());
  const selfWeight = new Array<number>(size).fill(0);
  let m = 0;

  for (const edge of edges) {
    const a = indexOf.get(edge.a);
    const b = indexOf.get(edge.b);
    if (a === undefined || b === undefined) {
      throw new GraphError(
        `edge ${edge.a} → ${edge.b} names a node that is not in the graph`,
      );
    }
    if (!Number.isFinite(edge.weight) || edge.weight < 0) {
      throw new GraphError(`edge ${edge.a} → ${edge.b} has weight ${edge.weight}`);
    }
    if (edge.weight === 0) continue;

    m += edge.weight;
    if (a === b) {
      selfWeight[a] = (selfWeight[a] as number) + edge.weight;
      continue;
    }
    addWeight(neighbours[a] as Map<number, number>, b, edge.weight);
    addWeight(neighbours[b] as Map<number, number>, a, edge.weight);
  }

  return { size, neighbours, selfWeight, degree: degrees(neighbours, selfWeight), m };
}

function degrees(
  neighbours: Array<Map<number, number>>,
  selfWeight: number[],
): number[] {
  return neighbours.map((adjacent, index) => {
    let total = 2 * (selfWeight[index] as number);
    for (const weight of adjacent.values()) total += weight;
    return total;
  });
}

function addWeight(into: Map<number, number>, at: number, weight: number): void {
  into.set(at, (into.get(at) ?? 0) + weight);
}

/**
 * The local-moving phase: repeatedly move each node into whichever neighbouring
 * community gives the largest modularity gain, until nothing moves.
 *
 * The gain of moving node `i` into community `c`, once `i` has been taken out
 * of its own, is proportional to
 *
 *     w(i, c) − degree(i) · Σtot(c) / 2m
 *
 * and the constant of proportionality (1/m) is the same for every candidate, so
 * it is dropped. Comparing candidates in ascending community order, with a
 * strictly-greater test, is what makes the tie-break "lowest community wins".
 */
function optimiseLevel(level: Level): { community: number[]; moved: boolean } {
  const community = Array.from({ length: level.size }, (_, index) => index);
  const sigmaTotal = [...level.degree];
  const twiceM = 2 * level.m;
  let movedEver = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    let movedThisPass = false;

    for (let node = 0; node < level.size; node += 1) {
      const previous = community[node] as number;
      const degree = level.degree[node] as number;
      sigmaTotal[previous] = (sigmaTotal[previous] as number) - degree;

      // Weight from this node to each candidate community. The node's previous
      // community is always a candidate: if it is now empty, that is the
      // "stay isolated" option, scoring zero.
      const weightTo = new Map<number, number>([[previous, 0]]);
      for (const [other, weight] of level.neighbours[node] as Map<number, number>) {
        addWeight(weightTo, community[other] as number, weight);
      }

      let best = previous;
      let bestScore = -Infinity;
      for (const candidate of [...weightTo.keys()].sort((a, b) => a - b)) {
        const score =
          (weightTo.get(candidate) as number) -
          (degree * (sigmaTotal[candidate] as number)) / twiceM;
        if (score > bestScore + EPSILON) {
          best = candidate;
          bestScore = score;
        }
      }

      sigmaTotal[best] = (sigmaTotal[best] as number) + degree;
      community[node] = best;
      if (best !== previous) {
        movedThisPass = true;
        movedEver = true;
      }
    }

    if (!movedThisPass) break;
  }

  return { community, moved: movedEver };
}

/**
 * Compact community labels to `0..count-1`, numbered by each community's lowest
 * member index. Since indices are key-sorted, that is "ordered by lowest member
 * key" — which is what makes the community numbering itself reproducible.
 */
function renumber(community: number[], size: number): { map: number[]; count: number } {
  const map = new Array<number>(size).fill(-1);
  let count = 0;
  for (let node = 0; node < community.length; node += 1) {
    const label = community[node] as number;
    if (map[label] === -1) {
      map[label] = count;
      count += 1;
    }
  }
  return { map, count };
}

/**
 * Collapse each community into a single node for the next level.
 *
 * Every cross pair is visited from both ends, which is what an undirected
 * adjacency wants; every internal pair is visited from both ends too, so it
 * contributes half its weight each time and lands in `selfWeight` exactly once.
 * `m` is unchanged by construction — aggregation moves weight between the
 * internal and external buckets, it does not create or destroy any.
 */
function aggregate(
  level: Level,
  community: number[],
  map: number[],
  count: number,
): Level {
  const neighbours: Array<Map<number, number>> = Array.from({ length: count }, () => new Map());
  const selfWeight = new Array<number>(count).fill(0);

  for (let node = 0; node < level.size; node += 1) {
    const from = map[community[node] as number] as number;
    selfWeight[from] = (selfWeight[from] as number) + (level.selfWeight[node] as number);

    for (const [other, weight] of level.neighbours[node] as Map<number, number>) {
      const to = map[community[other] as number] as number;
      if (to === from) {
        selfWeight[from] = (selfWeight[from] as number) + weight / 2;
      } else {
        addWeight(neighbours[from] as Map<number, number>, to, weight);
      }
    }
  }

  return {
    size: count,
    neighbours,
    selfWeight,
    degree: degrees(neighbours, selfWeight),
    m: level.m,
  };
}

/**
 * Assemble the final result: order communities by lowest member key, translate
 * indices back to node ids, and measure the partition on the original graph.
 */
function assemble(
  grouped: number[][],
  ordered: readonly GraphNode[],
  base: Level,
): Partition {
  const sorted = grouped
    .map((members) => [...members].sort((a, b) => a - b))
    .filter((members) => members.length > 0)
    .sort((a, b) => (a[0] as number) - (b[0] as number));

  const communities = sorted.map((members) =>
    members.map((index) => (ordered[index] as GraphNode).id),
  );
  const communityOf = new Map<number, number>();
  for (const [community, members] of sorted.entries()) {
    for (const index of members) communityOf.set((ordered[index] as GraphNode).id, community);
  }

  return { communities, communityOf, modularity: modularity(sorted, base) };
}

/**
 * Newman-Girvan modularity, measured on the level-0 graph:
 *
 *     Q = Σ_c [ internal(c)/m − (Σtot(c)/2m)² ]
 *
 * `internal` counts each edge inside a community once, self-loops included,
 * which is the convention that makes the whole graph as one community score
 * exactly zero.
 */
function modularity(communities: number[][], base: Level): number {
  if (base.m === 0) return 0;

  const of = new Array<number>(base.size).fill(-1);
  for (const [community, members] of communities.entries()) {
    for (const index of members) of[index] = community;
  }

  let total = 0;
  for (const members of communities) {
    let internal = 0;
    let degree = 0;
    for (const node of members) {
      internal += base.selfWeight[node] as number;
      degree += base.degree[node] as number;
      for (const [other, weight] of base.neighbours[node] as Map<number, number>) {
        // Each cross pair is visited from both ends; halve rather than compare
        // indices, so the sum does not depend on member order.
        if (of[other] === of[node]) internal += weight / 2;
      }
    }
    total += internal / base.m - (degree / (2 * base.m)) ** 2;
  }
  return total;
}
