# ADR-0009: Rename tracking without `--follow`

- Status: accepted
- Date: 2026-07-29
- Milestone: M2 (before the code — it decides the shape of the miner)

## Context

The build plan says to mine `git log --numstat --follow`. That command cannot be
run against a repository:

```
$ git log --follow
fatal: --follow requires exactly one pathspec
```

`--follow` is a single-file tool. It exists so that `git log --follow
src/Foo.java` keeps going past the commit where `Foo.java` was called something
else, and it works by re-running rename detection at each commit for that one
path. Mining a repository with it means one `git log` process per file — tens of
thousands of processes on a repository the size of dubbo — and it is lossy
besides: `--follow` stops at the first rename it cannot attribute unambiguously,
and git's own documentation describes the option as a hack.

Rename tracking still has to happen. In codebases old enough to be worth
analysing, packages get moved wholesale. A file that was renamed three years ago
looks, without it, like two unrelated files each with half a history — and half a
history is the wrong churn, the wrong author set, and coupling that silently
splits in two.

## Decision

**One whole-repository `git log` pass with rename detection on, and resolve the
rename chains ourselves.**

```
git -C <repo> log --no-show-signature -M --numstat -z \
    --pretty=format:'%x01%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s'
```

`git log` walks newest to oldest. A rename `old → new` observed at commit C means
that every occurrence of `old` in a commit older than C is the same file as
`new`. So a single backwards pass suffices: keep a map from a superseded path to
its current name, and when a rename arrives, record `old → canonical(new)` —
resolving the target through the map first, so that `a → b` followed later by
`b → c` leaves `a → c` rather than a chain to walk at read time.

`commit_file` stores both: `path` as the commit spelled it, and `canonical_path`
after resolution. Every metric groups by `canonical_path`; anything that wants to
show what actually happened in a given commit reads `path`.

### `-z` is not optional

Without it, git renders a rename inside the numstat path field:

```
1	0	src/{alpha.txt => gamma.txt}
0	0	old/path.java => new/path.java
```

That has to be un-braced by hand, it is ambiguous for any path that legitimately
contains ` => `, and git separately C-quotes any path with a space, a tab or a
non-ASCII byte in it. With `-z`, the counts are followed by an **empty** path
field and then the old and new paths as two further NUL-separated fields, and no
path is ever quoted. `fixtures/git-log/` captures both shapes from a real git so
the parser is written against what git emits rather than against a memory of it.

## Alternatives considered

**One `git log --follow` per file.** Rejected: it is O(files) processes, it is
what the plan literally said, and it cannot see a rename in a file that no longer
exists at HEAD, so it cannot even be run for the whole set.

**`--find-renames` with a lowered similarity threshold, or `-C` for copy
detection.** Rejected for M2. `-C` in particular is expensive enough to dominate
the run on a large repository, and copies are a much weaker signal than renames —
a copied file genuinely does start a new history.

**No rename tracking at all.** Rejected. It is simpler and it is honest — every
path is its own file — but it quietly halves the history of exactly the files
most worth looking at, and produces two hotspots where there is one.

**`git log --name-status` instead of `--numstat`.** It reports renames as
`R096\told\tnew`, with the similarity score, which is nicer to read. Rejected
because it does not carry insertion and deletion counts, and churn needs them.
Running both means two passes over the log.

## Consequences

- **A path deleted and later reused for a different file merges into one
  history.** Git reports no rename in that case (the content is unrelated), so
  the alias map is not involved — the two lives simply share a path string, and
  anything keyed by path merges them. This over-reports one file's history; it
  cannot invent an edge in the static graph, which is the property that matters.
  `fixtures/git-log/` contains this case explicitly, and the test asserts the
  merge, so the limitation is pinned rather than discovered later.
- Rename detection is git's, at its default 50% similarity. A rewrite-and-move in
  one commit reads as a delete plus an add. This is a threshold we have chosen not
  to argue with: git's answer is at least reproducible and explicable.
- Everything is one subprocess and one streaming pass, so the miner's cost is
  linear in the size of the log rather than in the number of files.
- The parser owns a format that is git's, not ours. That is a real maintenance
  cost, paid down by the captured fixture: when git changes, one file changes and
  the tests say so.
