# ADR-0011: Which commits count

- Status: accepted
- Date: 2026-07-29
- Milestone: M2 (before the code)

## Context

Temporal coupling is a ratio of commit counts, and it is trivially easy to make
that ratio produce confident nonsense. Four things do it:

1. **A merge commit re-attributes changes that were already attributed.**
2. **One sweeping commit couples everything it touches.** A license-header
   change across 4,000 files contributes 8 million co-change pairs — more than
   a decade of ordinary development on most repositories. A handful of these
   can dominate the entire result, and they are evidence of a script running,
   not of two files being related.
3. **Small denominators make strong-looking ratios.** Two files each changed
   twice, once together, score 0.5 — the same as two files changed 200 times
   each, 100 of them together. One is noise; the other is the finding of the
   report.
4. **Files change together because both files change a lot.** Two files touched
   in 30% of all commits will share about 9% of commits by coincidence alone.
   Reporting that as coupling is reporting the base rate.

None of these is subtle, and all of them are invisible in the output: the
resulting table looks exactly like a correct one. That is the failure mode
CLAUDE.md is written against — a confidently wrong map is worse than no map — so
the rules that prevent it belong in a document, not in constants nobody revisits.

## Decision

### Merge commits are recorded and excluded

`git_commit.is_merge` is set from the parent count. Merges are excluded from
churn, from author counts and from coupling.

In practice `git log --numstat` already emits no diff at all for a merge, so
excluding them changes nothing today — the probe in `fixtures/git-log/` shows a
merge with an empty file list. The exclusion is explicit anyway, because the
moment anyone adds `-m`, `--first-parent` or `--diff-merges` to that command
line for some other reason, merges start carrying their children's changes and
every count silently doubles. The rows are still stored so that "why does the
commit count not match `git rev-list --count`?" has an answer in the database.

### Commits touching more than `maxFilesPerCommit` files are excluded from coupling

Default **50**, configurable via `history.maxFilesPerCommit`.

They still count towards churn, authorship and hotspots: a file really was
changed, and pretending otherwise would understate its history. It is only the
*pairing* that is dropped, because a mechanical sweep is evidence about the
script, not about the files.

Fifty is a judgement, and it is the judgement most likely to need revisiting. It
sits above what a hand-authored feature commit usually reaches and well below
what a generated change reaches. It is reported: the run logs how many commits
the cap excluded, so a repository whose normal commits are larger than 50 files
announces itself rather than quietly losing most of its history.

### Only files present at HEAD

Taken from `git ls-files`. A deleted file has no content to measure complexity
from, and coupling between two files that no longer exist cannot be acted on.
Their history still contributes to the files they were **renamed** into, via
ADR-0009's alias chain — this rule drops deletions, not renames.

### `include` / `exclude` from config apply

So history covers the same scope as extraction, and the two halves of a report
describe the same set of files.

### Coupling must beat chance, and must clear a floor

- **Stored strength** is `shared / min(commits_a, commits_b)` — the schema
  specifies that formula, and it is the standard degree-of-coupling measure.
  Ranking uses it.
- **Lift** is `shared / (commits_a × commits_b / totalCommits)`: observed
  co-changes over the number expected if the two files changed independently.
  Any pair with **lift ≤ 1** is discarded. PLAN.md asks for pairs that change
  together "far more often than chance"; this is that phrase written as a
  filter rather than left as a hope. Lift is printed alongside strength but not
  stored — the schema has no column, and it is cheap to recompute.
- **`minShared` 5** and **`minCommits` 5**, both configurable. Below these,
  strength is an artefact of the denominator.

**Single-file commits stay in the denominator.** They produce no pair, but they
are commits that touched one file and did *not* touch the other, which is
exactly what lift needs to know. Counting only multi-file commits would inflate
every file's base rate — a file changed in 100 of 1,000 commits would look like
one changed in 100 of 200 — and lift would then reject genuine coupling as
coincidence. This is not a hypothetical: it rejected the whole test suite before
the denominator was fixed.

### What is deliberately not filtered

**Bot and CI authors.** Recognising them means pattern-matching on names, which
is a guess about a person, and a wrong guess deletes real history. They are
reported as authors like anyone else. A user who wants them gone can exclude the
paths they touch.

**Very large repositories are scoped, not sampled.** `history.since` and
`--since` limit the window; nothing is sampled or truncated silently. A partial
window is stated in the run log.

## Alternatives considered

**Weight each commit by `1 / files-touched` instead of capping.** Elegant — a
sweeping commit contributes proportionally little rather than nothing, and there
is no threshold to defend. Rejected for M2 because it makes `strength` no longer
the ratio the schema documents, and because a weighted score cannot be checked
by hand: "these two files changed together in 38 commits, here they are" is
verifiable, and "these two files have a weighted affinity of 0.31" is not. Worth
revisiting once the plain version has been used in anger.

**Use Jaccard (`shared / union`) instead of `shared / min`.** Rejected: it
penalises the common and useful case of a small file that changes only ever
alongside a big one — a config file for a service, say — which is exactly the
kind of hidden coupling the report is for.

**Apply a significance test (chi-squared, or a binomial p-value) rather than a
lift cutoff.** Rejected for M2 as unnecessary machinery: with `minShared` at 5
and lift required to exceed 1, the surviving pairs are already well clear of
chance, and a p-value would have to be corrected for the millions of pairs
tested before it meant anything.

**Drop merge commits from the log entirely with `--no-merges`.** Rejected:
`git_commit` would then disagree with `git rev-list --count HEAD` and nothing in
the database would explain why.

## Consequences

- Every threshold is a named, configurable constant with a recorded reason, so
  changing one is a decision rather than a tweak.
- The run reports what each rule removed — commits excluded by the cap, pairs
  below the floors, pairs failing lift. Silent filtering would make an
  under-reported repository look like a clean one.
- A repository whose commits are habitually huge (a monorepo with generated
  code, say) gets little coupling output. That is the correct answer for the
  default settings, and the log says so rather than returning an empty table
  with no explanation.
- The five explanations M2's acceptance criterion asks for are made possible by
  these rules, not despite them: without the cap, the top of the list is
  whatever file the last big sweep touched.
