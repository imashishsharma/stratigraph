# ADR-0031: Hotspots rank recent change in source, by percentile

- Status: accepted; supersedes the hotspot parts of ADR-0010 and ADR-0011
- Date: 2026-09-27
- Milestone: M9 (before the code)

## Context

The v1 score was `churn × complexity`, where churn was lines inserted plus
deleted over the whole history and complexity was total indentation. Both
terms grow with the size of the file, so the score grows roughly with its
square. On a real repository that put a 1–2 MB lockfile at around 10¹⁰ against
10⁷ for the largest Java class — no hand-written file could compete.

Four separate problems, each enough on its own:

1. **Non-source files were ranked** (fixed by ADR-0030).
2. **Lines, not commits.** One reformat or one dependency bump rewrites
   thousands of lines and counts as thousands of units of "change". Tornhill's
   hotspot uses change *frequency*; lines measure the size of a diff, not how
   often people had to go back to a file.
3. **All of history, equally.** A file that was volatile in 2016 and has not
   been touched since is not where today's risk is.
4. **Raw product of unbounded terms.** Whichever term has the heavier tail
   decides the ranking, and in real repositories that is size.

## Decision

- **Candidates:** files whose `file_role` is `source`. Nothing else is ranked.
- **Change:** `recent_commits` — distinct non-merge commits touching the file in
  the window, excluding commits that touch more than `history.maxFilesPerCommit`
  files and any revision listed in `.git-blame-ignore-revs`. A sweep is evidence
  about a script, for hotspots exactly as ADR-0011 already said for coupling.
- **Window:** `history.hotspotMonths`, default **12**, measured back from the
  newest non-merge commit — not from the wall clock, so the same repository at
  the same commit always ranks the same way.
- **Complexity:** indentation depth normalised by the file's own indent unit
  (the most common positive step between consecutive indents: 2, 4, a tab).
  The v1 proxy floored every file by four spaces, which halved every 2-space
  TypeScript, HTML and SCSS file relative to Java. Still a proxy, and still
  labelled one.
- **Complexity is compared within a file type.** Indentation is a different
  unit in each language: markup nests on every element, Java on every branch.
  With one pool, Angular templates took 14 of the top 20 on
  jhipster-sample-app. The complexity percentile is therefore taken among
  ranked files with the same extension; a type with fewer than 10 ranked files
  is ranked against every ranked file instead, so a lone file is not top of
  its type by being alone in it. Recent change is compared across all types —
  a commit is the same unit everywhere.
- **Score:** `percentile(recent_commits) × percentile(complexity)`. Bounded, and neither term can win on
  tail length alone. Ties break on recent commits, then path.
- **Bus factor:** source files only, among files changed in the window, sorted
  by recent commits. A single author makes it `medium`, not `high`: one person
  owning one file is a fact about the file, and whether that is a risk depends
  on the file mattering, which this rule cannot see. M10's coverage and importance
  work can raise it once importance is measurable.

`churn` stays in `file_metric` and in the finding's evidence — it is still true
and still useful context — it just no longer decides rank.

- **An empty ranking explains itself.** The window, its commit count and what
  was excluded are stored per run (`history_window`). When nothing ranks, every
  view says why — on jhipster-sample-app every commit in the last year is a
  generator sweep of 81–377 files, and "no hotspots" without that sentence would
  read as "nothing here is risky".

## Consequences

- Hotspot and bus-factor findings change on every repository with this release.
  That is a schema change and a behaviour change, and ships in 2.0.0.
- A repository with no commits in the window has no hotspots, and says so,
  rather than ranking ancient history.
- The finding text states the window, the exclusions and that indentation is a
  proxy, so the evidence describes exactly how the rank was produced.

## Amendment (M11 scorecard, 2026-09-28)

The score is now `recentPercentile × (0.5 + 0.5 × complexityPercentile)`.
Measured on the 15 benchmark repositories with labelled risky files (138
labels), top-10 overlap was:

| score | overlap |
|---|---|
| recent × complexity (as first decided) | 57% |
| recent × (0.5 + 0.5 × complexity) | 63% |
| recent² × complexity | 62% |
| recent only | 78% |

Recent change alone agrees best, but the labels were defined by commit counts,
so part of that agreement is with the labelling method; and a hotspot is where
change meets complexity (product plan §5). The chosen form keeps complexity as
a factor that orders files changed about as often, while no longer letting it
sink a file that changes more than almost any other.
