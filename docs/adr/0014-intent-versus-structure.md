# ADR-0014: The algorithm owns the mismatch; the model owns only the sentence

- Status: accepted
- Date: 2026-07-29
- Milestone: M3 (before the code)

## Context

PLAN.md puts intent-vs-structure mismatch in the LLM layer: "a package whose
name implies one responsibility while its edges imply another". Read literally
that is a model deciding what a name implies, deciding what edges imply, and
then deciding the two disagree — three inferences stacked, with the finding
resting on all of them.

That is the shape CLAUDE.md forbids. A mismatch stated that way cannot be
falsified: challenge it and the answer is "the model thought `report` sounded
like billing", which is not evidence about the codebase. It is also the
finding most likely to be *interesting*, which makes it the one most worth
being able to check.

There is a version of the same claim that needs no model at all. A package name
is not free text — it is a path, and the packages sharing its parent path are
its declared neighbourhood. "Named alongside these four, clustered with those
seven instead" is arithmetic over the partition, and the edges that pulled it
across are `edge` rows with file and line.

## Decision

**`intent-mismatch` is an `authored_by = 'algorithm'` finding. The model may
later describe what the two responsibilities appear to be; it never decides
that a mismatch exists.**

The rule, in full:

1. Take package `P` with parent path `pp` — everything before its last dot. `P`
   must have a dot: a top-level package has no declared neighbourhood, and
   treating every other top-level package as its sibling would make the rule
   fire on every repository.
2. Its **name group** is every other package whose parent path is also `pp`.
   The group must have at least **two** members. With one, the finding would be
   about a pair rather than about a group, and a pair disagreeing is as likely
   to mean the pair is wrong as that `P` is.
3. If a **strict majority** of the name group sits in one cluster, and `P` is
   not in it, that is a mismatch. Plurality is not enough — a name group split
   three ways has no home for `P` to have left.
4. Evidence is attached, and it is what makes the finding checkable:
   - `edge` citations for the source-level edges connecting `P` to the members
     of the cluster it actually landed in — the imports, calls, inheritance and
     injection that pulled it across;
   - `commit` citations for the co-change that pulled it across, when the pull
     was temporal rather than structural.

Severity is `high` when the name group is unanimous, `medium` otherwise. A
unanimous group is the strongest form of the claim: every single package named
alongside `P` went somewhere `P` did not.

### Naming where it landed

The finding says where the package went, and it does **not** use the cluster's
own label to say it. A cluster of `shop.admin.{user,role,audit}` plus a stray
`shop.billing.report` has the common prefix `shop`, because the stray drags it
up — so the label is least informative exactly when the finding is most
interesting. The finding names the common prefix of the cluster's *other*
members instead, recovering `shop.admin`.

Four cases, because collapsing them produced three separate nonsenses on the
first real runs:

| Where it went | How the finding says it |
| --- | --- |
| Alone in its cluster | "groups with nothing" |
| With the package its own name sits under | "groups with `P` itself rather than with the packages named alongside it" |
| With a group sharing no prefix | "groups with N packages that share no common prefix" |
| With a group sharing a prefix | "groups with `X`" |

The third is the one that matters. `sharedPrefix` returns **null** rather than
falling back to a member's name, because on dubbo the fallback rendered as
"groups with com.alibaba.dubbo.config.spring.context.annotation" — a string that
was simply the alphabetically first member of a 129-package cluster, standing in
for a group it does not describe. A title that invents a coherent destination is
the same failure as inventing an edge.

### The case with no evidence to cite

A package can be a mismatch with no edges at all: its siblings cluster together
and it sits alone, connected to nothing. The finding is still written, and its
detail says exactly that — *no dependency or co-change connects it to anything*.

That is an absence we established rather than one we assumed, and the difference
matters: this rule only runs when a static graph exists, so "no edge" means the
extractor looked and found none, not that nobody looked. The same distinction
`analyze` already draws for coupling pairs (`staticGraph` in
`history-findings.ts`) applies here, for the same reason.

## Alternatives considered

**Let the model find the mismatches, and validate its citations.** Rejected.
The citation check in ADR-0013 verifies that a sentence points at real evidence;
it cannot verify that the evidence *supports* the sentence. A model could cite
seven genuine imports and draw the wrong conclusion from them, and the output
would pass every check. Keeping the claim algorithmic means the citation check
only ever has to guard prose about a claim that is already true.

**Compare a package's name against its contents rather than its neighbours** —
e.g. flag `com.foo.util` containing `InvoiceValidator`. Rejected: it needs a
model to decide that `InvoiceValidator` is not a utility, which is the
inference this ADR exists to avoid. It is a reasonable *model-authored* finding
later, clearly marked as inference, but it is not this rule.

**Use word-level similarity between the package name and its cluster's label.**
Rejected: it looks objective and is not. `billing` and `invoicing` are the same
responsibility under different words, `report` and `reporting` may be different
responsibilities under nearly the same one, and any threshold over a string
distance would be a number with no defence.

**Fire on plurality rather than strict majority.** Rejected as the more
frequent-firing and less defensible rule: on a name group split 2-2-1 the
"home" cluster is an artefact of the tie-break, and a reader who opens the
finding sees no majority to have left.

## Consequences

- The finding runs entirely under `--no-llm`, and is the sharpest thing the
  structural report produces. That is deliberate: M3's first acceptance
  criterion is that the report is worth reading without a model.
- It only fires where package naming is hierarchical enough to have a
  neighbourhood — normal for Java, and something the Angular extractor at M5
  will have to be checked against rather than assumed into.
- `couplingWeight` changes which mismatches exist, since it changes the
  partition. The report names the value in use, so a reader can see which knob
  produced the finding and move it.
- When the model later describes the two responsibilities, its sentences hang
  off a finding that was already true. If the model's prose is rejected by the
  citation check, the mismatch itself survives with its evidence intact.
- The evidence query resolves every node to its package **once**, into an
  indexed temp table, rather than per candidate-and-neighbour pair. The natural
  implementation reuses `supportingEdges`, which re-runs the recursive
  containment walk over the whole graph on every call; on dubbo's 130-package
  cluster that is thousands of full-graph walks and `analyze` never finishes.
  This is the one place in the layer where the obvious code is unusable at
  scale, so it is written down rather than left to be rediscovered.
