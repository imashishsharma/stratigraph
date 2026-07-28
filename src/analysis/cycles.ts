/**
 * Package cycle detection.
 *
 * A cycle is not a fact. It is a computed consequence of facts, so it lands in
 * `finding` (authored by an algorithm, not a model) and every one carries
 * `citation` rows pointing at the `edge` rows that produced it. See ADR-0008.
 */

import type { Db } from '../db/database.js';
import {
  buildPackageGraph,
  supportingEdges,
  type PackageGraph,
  type SupportingEdge,
} from './package-graph.js';
import { cyclicComponents } from './tarjan.js';

export const RULE = 'package-cycle';

/** Evidence cited per hop. Enough to verify the hop, few enough to read. */
const EVIDENCE_PER_HOP = 3;

export interface CycleHop {
  from: string;
  to: string;
  evidence: SupportingEdge[];
}

export interface CycleFinding {
  findingId: number;
  /** The cycle proper: each package depends on the next, and the last on the first. */
  path: string[];
  /** Size of the strongly connected component the cycle was found in. */
  componentSize: number;
  severity: 'medium' | 'high';
  hops: CycleHop[];
}

/**
 * Find package cycles for a run and record them as findings.
 *
 * Idempotent: findings from a previous analysis of the same run are replaced,
 * not appended to. Citations go with them via `ON DELETE CASCADE`.
 */
export function detectPackageCycles(db: Db, runId: number): CycleFinding[] {
  const graph = buildPackageGraph(db, runId);
  const components = cyclicComponents({
    nodes: graph.packages.keys(),
    edges: graph.adjacency,
  });

  // Largest tangle first; ties broken by name so output is stable across runs.
  components.sort((a, b) => b.length - a.length || fqn(graph, a[0]).localeCompare(fqn(graph, b[0])));

  const write = db.transaction((): CycleFinding[] => {
    db.prepare('DELETE FROM finding WHERE run_id = ? AND rule = ?').run(runId, RULE);

    const insertFinding = db.prepare(
      `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
       VALUES (@runId, @rule, @title, @detail, @severity, 'algorithm')`,
    );
    const insertCitation = db.prepare(
      `INSERT INTO citation (finding_id, kind, edge_id, file_id, line)
       VALUES (@findingId, 'edge', @edgeId, NULL, @line)`,
    );

    const found: CycleFinding[] = [];
    for (const component of components) {
      const path = shortestCycle(component, graph);
      if (!path) continue; // unreachable for a genuine SCC, but do not guess one

      const hops: CycleHop[] = [];
      for (let i = 0; i < path.length; i += 1) {
        const from = path[i] as number;
        const to = path[(i + 1) % path.length] as number;
        hops.push({
          from: fqn(graph, from),
          to: fqn(graph, to),
          evidence: supportingEdges(db, runId, from, to, EVIDENCE_PER_HOP),
        });
      }

      const severity = component.length > 2 ? 'high' : 'medium';
      const names = path.map((id) => fqn(graph, id));
      const info = insertFinding.run({
        runId,
        rule: RULE,
        title: title(names),
        detail: detail(hops, component, graph),
        severity,
      });
      const findingId = Number(info.lastInsertRowid);

      for (const hop of hops) {
        for (const edge of hop.evidence) {
          insertCitation.run({ findingId, edgeId: edge.edgeId, line: edge.line });
        }
      }

      found.push({ findingId, path: names, componentSize: component.length, severity, hops });
    }
    return found;
  });

  return write();
}

/**
 * The shortest cycle through `component` starting at its alphabetically first
 * package.
 *
 * Reporting a concrete path rather than an unordered bag of packages is what
 * makes a finding checkable by hand: "a imports b imports c imports a" can be
 * opened and verified line by line, whereas "these nine packages are mutually
 * reachable" cannot. Shortest, because the point is to be verifiable.
 */
function shortestCycle(component: number[], graph: PackageGraph): number[] | null {
  const members = new Set(component);
  const start = [...component].sort((a, b) => fqn(graph, a).localeCompare(fqn(graph, b)))[0];
  if (start === undefined) return null;

  const previous = new Map<number, number>();
  const queue: number[] = [start];
  const seen = new Set<number>([start]);

  while (queue.length > 0) {
    const node = queue.shift() as number;
    for (const next of graph.adjacency.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path = [node];
        for (let at = node; previous.has(at); ) {
          at = previous.get(at) as number;
          path.push(at);
        }
        return path.reverse();
      }
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return null;
}

function fqn(graph: PackageGraph, id: number | undefined): string {
  return (id === undefined ? undefined : graph.packages.get(id)?.fqn) ?? '<unknown>';
}

function title(path: string[]): string {
  if (path.length === 2) {
    return `Package cycle: ${path[0]} ⇄ ${path[1]}`;
  }
  return `Package cycle across ${path.length} packages: ${path.join(' → ')} → ${path[0]}`;
}

function detail(hops: CycleHop[], component: number[], graph: PackageGraph): string {
  const lines = hops.map((hop) => {
    const where = hop.evidence
      .map((e) => `${e.kind} ${short(e.srcFqn)} → ${short(e.dstFqn)}${at(e)}`)
      .join('; ');
    return `  ${hop.from} → ${hop.to}: ${where || 'no citable edge'}`;
  });

  if (component.length > hops.length) {
    // The printed cycle is the shortest one; the tangle it sits in is bigger.
    const others = component
      .map((id) => fqn(graph, id))
      .filter((name) => !hops.some((h) => h.from === name))
      .sort();
    lines.push(
      `  part of a strongly connected component of ${component.length} packages, also including: ${others.join(', ')}`,
    );
  }
  return lines.join('\n');
}

function short(fullyQualified: string): string {
  const hash = fullyQualified.lastIndexOf('#');
  const base = hash === -1 ? fullyQualified : fullyQualified.slice(0, hash);
  const simple = base.slice(base.lastIndexOf('.') + 1);
  return hash === -1 ? simple : `${simple}${fullyQualified.slice(hash)}`;
}

function at(edge: SupportingEdge): string {
  if (!edge.path) return '';
  return edge.line === null ? ` (${edge.path})` : ` (${edge.path}:${edge.line})`;
}
