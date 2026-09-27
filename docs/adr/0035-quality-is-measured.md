# ADR-0035: Quality is measured against labelled ground truth, not asserted

- Status: accepted
- Date: 2026-09-28
- Milestone: M11 (before the code)

## Context

Every milestone through v1.6.1 was accepted on a one-off run against one
repository, checked by hand at the lines it cited. Each run proved the facts it
looked at were true. None could show that the aggregates were right, and on a
real enterprise repository they were not: lockfiles ranked riskiest, entities
missing from the ER diagram, aggregator poms drawn as containers. Five
hand-written fixtures totalling 45 files were the only regression net.

## Decision

**`stratigraph bench` runs the full pipeline over a pinned public corpus and
scores it against ground truth labelled without stratigraph.**

- `bench/corpus.yaml` pins each repository to a full commit sha. Clones live in
  a cache the tool owns and are created only with `--fetch`, the one network
  step outside the model call; extraction and mining stay offline.
- `bench/truth/<name>.yaml` holds hand labels: a sample of file roles, the
  deployables, JPA entities and their physical tables, tables, endpoints, a
  sample of injection edges, and a senior engineer's riskiest files. Labels come
  from reading the repository — its source, build files, migrations and
  `git log` — never from stratigraph's output, or the benchmark measures
  agreement with itself. A truth file records how it was labelled, and is
  refused when it was labelled at a different commit from the pin.
- Each run writes `scorecard.json` and `scorecard.md`: per-repository counts
  with everything missed listed by name, and pooled (micro-averaged) values
  against the product plan's targets.
- The non-source check in the hotspot top 20 uses a name test independent of
  `src/files/roles.ts`, because the ranking is already filtered by that
  classifier and checking it with the same rules would pass by construction.
- `--private <repo>` scores a local repository with no truth and prints only
  aggregates, never a path, a name or a fqn.
- A nightly workflow runs it; per-PR CI does not, because it clones.

## Alternatives considered

**Snapshot tests of our own output.** Rejected: a snapshot says the output did
not change, not that it is right, and the v1 junk would have snapshotted
cleanly.

**Derive truth mechanically (grep for `@Entity`, count `@GetMapping`).** Used
as a labelling aid, never as the label: a grep has the same blind spots as a
source-only parser (inherited mappings, default naming, Lombok), and the point
is to catch those.

**Score only the three repositories the plan named first.** The plan's phase
exit is the whole corpus; three repositories were the minimum to start, not
the bar.

## Consequences

- The README may cite only numbers a scorecard reproduces.
- Labelling costs hours per repository; that cost is the moat.
- Truth labels can be wrong. A miss in the scorecard is checked at the pinned
  commit before code changes; a label corrected this way is a commit to the
  truth file with the evidence in the message.
