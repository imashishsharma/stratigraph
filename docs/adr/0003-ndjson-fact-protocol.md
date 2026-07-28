# ADR-0003: NDJSON over stdout as the extractor protocol

- Status: accepted
- Date: 2026-07-28
- Milestone: M0

## Context

ADR-0001 puts extractors in separate processes. They need a wire format that a
JVM process and a Node process can both produce and consume cheaply, that
streams (a large repo produces millions of facts, and we will not hold them all
in memory on either side), and that a human can read when a fact looks wrong.

## Decision

One JSON object per line on stdout. stderr is human-readable logging and is
never parsed.

Five record types, versioned by a `v` field: `meta`, `file`, `node`, `edge`,
`diagnostic`. Extractors identify themselves with a `meta` line first.

Nodes are identified by `(kind, fqn)` strings assigned by the extractor. Edges
reference endpoints by that pair rather than by database id, so an extractor
never needs to know anything about the store — and its output can be captured to
a file, diffed in review, and replayed with `stratigraph ingest --from`.

The core validates every line and **throws on the first malformed one**. A fact
that fails validation is a bug in an extractor; skipping it would silently
produce an incomplete graph, and an incomplete graph presented as complete is
the failure mode this project exists to prevent.

## Alternatives considered

**Protobuf / Cap'n Proto / Avro.** Faster and smaller. Rejected: a schema
compiler and generated code in two languages, for a format whose bottleneck is
parsing Java, not serializing facts. Reconsider if profiling says otherwise.

**One JSON document per run.** Rejected: does not stream; both sides would hold
the whole graph in memory.

**The extractor writes to SQLite directly.** Rejected: every extractor would
need a SQLite driver and knowledge of the schema, coupling every language we
support to our storage decisions. It would also make ADR-0002's provenance rules
unenforceable at a single choke point.

**Skip malformed lines with a warning.** Rejected, as above. Loud failure.

## Consequences

- `extractor | stratigraph ingest` works, and so does capturing facts to a file
  for fixture tests that assert exact output (a CLAUDE.md requirement).
- Protocol changes need a `v` bump and a compatibility decision.
- Ingest is currently one process reading one stream. Parallel extractors will
  need either separate ingests or a merge step; that decision belongs to M1.
