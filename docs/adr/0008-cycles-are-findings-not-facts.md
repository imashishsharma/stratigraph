# ADR-0008: A package cycle is a finding, not a fact

- Status: accepted
- Date: 2026-07-29
- Milestone: M1 (after the code — this one was incidental, settled by writing it)

## Context

M1's first analysis reports package dependency cycles. Where should they live?

The tempting answer is the `edge` table: aggregate class-level edges into
package-level ones, store those, and let a cycle be a query. It would make the
M4 MCP server's "check for cycles between two packages" trivial.

But a package edge is not something an extractor saw. It is a count of edges
the extractor saw, projected up a containment tree — and a cycle is a further
consequence of running an algorithm over that projection. The schema was built
so that "which of these did a model produce?" is answerable by looking at the
table name (ADR-0002). The same clarity is worth having for "which of these did
a parser observe?".

There is a second reason, particular to this analysis. M1's acceptance
criterion is that reported cycles are **manually verified correct on at least
three examples**. That is only possible if a cycle arrives with the evidence
attached.

## Decision

**Cycles are `finding` rows with `authored_by = 'algorithm'`, and every one
carries `citation` rows pointing at the `edge` rows that produced it.**

The package graph itself is computed on demand and not stored. It is a
deterministic projection of `node` and `edge`, so storing it would be a cache,
and a cache that must be invalidated whenever facts change.

Three consequences worth stating outright:

1. **Only `confidence = 'fact'` edges take part.** A cycle assembled partly
   from inferred edges — an Angular service matched to a Java endpoint by URL
   pattern at M5, say — is itself an inference, and this analysis presents its
   output as observed structure. When inferred cycles are wanted they will be a
   separate rule with its own severity, not a quiet dilution of this one.

2. **The finding reports a concrete cycle path, not a set of packages.** The
   shortest one through the component, starting at the alphabetically first
   package so the output is stable across runs. "a imports b imports c imports
   a" can be opened and checked line by line; "these nine packages are mutually
   reachable" cannot. Where the short cycle sits inside a larger tangle the
   detail names the rest of the component, so nothing is hidden.

3. **Re-analysing a run replaces its findings rather than appending.** An
   analysis is a pure function of the facts in a run; running it twice must not
   produce two of everything.

Single-node components are not reported even when the node has an edge to
itself. At package level a self-edge means a class referring to another class
in the same package, which is every package ever written.

## Alternatives considered

**Materialise package→package edges in the `edge` table.** Rejected: it puts
derived data in the table whose meaning is "an extractor observed this", and the
`extractor` column would have to lie or be null. A SQL view is the honest
version of this idea and is worth revisiting at M4 if the MCP server's queries
want it — a view derives on read and cannot go stale.

**A dedicated `package_dependency` table.** Rejected for M1 on the grounds that
nothing yet needs it: the graph is cheap to compute and computing it keeps one
fewer thing consistent. Revisit if profiling on a repository much larger than
dubbo says otherwise.

**Report every simple cycle rather than one per component.** Rejected: the
number of simple cycles in a strongly connected component is exponential in its
size, and dubbo's largest component has 262 packages. One verifiable cycle per
component, plus the component's membership, is the useful summary.

**Store cycles as facts because "it is a fact that a cycle exists".** Rejected
on the same reasoning as ADR-0002's separation of interpretation: the value of
the fact tables is that everything in them was *seen*, not merely *entailed*.
Once entailed things live there too, the guarantee is gone and no amount of
documentation restores it.

## Consequences

- A cycle can always be checked by hand, because it names its own evidence with
  file and line. This is what made M1's acceptance criterion checkable at all:
  three cycles in dubbo were verified by opening the cited lines.
- `finding` and `citation` get their first real use before the interpretation
  layer exists, which means the citation machinery is exercised by an algorithm
  that cannot hallucinate before it is trusted with a model that can.
- Analysis re-runs on every `analyze`, costing a few seconds on a 650-package
  repository. Acceptable now; the fix if it stops being acceptable is a view or
  a cache, not a change to where findings live.
