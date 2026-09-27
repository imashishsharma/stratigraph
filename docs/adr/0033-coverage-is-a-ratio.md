# ADR-0033: Coverage is a ratio per extractor and per view, and a view below its threshold is withheld

- Status: accepted; supersedes the `Coverage` booleans of ADR-0026 as the
  reader-facing statement (the booleans remain, and still drive the gaps list)
- Date: 2026-09-28
- Milestone: M10 (before the code)

## Context

ADR-0026 made coverage describe what the store holds: any facts, any edges,
any history, any analysis output. Each is a yes/no. On a real repository every
one of them was "yes" and the report was still wrong, because "yes" covered
both "we read all 1,030 Java files" and "we read 12 of them". A C4 diagram
built from a fraction of a system is not a partial truth — it is a different,
smaller system, drawn with the same confidence as the real one. The reader has
no way to tell, because nothing on the diagram says how much was read.

## Decision

**Every view states a ratio: a numerator, a denominator, and the reasons the
two differ.** All three are counts of stored rows.

- **Denominator** — `file_role` (ADR-0030), now written at extract time as well
  as history time, so it exists for every extracted run.
- **Extractor coverage** — for each extractor: main source files it would parse
  (role `source`, matched by the same extension test that selects the
  extractor), how many of those are in `source_file`, how many test files it
  parsed (reported, never in the ratio), and its `extractor_run` status and
  reason (ADR-0032).
- **View coverage** —
  | View | Numerator / denominator |
  |---|---|
  | architecture, class diagrams, cycles, dependency matrix, HTTP surface | main source files parsed / main source files, all extractors |
  | data model | Java/Kotlin main source files parsed / Java/Kotlin main source files; unread migrations named as a reason |
  | hotspots | source files with a complexity score / source files |
  | co-change | source files with mined history / source files |

**A view whose ratio is below its threshold is withheld.** Its place in the
report holds the statement and the reasons instead of the drawing. The default
threshold is 50%, set by `coverage.minRatio`, overridable per view with
`coverage.views.<view>`. The percentage printed is floored, so a view at 49.6%
never prints the 50% it fell short of.

**No ratio is not a zero ratio.** A run with no inventory at all (built before
this ADR, or through `ingest` with no repository) says "coverage unknown" and is
not withheld: withholding would claim a shortfall the store cannot show. A
repository with no source of the relevant kind says so and is not withheld
either — there is nothing to be short of.

**MCP answers are not withheld.** An agent gets the answer, its view's
coverage, and the sentence that absence at that coverage means unknown. An
agent can reason about a partial answer it is told is partial; a person glancing
at a diagram cannot.

**Findings are not withheld.** Each finding is cited and true as far as it
goes; what low coverage undermines is the *absence* of findings, and the
findings statement says which rule families ran over which coverage.

## Alternatives considered

**Keep booleans and add a warning.** Rejected: this is what ADR-0026 did, and
the warning is three tabs away from the diagram it qualifies.

**Resolution ratios** (injections resolved, calls resolved to a declaration).
Better measures of how *right* a graph is, and the product plan wants them. They
need the classpath work in M13 to mean anything — today, source-only
resolution would report a low ratio for the reason we already know. Files
parsed is the measure that is honest now; resolution ratios join it later as
additional reasons, not a replacement.

**Render below-threshold views with a watermark.** Rejected: a watermarked
diagram still gets screenshotted without the watermark's meaning.

**Persist per-view coverage rows.** Rejected: every input is already stored,
the computation is cheap, and a derived table can disagree with its inputs.
The threshold is configuration, and a stored verdict would outlive a change to
it.

## Consequences

- A repository with Java sources and no JDK now produces a report whose
  architecture and data-model views are withheld with the reason "the java
  extractor did not run: no JDK found", while its Angular half renders.
- Every view has one more line. It is the line that makes the rest checkable.
- The threshold is a judgement call, exposed as config rather than buried; the
  M11 benchmark is where it gets calibrated.
- Coverage counts files, not correctness. A fully parsed file whose injections
  did not resolve counts as covered until M13 adds resolution reasons.
