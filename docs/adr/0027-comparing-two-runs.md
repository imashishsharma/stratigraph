# ADR-0027: A finding is recognised across runs by its content, and only regressions gate a build

- Status: accepted
- Date: 2026-08-13
- Milestone: M8

## Context

The fact store has kept every run since M0 and nothing has ever compared two of
them. So the tool could say "this repository has nine high findings" and never
"three of those are new since Friday" — and the second sentence is the one
anybody acts on.

`--fail-on` (M8) has a related problem, and it is the more serious one. It can
only be switched on by a repository that already passes it, which excludes
every codebase this tool was built for: a 100k-LOC monolith nobody remembers
has hundreds of findings on the day it is first analysed. A gate that fails
from the first commit gets deleted from the pipeline in a week. A gate nobody
can turn on is not a gate.

Both need the same thing: the ability to say which findings are *new*.

That is harder than it sounds, because `finding` rows are per-run. Every
`analyze` deletes nothing and writes a fresh set, with fresh ids. There is no
column that says "this is the same problem as that one". Identity has to come
from somewhere.

## Decision

**A finding is recognised across runs by `(rule, title)`, with the cycle title
normalised to its set of packages. Only publishable findings are compared. Only
findings new in the later run can fail a build.**

### Identity

Every rule builds its title deterministically from the entities involved — a
package pair, a file path, a class member — so the same problem in the same
place produces the same string on both runs. `rule` disambiguates two rules that
happen to phrase a title alike.

One rule needs more than that. A cycle's title names the *shortest path* through
a strongly-connected component, and the shortest path can rotate or re-route
when an unrelated edge appears elsewhere in the component:

```
run 4:  Package cycle across 3 packages: a → b → c → a
run 5:  Package cycle across 3 packages: b → c → a → b
```

Same cycle, same three packages, and a naive comparison reports one resolved and
one new. So a `package-cycle` title is normalised to its sorted set of package
names before comparison — a set is what a reader means by "the same cycle".

That normalisation parses a string this project produces itself, which is a
coupling worth naming: if `src/analysis/cycles.ts` changes its wording, the
parse returns null, the diff falls back to comparing whole titles, and the
result gets noisier without ever becoming wrong. A test asserts the pairing, so
the wording and the parse cannot drift silently.

**What this cannot see is a finding whose wording changes while the problem
stays.** Renaming a package changes the title of every finding about it, and
the diff reports the old ones resolved and the new ones added. That is stated
here rather than hidden, because the alternative — matching fuzzily — would
report a genuinely new cycle as an old one under a new name, and a gate that
misses a regression is worse than one that reports a rename.

### Only publishable findings

Same rule as the report and `--fail-on`: a finding with no citation does not
count (ADR-0021). A diff that failed a build on an uncited finding would
regress on a claim no output in this tool will show anyone.

### Both runs must have been analysed

`extract` opens a run and `analyze` fills it. Comparing against a run that has
facts and no findings would report every finding in the other run as a change —
a comparison against nothing, dressed as a clean sweep. `diff` refuses, and its
default run selection skips unanalysed runs entirely rather than picking the
newest and reporting nonsense. This is ADR-0026 one level up.

### `--fail-on-new`, and why it is the gate that gets adopted

`--fail-on-new high` exits 3 when a high finding is *new* since the earlier run,
and says nothing about the ones that were already there. A legacy monolith can
turn it on the day it first runs the tool, which `--fail-on` cannot offer.

Both gates exist because they answer different questions — "is this codebase
acceptable" and "did this change make it worse" — and only the second one can be
asked of a repository on day one.

## Alternatives considered

**A stable id per finding, written at insert time** — hash the rule and its
citations into a `key` column. This is the right answer and it is a schema
change to the fact store after M1, which CLAUDE.md says to ask about rather than
make. It would also survive a rename no better than the title does, since the
citations move too. Worth doing when the schema next opens; the comparison layer
would not change shape. Left open.

**Match on citations instead of titles.** Rejected as worse in both directions:
citations are file-and-line, so a finding survives a rename of its package and
dies on any edit that shifts a line number. Titles at least move with the thing
being described.

**Fuzzy matching — similar titles are the same finding.** Rejected. It trades a
false regression for a missed one, and a gate that quietly does not fire is the
failure mode this project spends most of its output budget avoiding.

**Compare two databases rather than two runs in one.** Rejected as unnecessary:
the CI pattern is analyse the base commit, analyse the head commit, and both
land in the same store as consecutive runs. A second store adds a path argument
and answers nothing new.

**Diff the graph rather than the findings** — every added and removed edge.
Rejected as the headline: a refactor moves thousands of edges and means nothing.
Node counts and the named package, endpoint and table deltas are reported
because those are the ones a reader can act on; edges are a single count.

## Consequences

- `--fail-on-new` makes the tool adoptable in CI on a codebase that would fail
  `--fail-on` on every commit for a year. This is the difference between a
  report someone reads once and a check that runs on every pull request.
- Two analyses of an unchanged repository produce an empty diff. Verified on
  spring-petclinic: 44 findings, 0 new, 0 resolved, 44 unchanged, in 0.13s.
  Any churn there would be a bug in identity, and it is the first thing to
  check when one is suspected.
- A package rename shows up as a wave of resolved and added findings. Expected,
  documented, and the reason `diff` prints resolved and added side by side
  rather than only the regressions.
- The comparison is set arithmetic over rows both runs already hold. Nothing is
  re-derived and no rule re-runs, so a diff cannot disagree with either run's
  own report — the property ADR-0021 gives the ranked list, one level up.
