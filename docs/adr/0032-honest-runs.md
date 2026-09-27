# ADR-0032: A run records what each extractor did, and only a completed run is "the latest"

- Status: accepted
- Date: 2026-09-28
- Milestone: M10 (before the code)

## Context

Two ways a v1 run misdescribed itself, both seen on a real repository.

**A skipped extractor left no trace.** `extract` resolves each selected
extractor's toolchain first. ADR-0004 says a missing JDK disables the Java
extractor and nothing else, so on a full-stack repository with no JDK the
Angular half ran, the run was marked `ok`, and the only record that the Java
half was never read was one line on stderr. Every later reader — `analyze`,
`report`, the MCP server — saw a run with TypeScript facts and no Java facts,
which is exactly what a repository with no Java in it looks like. And on a
repository that is *only* Java, the same missing JDK threw before any run
existed, so there was nothing for `report` to explain the absence in: the
honest report could not be built at all.

**`latestRun` returned a failed run.** It was `ORDER BY id DESC LIMIT 1`. An
extractor that crashed halfway leaves a run marked `failed` holding a
well-formed prefix of the facts, and every command that defaults to "the latest
run" then reported that prefix as the repository. A process killed outright
leaves `running`, which is the same thing with less said about it.

## Decision

**1. Every extractor a run selected gets an `extractor_run` row** — `ok`,
`skipped` (reason: the toolchain error, verbatim) or `failed` (reason: the exit
status, or the ingest error). One row per `(run, language)`. The table goes into
migration 0002, which is unreleased.

**2. A run whose every extractor was skipped is still recorded, and finishes
`ok`.** `extract` exits 0 with a loud warning. The run is a true description of
what this machine could read; the report built from it says which extractor did
not run and why, and withholds the views that need its facts (ADR-0033). A
pipeline written as `extract && history && report` produces that report instead
of stopping at the first command. `--emit` keeps the old behaviour: it has no
store to record a gap in, and an empty stream would read as an empty repository.

**3. `latestRun` means the latest run with status `ok`.** A failed or
never-finished run is reachable only by naming it with `--run`. When there is no
completed run, the error says which run exists, how it ended, and the `--run`
that reads it anyway — the person who just watched `extract` fail should not be
told to run `extract`.

**4. `run.status` keeps its three values.** "Partial" is not a fourth status; it
is derived from `extractor_run` (a run with any `skipped` row). SQLite cannot
alter a `CHECK` constraint without rebuilding the table, and the derived form
cannot disagree with the rows it is derived from.

## Alternatives considered

**A `partial` run status.** Rejected for the rebuild above, and because a
status is one bit where the reader needs the list: *which* extractor, and why.

**Keep throwing when nothing can run.** Rejected (and chosen against in the
milestone plan): it makes the most important honest report — "we could not read
your Java" — the one report that cannot be produced.

**Exit non-zero when anything was skipped.** Considered for CI. Rejected as the
default because the run is valid and the downstream commands work on it;
`extract --format json` already carries `skipped`, which is the machine-readable
signal a CI job should test.

**Let `latestRun` return failed runs but label them.** Rejected: every consumer
would have to remember to check the label, and the one that forgets reports a
fragment as a whole. Refusing by default and allowing by name puts the decision
with the person who knows the run is incomplete.

## Consequences

- `describe_run`, the report Summary and every coverage statement can now name
  the skipped extractor and its reason (ADR-0033 builds on this table).
- A store whose only runs failed now makes `report`, `analyze` and `mcp` refuse
  with a message naming the run, where before they silently used it.
- `history` attaches to the latest *completed* run; after a failed extract it
  opens a history-only run rather than attaching commits to a fragment.
- Test fixtures that open a run must finish it, which is what real commands
  always did.
