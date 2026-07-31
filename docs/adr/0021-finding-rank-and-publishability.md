# ADR-0021: Finding rank is arithmetic, and an uncited finding is not published

- Status: accepted
- Date: 2026-07-31
- Milestone: M6 (after the code)

## Context

M6 asks for "a ranked findings list with severity and evidence". Until now
`analyze` printed findings grouped by rule — every cycle together, every hotspot
together — which is the right shape for someone reading the output of a
particular analysis and the wrong shape for someone asking "what is worst about
this codebase?"

Ranking across rules needs a comparable order between things that are not
obviously comparable. Is a three-package cycle worse than a file only one person
has ever touched? The `finding` table has carried a `severity` column since M0
and every rule sets it, but severity alone leaves large ties: on a real
repository, dozens of findings are `medium`, and something has to decide what
comes second.

There is also an older promise to keep. The schema comment on `citation`, from
M0, says:

> The provenance join. A finding with no citations is not publishable; the
> report layer enforces that, and the LLM layer rejects uncited model output.

The LLM half was built in M3 (ADR-0013). The report layer did not exist until
now, so the first half has been an unenforced comment for five milestones.

## Decision

**The rank key is arithmetic over stored columns, it is total, and a finding
carrying no citation is excluded from every published output and counted.**

### The key

In order, each breaking the ties the last one left:

1. **Severity**, descending: `high` 3, `medium` 2, `low` 1, `info` 0.
2. **Author**, `algorithm` before `model`. A cycle is a statement about the
   graph; an ADR candidate is a proposal about what to do. They must not
   interleave, and when they tie the observation goes first.
3. **Citation count**, descending. Not a quality measure — a proxy for how much
   of the codebase a finding touches. A cycle with eleven supporting edges is a
   bigger fact about the repository than one with two.
4. **Rule name**, ascending.
5. **Finding id**, ascending.

The last two exist only to make the order total. Without them two findings
identical on the first three fields would come back in whatever order SQLite
felt like, and the report would not be reproducible — which would forfeit the
byte-identical property ADR-0020 depends on.

Nothing here is weighted, scored or normalised into a single number. A composite
score would be more expressive and would also be a judgement invented in the
report layer, unfalsifiable and impossible to argue with. A reader who disagrees
with this order can see every input to it in the table.

### Publishability, enforced

`rankFindings` excludes any finding with zero citations from the list, from the
per-rule counts and from the per-severity counts, and returns the number
excluded. Every output prints it when it is not zero.

In practice it excludes nothing, because every rule writes citations alongside
its finding in the same transaction. That is the point. The check is a
regression test on the invariant, not a filter anyone expects to fire, and the
day it does fire the report says so instead of quietly showing a claim nobody
can check.

Excluding is not deleting. The row stays in the database, `analyze` still
reports it through its own path, and the count on the report says how many were
held back — so the enforcement is visible rather than a disappearance.

## Alternatives considered

**A weighted composite score.** Rejected. `severity * 3 + log(citations) * 2`
sorts beautifully and cannot be defended: the constants would be invented here,
and a reader asking why one finding outranks another would get an equation
rather than a reason.

**Rank by rule, in a fixed order of rule importance** — cycles first, then
mismatches, then history. Rejected, though it is what `analyze` effectively
does. It hard-codes that any cycle matters more than any hotspot, which is false
often enough to mislead: a two-package cycle in dead code is worth less than the
file that has taken 400 commits from one person.

**Let the model rank them.** Rejected, and it is the one that would produce the
most persuasive-looking list. Ordering is a judgement about importance, a model
would make a plausible one, and the result would be an unfalsifiable ordering
presented above findings that are individually checkable. The layering exists so
that the structural half of this report survives `--no-llm` intact, and a
model-ordered list would not.

**Drop uncited findings silently.** Rejected. It reads identically to having
found nothing, which is the distinction this project spends most of its output
budget preserving.

**Refuse to write an uncited finding at all, at insert time.** Tempting, and
better in principle — a `CHECK` constraint cannot be forgotten. It cannot be
expressed in SQLite, because the citations are inserted after the finding they
reference. A trigger at end of transaction could, and is a schema change, which
CLAUDE.md says to ask about rather than make. Left open.

## Consequences

- The ranked list is reproducible: same run, same order, every time, on every
  machine. `findings.md` checked into a repository produces an empty diff until
  the facts change.
- Severity is now load-bearing across rules, not only within one. If a rule sets
  severity carelessly, it now outranks other rules' findings rather than only
  sorting oddly among its own. Each rule's severity choice is a decision that
  deserves the same scrutiny as its detection logic.
- `analyze`'s grouped output and the report's ranked output are two views of one
  table and cannot disagree. Neither re-derives anything.
- The publishability check is nearly always a no-op, and costs one `COUNT` in a
  query the report already runs. That is the right price for turning a comment
  into an assertion.
