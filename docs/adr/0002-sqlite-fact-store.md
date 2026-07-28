# ADR-0002: SQLite as the fact store, with facts and interpretation in separate tables

- Status: accepted
- Date: 2026-07-28
- Milestone: M0

## Context

Every layer above extraction reads from one store: graph analyses, history
metrics, clustering, report generation, and the MCP server. It must survive a
100k+ LOC repository, support recursive and aggregate queries, be inspectable by
hand, and require nothing to be installed or running.

The project's inviolable rule — the model never invents a fact — has to be
enforceable by the schema, not just by prompt discipline.

## Decision

SQLite, one file per analysed repository, accessed through `better-sqlite3`.

The schema separates the layers physically:

| Layer | Tables |
| --- | --- |
| Facts (from parsers and build files) | `source_file`, `node`, `edge`, `diagnostic` |
| History (from `git log`) | `git_commit`, `commit_file`, `file_metric`, `temporal_coupling` |
| Interpretation (may be model-authored) | `cluster`, `finding`, `citation` |

Rules the schema enforces:

- Every row is scoped to a `run`, so two analyses of the same repo never blend.
- `node` and `edge` carry `file_id` / `line` and the name of the extractor that
  observed them. Provenance is a column, not a convention.
- `edge.confidence` is `fact` or `inferred`, `CHECK`-constrained. Cross-stack
  URL matches (M5) are `inferred` and can never be silently reported as observed.
- `node.is_stub` marks a node that exists only because an edge referenced it —
  a call into a third-party jar, say. We record the edge without pretending we
  parsed the target.
- Interpretation tables carry `authored_by ∈ {algorithm, model}` and the model
  id. Answering "did a model write this?" is a column lookup.
- `citation` has a `CHECK` that forces every row to point at a real node, edge,
  file, or commit sha. A finding with no citations cannot be published; there is
  nowhere in the schema to put an uncited claim.

## Alternatives considered

**DuckDB.** Better at analytical aggregates, and PLAN.md leaves it open if
analytics get heavy. Rejected for now: heavier install, worse prebuilt-binary
story across platforms, and the queries M1–M4 need are graph traversals and
`GROUP BY`s that SQLite handles fine. Revisit if a real query gets slow —
migrating a fact store we can regenerate from source is cheap.

**A graph database (Neo4j).** Rejected: needs a server. CLAUDE.md forbids a
heavyweight runtime dependency, and "install a database first" kills adoption.

**JSON files on disk.** Rejected: no joins, no constraints, and the citation
rule becomes a hope rather than a `CHECK`.

**In-memory only, recomputed per command.** Rejected: the MCP server needs to
answer questions in milliseconds without re-parsing the repo.

## Consequences

- The fact store is a portable artefact. It can be committed, shipped to a
  colleague, or diffed between releases to see how a codebase drifted.
- `better-sqlite3` is a native module. Prebuilt binaries cover the platforms and
  Node versions we support; ADR-0004 covers what happens when they do not.
- Schema changes after M1 need a decision record of their own, per CLAUDE.md.
  The M2/M3 tables exist from the start so the later milestones are additive.
