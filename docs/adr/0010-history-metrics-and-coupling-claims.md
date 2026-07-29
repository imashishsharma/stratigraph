# ADR-0010: History metrics are arithmetic; coupling claims are findings

- Status: accepted
- Date: 2026-07-29
- Milestone: M2 (before the code)

## Context

M2 produces two very different kinds of output from the same git log.

One kind is counting. This file was touched in 214 commits by 9 authors, 61% of
them by one person, between 2019-03-11 and 2026-06-02. There is no judgement
anywhere in that sentence. Given the same repository at the same commit, any
implementation must produce the same numbers, and disagreeing with them means
finding an arithmetic error.

The other kind is a claim. *`OrderService.java` and `order-form.component.ts`
change together in 38 of the 44 commits that touch either of them, and nothing
in the code connects them.* That is the output M2 exists for — PLAN.md calls it
"where the real damage lives" — and it is not a count. It is a count, plus a
threshold, plus an inference that the co-change means something.

ADR-0008 already settled the shape of this distinction for layer 2: a cycle is a
`finding` with `citation` rows, not an `edge`. M2 needs the same line drawn in
layer 3, and the schema anticipated it — `file_metric` and `temporal_coupling`
sit **above** the comment marking where interpretation begins, and
`citation.kind = 'commit'` has existed since M0 without a single row.

## Decision

**Counts go in `file_metric` and `temporal_coupling`. Claims go in `finding`,
and every one cites the commit shas that produced it.**

### What is a count

`file_metric` — commits, churn, complexity, authors, top author share, first and
last change. `temporal_coupling` — shared commits, per-file commit counts,
strength, and how many static edges connect the pair.

These are stored because they are expensive to recompute (`temporal_coupling`
is a pass over every commit's file list) and because M4's MCP server will want
to query them directly. They are stored *as numbers*, with no ranking, no
threshold applied at write time beyond the ones ADR-0011 records, and no
severity.

`complexity` is the one column here that is a proxy rather than a count, and it
is named as such in the schema. It is total indentation: the sum, over
non-blank lines, of each line's indent depth. It is not cyclomatic complexity
and does not claim to be. It is stored because Tornhill's observation holds up —
indentation tracks nesting, nesting tracks branching — and because it needs no
parser, so it works on the XML, SQL and shell scripts that the Java extractor
never sees.

### What is a claim

Three rules, all `authored_by = 'algorithm'`:

| rule | claim |
| --- | --- |
| `logical-coupling` | these two files change together far more than chance and nothing in the code connects them |
| `hotspot` | this file is both heavily changed and structurally complex |
| `bus-factor` | this file's history is concentrated in very few people |

Each is a `finding` with `citation` rows of `kind = 'commit'` carrying real
shas. This is what makes the acceptance criterion — *explain why at least five
of them are coupled* — answerable at all: the finding hands over the commits to
read.

A `logical-coupling` finding is written **only when `static_edges = 0`**. A pair
that co-changes and also imports each other is not news; it is the dependency
doing its job. The pairs worth a finding are the ones the static graph cannot
see, which is precisely PLAN.md's target.

### Citations are commits, not files

Tempting to cite `kind = 'file'` — the finding is about files, after all. But
`citation.file_id` references `source_file`, which only has rows for files an
*extractor* walked. History covers every file in the repository, including the
`.xml`, `.properties` and `.sql` that no extractor parses, and those are often
exactly the ones in a coupling pair. Citing commits works for every file, and a
sha is a stronger citation anyway: it can be fetched, read and disagreed with.

## Alternatives considered

**Put coupling in the `edge` table with `confidence = 'inferred'`, as a
`co_changes` edge kind.** Genuinely attractive — it would make M4's traversal
queries uniform, and `inferred` already exists for exactly this sort of thing.
Rejected because an `edge` row is between two `node` rows, and most files in a
coupling pair have no node: no class, no package, nothing the extractor emitted.
Creating stub nodes for them would put files that were never parsed into the same
table as parsed code, and `is_stub` would stop meaning "third-party".

**Skip the tables and compute everything at report time.** Rejected: coupling is
O(commits × files²-per-commit) and would be recomputed on every report, and M4
needs to query it without re-running the miner.

**Emit history through the NDJSON fact protocol, like an extractor does.** The
symmetry is appealing and it would make history replayable through `ingest
--from`. Rejected for M2 because the protocol's vocabulary is nodes and edges,
and none of these are either; bending them to fit would cost more than the
symmetry is worth. Worth revisiting if a second history source ever appears
(Perforce, a monorepo tool) — two implementations before an interface.

**Write a finding for every coupled pair, including ones with static edges.**
Rejected: on a large repository nearly every pair with a dependency also
co-changes, so the useful findings would be buried under thousands of restatements
of the import graph. The counts are still stored for all of them; only the claim
is withheld.

## Consequences

- `citation.kind = 'commit'` gets its first use, which means the provenance join
  is exercised across all four of its shapes before the model layer at M3 is
  allowed anywhere near it.
- Every history claim can be checked by `git show`. A reader who disagrees with
  a coupling finding has the commits in front of them.
- A `finding` produced by M2 and a `finding` produced by M3's model layer live in
  the same table, distinguished by `authored_by`. That is deliberate: reports
  rank them together, and the column says which is which.
- `file_metric` rows exist for files no extractor has ever seen, so joining
  `file_metric.path` to `source_file.path` is an outer join, always. Any query
  that inner-joins them silently drops every non-Java file in the repository.
