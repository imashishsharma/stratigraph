# ADR-0012: The combined graph, and clustering it deterministically

- Status: accepted
- Date: 2026-07-29
- Milestone: M3 (before the code)

## Context

M3 opens with community detection over "the combined graph". Three things have
to be settled before any of that means something specific.

**What the nodes are.** Layer 2 produces a package-level dependency graph.
Layer 3 produces temporal coupling between *files*, and most of those files are
XML, SQL and properties that no extractor parses. The two halves are not
described at the same granularity, so "combine them" is not yet an instruction.

**How the two edge weights compare.** A static package edge weighs a count of
observed references — 1, or 40, or 900. A coupling edge weighs `strength`, a
ratio in 0..1. Adding them directly means the static half decides everything and
the history half is rounding error. Modularity is invariant to scaling *all*
weights, but not to changing the ratio between two families of them, so the
choice of scale is the choice of result. Picking one silently and moving on is
exactly the failure this project exists to avoid: the partition would look
identical either way, and nothing in the output would reveal which knob produced
it.

**Whether the same input gives the same answer.** Louvain and label propagation
are both usually described with a random node order. On a 650-package repository
that produces a visibly different partition per run — different clusters,
different names, different findings. ADR-0008 already established that a finding
must be checkable by hand; a finding that moves when you re-run the tool is not.

## Decision

**One undirected weighted graph over package nodes, built from both layers,
partitioned by a Louvain implementation that contains no randomness.**

### Nodes are packages

Not files, and not classes.

Packages, because the interpretation layer's whole job at M3 is to compare a
name against a structure — a cluster gets named, and a package whose name
disagrees with its edges is the mismatch finding (ADR-0014). Files have names
too, but a file's name is a much weaker claim about responsibility than a
package path is, and class-level clustering on a large monolith produces
thousands of communities nobody will read.

The consequence is stated rather than hidden: **a run with history and no code
facts gets no clusters at all.** That is the normal case on a machine with no
JDK, and it is the honest answer — without a static graph we have not observed
what package anything belongs to, and grouping files by directory would be
inventing a structure the extractor never reported. `analyze` says so in one
line instead of printing a partition.

### Temporal coupling is projected up, and unparsed files drop out

A `temporal_coupling` row names two repo-relative paths. Each is resolved to its
enclosing package through `source_file.path → source_file.id → node.file_id`,
then up the `parent_id` chain — the same recursive `PACKAGE_OF` walk
`package-graph.ts` already uses for edge endpoints.

A file no extractor walked has no `source_file` row, so it resolves to no
package and contributes no edge. This is deliberate and it is the same principle
as `package-graph.ts` dropping calls into unparsed jars: we do not know what is
in that file, and deriving a package from its path string would be structure we
did not observe. It costs real signal — `pom.xml` and Liquibase changelogs are
among the most coupled files in most repositories — but that signal is already
reported by the M2 coupling section, with citations, where it can be read for
what it is.

Pairs whose two files land in the *same* package contribute nothing, for the
same reason `package-graph.ts` discards intra-package edges: it is every package
ever written.

### Weights: normalise each family, then add

```
w(a,b) = log1p(references) / log1p(maxReferences)   +   couplingWeight × strength
```

Static references are log-scaled first because they are not linear in coupling —
a package pair with 500 references is more entangled than one with 5, but not a
hundred times more, and without the log a handful of hub pairs dominate the
modularity sum. The result is divided by the largest such value in the run, so
the static family spans 0..1. `strength` is already 0..1 by construction.

`couplingWeight` defaults to **1.0** — history and structure weigh the same —
and is exposed as `interpret.couplingWeight`. At `0` the graph is exactly the
static one, which is what makes the knob's effect testable rather than a matter
of opinion.

Edges are made undirected by summing both directions. A cycle is a directed
finding (ADR-0008); a community is not.

### Louvain, implemented here, with no random order

Nodes are visited in `fqn` order. A modularity-gain tie moves the node to the
lowest-numbered community. Passes repeat until no node moves and the aggregated
graph stops improving. There is no shuffle and no seed, so there is nothing to
record in order to reproduce a run: the facts are the seed.

Written in-repo rather than pulled in, at roughly 200 lines. Modularity
optimisation is a short algorithm, and the alternative is a dependency whose
tie-breaking and iteration order we would have to pin anyway to get the
determinism above.

Clusters are `cluster` rows with `authored_by = 'algorithm'` and `name` NULL.
The model fills the name in later (ADR-0013) or does not, and the report is
useful either way, because a cluster's algorithmic label — the longest common
package prefix of its members — is a pure function of its membership and is
computed on read. Storing it would be caching a projection, which ADR-0008
already declined to do for the package graph.

## Alternatives considered

**Cluster the static graph alone, and report temporal coupling that crosses
cluster boundaries as a separate finding.** Genuinely attractive: it avoids
reconciling two weight scales entirely, and "these two modules are held together
by history but not by code" is a sharp claim. Rejected because it answers a
different question than the one PLAN.md asks — the combined graph is meant to
let history *move* a package into the community it actually belongs to, not
merely to annotate a structural partition. Worth revisiting as an additional
rule; `couplingWeight = 0` plus the existing coupling section already
approximates it.

**Cluster files, so history-only runs get clusters too.** Rejected: a file
cluster has no name to check an intent against, so it would carry M3's headline
deliverable — intent-vs-structure mismatch — nowhere. It also doubles the
surface area of every downstream stage for a case where the honest output is
"run `extract` first".

**Label propagation.** Simpler, and PLAN.md offers it as an option. Rejected on
determinism: its output depends on update order much more strongly than
Louvain's, and pinning the order to recover reproducibility costs most of the
simplicity that made it attractive.

**A graph library (graphology, ngraph).** Rejected under CLAUDE.md's rule
against heavyweight runtimes in the core and under "no speculative abstraction":
one algorithm is needed, its determinism requirements are unusual, and a
dependency would have to be constrained into them from the outside.

**Store the combined graph.** Rejected for ADR-0008's reason: it is a
deterministic projection of `node`, `edge` and `temporal_coupling`, so storing it
is a cache that must be invalidated whenever any of the three changes.

**Weight the two families by tuning against a repository we like the answer
on.** Rejected outright. That is fitting the knob to a conclusion, and the
resulting number would carry no meaning on any other codebase while looking
exactly as principled as one that did.

## Consequences

- Clustering runs entirely under `--no-llm`, and is the reason M3's first
  acceptance criterion can pass without a model at all.
- `couplingWeight` is a real knob with a real effect on the partition, so the
  report names its value. A reader who disagrees with the clustering can move it
  and re-run rather than argue with a black box.
- A repository with no history mined still clusters — on the static graph alone,
  since every coupling term is absent rather than zero-weighted. The two cases
  are distinguishable in the report.
- Determinism is now a property tests can assert, and one of them does: the same
  graph presented in shuffled input order must produce the same partition. If
  that test ever fails, a finding somewhere has become unfalsifiable.
- Singleton clusters are kept in the table but collapsed in the report. A
  package that groups with nothing is a fact about the graph, not noise, but
  three hundred of them printed one per line would bury the clusters that matter.
