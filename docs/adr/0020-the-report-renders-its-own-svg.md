# ADR-0020: The HTML report renders its own SVG

- Status: accepted
- Date: 2026-07-31
- Milestone: M6 (before the code)

## Context

M6's acceptance criterion is "you would show the report to your CTO without
editing it first." A report whose diagrams are Mermaid source in a code block
does not meet it. The reader has to see boxes and arrows.

Getting from a Mermaid or Structurizr document to a picture normally means
running a layout engine, and every off-the-shelf way of doing that costs
something this project has already said it will not pay:

- **Mermaid CLI / Structurizr's PNG export** need a headless browser. CLAUDE.md
  lists "a browser" alongside a database server and a JVM in the core as a
  dependency to ask about rather than add, and the whole point of ADR-0004 is
  that `npx stratigraph` works on a machine with nothing else installed.
- **mermaid.js inlined into the HTML** avoids the browser at build time by
  moving it to view time, which is legitimate — the reader already has a
  browser. It costs about 3 MB per generated report and a large runtime
  dependency in `package.json`, and the report stops working with JavaScript
  disabled, which in a lot of enterprises is how a report arrives.
- **A CDN `<script src>`** makes the report phone home when opened. This tool's
  entire pitch is that extraction and history mining never touch the network;
  shipping an artefact that fetches 3 MB from a third party the first time your
  CTO opens it is not a detail, it is the opposite of the promise.

## Decision

**`src/present/` lays out and renders its own SVG, inline in the HTML. No
browser, no JavaScript, no external reference of any kind.**

The layout is a small, deterministic, layered one:

1. **Condense strongly connected components** using the Tarjan implementation
   already in `src/analysis/tarjan.ts`. A dependency graph with a cycle in it
   has no topological order, and cycles are exactly what this tool is built to
   find, so the layout cannot assume acyclicity.
2. **Rank by longest path** over the condensation. Rank is the x axis for a
   left-to-right flow.
3. **Order within a rank** by a fixed number of barycentre passes, seeded by
   `fqn` sort order and never by anything time- or hash-dependent.
4. **Place** with fixed box metrics: a character advance for the monospace font
   stack in the stylesheet, a maximum label width with ellipsis truncation, and
   fixed gutters.
5. **Route** edges as straight lines within adjacent ranks and three-segment
   orthogonal polylines across longer spans.

Every step is deterministic, which is the property that matters most: the same
run produces byte-identical SVG, so a fixture test asserts the actual output
rather than "it contains a `<rect>`", and a report checked into a repository
produces an empty diff until the code changes.

Inference is visible in the rendering, not only in the caption: an inferred
relationship is dashed and labelled, and a model-authored name carries a marker
with a legend entry (ADR-0019).

Mermaid and Structurizr are still emitted, as files. They are the right output
for someone who wants to paste a diagram into a wiki, feed it to Structurizr's
tooling, or lay it out better than we do. The HTML embeds each diagram's Mermaid
source in a `<details>` block underneath the rendered SVG, so both are one click
apart.

## Alternatives considered

**Bundle mermaid.js.** Rejected, as above: 3 MB per report, a heavyweight
dependency, and a report that is blank without JavaScript. It was the pragmatic
option and it was close, because Mermaid's output looks better than ours will.
What decided it was that the report is an artefact people forward by email and
open from a file share, and "blank page unless scripting is on" is a bad failure
mode for the one output non-engineers will see.

**Emit Graphviz `dot` and shell out to `dot`.** Rejected. Graphviz lays out far
better than anything we will write, and if it is installed this would be
strictly superior. It is not installed on a normal laptop, so the report would
be excellent for some users and absent for others, and a report layer whose
output depends on the host's package manager is not a report layer. Kept as a
possible future flag: emitting `dot` alongside `.mmd` costs nothing.

**A force-directed layout.** Rejected. Better for dense graphs, and
non-deterministic unless carefully seeded — which forfeits the byte-identical
property that makes the output testable and diffable. A layered layout is also
simply the right shape for a dependency graph, where direction means something.

**Render diagrams as HTML tables or nested `<div>`s with CSS.** Rejected.
It avoids writing a layout engine, and it cannot draw an edge that is not
between adjacent rows, which is most of them.

## Consequences

- **We own a layout engine.** A few hundred lines that will need attention the
  first time someone points the tool at a graph shaped unlike our fixtures. This
  is the real cost and it is not small.
- **Wide graphs look plain.** A level 3 diagram of forty packages will have long
  edges and crossings that Graphviz would avoid. Mitigated by capping components
  per diagram with an explicit "showing N of K" line, by drawing level 3 per
  container rather than for the whole repository, and by the `.mmd` and `.dsl`
  files being right there for anyone who wants a better renderer.
- **The report is one file, opens anywhere, works offline, and works with
  scripting disabled.** It can be emailed, committed, or served from a static
  bucket with no build step.
- **The output is testable.** Exact-SVG fixture tests catch a layout regression
  the way the extractor's golden tests catch a parser regression, which is the
  standard the rest of this project is held to.
- Nothing here is load-bearing for the fact layer. If a better renderer arrives,
  the C4 model (ADR-0019) is unchanged and only `svg.ts` is replaced.
