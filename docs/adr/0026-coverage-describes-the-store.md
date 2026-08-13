# ADR-0026: Coverage describes what the store holds, not which commands were run

- Status: accepted
- Date: 2026-08-13
- Milestone: M8 (a bug, and what it exposed)

## Context

`extract` opens a new run. `report` renders the latest one. Nothing joins those
two sentences, so this sequence is always one forgotten command away:

```sh
stratigraph extract --repo ../monolith    # opens run 3
stratigraph report  --repo ../monolith --out ./arch
```

Run 3 has facts and no analysis. The report rendered it without complaint:

```
run 3: 1 container(s), 6 class diagram(s), 17 endpoint(s), 0 publishable finding(s)
```

and both the HTML and `findings.md` said, of a run against which no rule had
ever been evaluated:

> No findings for this run. That means every rule that ran found nothing — not
> that nothing was looked at.

That sentence was false, and false in the one direction this project exists to
prevent. Every other absence in the tool is careful — a refused wildcard import
names the shadowing declaration, an empty coupling section says how many commits
were considered, a C4 diagram with no actor says why there is no actor — and
the ranked findings list, the part a reader treats as the verdict, was quietly
reporting an unexamined repository as a clean one.

`describeRun` already computed a `Coverage` record and a `gaps` list, and the
HTML already rendered the gaps in its limits tab. Two things had gone wrong
anyway. The gap for this case keyed off `counts.clusters === 0` and said "no
clustering has been run", which is a true statement about clustering and not the
statement a reader needs. And `findings.md` — the file that gets pasted into an
issue with none of the report around it — received neither the coverage record
nor the gaps.

## Decision

**Coverage states what the store holds. It never states which commands were
run, and no output infers one from the other.**

`Coverage.analysis` is true when the run holds any output that only `analyze`
writes: a cluster, a finding, or a coupled pair.

```ts
analysis:
  counts.clusters > 0 ||
  count(db, 'SELECT COUNT(*) AS n FROM finding WHERE run_id = ?', runId) > 0 ||
  count(db, 'SELECT COUNT(*) AS n FROM temporal_coupling WHERE run_id = ?', runId) > 0,
```

This is deliberately not a claim that `analyze` did or did not run. It cannot
be: nothing in the schema records which commands touched a run. What it can say,
and what every consumer says, is that no analysis output is stored — and the
remedy for that is the same command either way. So the wording never asserts
history:

> **No rule has been evaluated against this run.** No analysis output is stored
> for run 3 — no cluster, no finding, no coupled pair — so this is an absence of
> analysis, not a clean result. Run `stratigraph analyze` and generate the
> report again.

A run that `analyze` genuinely left with nothing to say is reported identically.
That is a cost, and it is the correct one: the two cases are indistinguishable
in the store, and the honest output for two indistinguishable states is one
message, not a guess about which is which.

Four consumers, one signal:

1. `findings.md` prints the wording above instead of the clean-result wording,
   **and carries its own limits section**. It is the artefact that leaves the
   machine; a list of findings mined from a run with no history is a different
   claim from the same list mined from a full one, and the reader holding only
   this file cannot otherwise tell.
2. The HTML findings panel prints it, with the limits tab unchanged.
3. `report` warns on stderr, so the person who ran it learns without opening
   anything. It stays a warning: the diagrams, the HTTP surface and the data
   model are all real and worth having.
4. `describe_run` over MCP reports the gap, so an agent reading the store does
   not take the empty findings list for a clean bill either — the same failure,
   one layer down, and the reason ADR-0015 exists.

## Alternatives considered

**Record the stages on the run row** — an `analyzed_at` column, or a `stage`
table. This is the honest signal rather than a proxy for it, and would let the
tool distinguish "analyze ran and found nothing" from "analyze never ran". It is
a schema change to the fact store after M1, which CLAUDE.md says to ask about
rather than make. Worth doing; deliberately not done here, because the wording
above is accurate without it and would not change if it were added. Left open.

**Make `report` refuse an unanalysed run.** Rejected. A run with facts and no
analysis still yields correct C4 diagrams, a correct ER model and a correct HTTP
surface, all of which someone may legitimately want. Refusing to write them
because a different section would be empty trades a false claim for a missing
capability.

**Have `report` run the analysis itself.** Rejected on layering: presenters do
not reach backwards (CLAUDE.md), and ADR-0019 turns on the report being a
projection of stored rows and nothing else. It also repeats the mistake ADR-0015
names for MCP — a command that quietly rebuilds is a command whose output nobody
can date.

**Infer it from `counts.clusters` alone**, which is what the old gap did.
Rejected as too narrow in one direction and too broad in the other: a run
analysed with `minClusterSize` above its largest community stores findings and
no clusters, and would have been reported as unanalysed.

**Say nothing and rely on the limits tab**, which already carried a gap. This is
what shipped, and it failed for the reason limits sections generally fail: the
false sentence was next to the findings, on the tab a reader opens first, and
the true one was three tabs away. A correction is only worth as much as its
adjacency to the claim it corrects.

## Consequences

- Two kinds of empty findings list are now distinguishable in every output,
  which is the same distinction ADR-0021 draws for an uncited finding and
  ADR-0015 draws for an empty MCP answer. This one closes the gap between them.
- `findings.md` carries a `## Limits of this run` section whenever the run has
  gaps. It grows the file and makes it self-describing; a findings file checked
  into a repository now diffs when the coverage of the run behind it changes,
  which is information, not noise.
- `MarkdownContext` gained a required field. Any future caller has to decide
  what it is passing, which is the point — an optional field defaulting to
  "analysis ran" would restore the bug for the next caller.
- The proxy will misreport exactly one case: a run where `analyze` ran and
  produced no cluster, no finding and no coupled pair at all. It advises running
  `analyze`, which is harmless and idempotent. Closing that case needs the
  schema change above.
