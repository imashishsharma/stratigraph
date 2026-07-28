/**
 * Tarjan's strongly connected components.
 *
 * Iterative, not recursive. The textbook formulation recurses once per node,
 * and this runs over the package graph of a 100k+ LOC monolith — the exact
 * input where a recursive implementation dies with a stack overflow on the one
 * repository the user actually cared about.
 */

export interface DirectedGraph {
  /** Every node in the graph, including ones with no edges. */
  nodes: Iterable<number>;
  /** Adjacency list. A node absent from the map has no outgoing edges. */
  edges: ReadonlyMap<number, readonly number[]>;
}

/**
 * Strongly connected components, each in no particular internal order.
 * Components come back in reverse topological order, which is Tarjan's natural
 * output and is worth preserving: it means a component is always emitted before
 * anything that depends on it.
 *
 * Every node appears in exactly one component. A component of one node is not
 * evidence of a cycle unless that node has an edge to itself — callers that
 * care about cycles want {@link cyclicComponents}.
 */
export function stronglyConnectedComponents(graph: DirectedGraph): number[][] {
  const index = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  /** One suspended call of the recursive algorithm: a node and how far through
   *  its successors we had got. */
  interface Frame {
    node: number;
    next: number;
  }

  for (const root of graph.nodes) {
    if (index.has(root)) continue;

    index.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    const work: Frame[] = [{ node: root, next: 0 }];

    while (work.length > 0) {
      const frame = work[work.length - 1] as Frame;
      const successors = graph.edges.get(frame.node) ?? [];

      if (frame.next < successors.length) {
        const successor = successors[frame.next] as number;
        frame.next += 1;

        if (!index.has(successor)) {
          index.set(successor, counter);
          lowlink.set(successor, counter);
          counter += 1;
          stack.push(successor);
          onStack.add(successor);
          work.push({ node: successor, next: 0 });
        } else if (onStack.has(successor)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node) as number, index.get(successor) as number),
          );
        }
        continue;
      }

      // Every successor explored. If this node is a component root, everything
      // above it on the stack is its component.
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: number[] = [];
        for (;;) {
          const member = stack.pop() as number;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component);
      }

      work.pop();
      const caller = work[work.length - 1];
      if (caller) {
        lowlink.set(
          caller.node,
          Math.min(lowlink.get(caller.node) as number, lowlink.get(frame.node) as number),
        );
      }
    }
  }

  return components;
}

/**
 * The components that are actually cycles.
 *
 * A component of two or more nodes always is. A component of one node is only
 * a cycle if the node depends on itself — which at package level means a class
 * in a package referring to another class in the same package, i.e. every
 * package ever written. Those are excluded rather than reported as a finding
 * nobody can act on.
 */
export function cyclicComponents(graph: DirectedGraph): number[][] {
  return stronglyConnectedComponents(graph).filter((c) => c.length > 1);
}
