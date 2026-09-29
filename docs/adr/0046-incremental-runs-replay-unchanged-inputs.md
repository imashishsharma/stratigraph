# ADR-0046: Incremental runs replay what an unchanged input produced, and say what changed

- Status: accepted
- Date: 2026-09-29
- Milestone: Phase C ("incremental re-runs, so the MCP server stays current")
- Amends: [ADR-0015](0015-the-mcp-query-surface.md) (one pinned run)

## Context

The product plan asks for re-runs that finish in seconds on a large repository,
so the MCP server can keep up with code as it changes. On nacos (5,600 files,
400k facts, 6,300 commits) a full `extract && history && analyze` took about
78 s: Java parsing 33 s, the rest of extraction 3 s, `git log` 5 s of a 7 s
`history`, and `analyze` 34 s.

Most of that time is spent re-deriving facts from inputs that did not change.
But the Java extractor parses the whole program in one pass with shared state
(declared type names, constants, meta-annotations, persistence, bean wiring;
ADR-0006, ADR-0039, ADR-0043), so the facts of one file can depend on any
other. Re-parsing only the changed files and keeping the rest would produce a
graph no fresh run would produce. That is a fact the tool invented, which
CLAUDE.md forbids.

And the MCP server (ADR-0015) pinned one run for its whole life, with no way to
say that the code on disk had moved on.

## Decision

**Reuse happens only at a granularity where it is exact by construction.**

1. **Extractors.** Each extractor's NDJSON stream is kept, gzipped, beside the
   store (`<store>.facts/<language>.ndjson.gz`). It is keyed by a SHA-256 over
   the extractor's identity and its inputs:
   - Identity: jar bytes, JVM and version, JVM options and resolved classpath
     for Java; for the Node extractors, the compiled tree, Node version, and
     the `typescript` and `@angular/compiler` versions; the arguments either
     way.
   - Inputs: the content of every file the extractor could read. That means
     every file whose extension that extractor might open, tracked or not,
     walked the way the extractors walk, pruning only the directories all
     three always prune. For TypeScript it also covers the package manager's
     install record and the mtime of each `node_modules` directory.

   When the key matches, the stored stream is replayed through the same writer
   in the same order, so the run's facts are the facts a fresh run would
   write. The run records `facts reused from run N: the K files it reads and
   the extractor itself are byte-identical`. An extractor that fails stores
   nothing, and a stream that cannot be replayed fails the run and is deleted.
2. **History.** When HEAD, `since` (absolute dates only), prefix, scope, git's
   version and `git config --list` all match the last mine, and that run's
   rows are still present, its `git_commit` and `commit_file` rows are copied
   into the new run. A moved HEAD is mined afresh. A new commit can rename a
   file, and rename resolution (ADR-0009) then rewrites the canonical path of
   every older change to that file, so "old rows plus new commits" is not what
   a fresh mine gives.
3. **The MCP server follows the latest completed run**, unless `--run` pins
   one. The first answer after a switch opens with a notice naming both runs,
   so a transcript shows where answers stop agreeing. That answers ADR-0015's
   objection to per-call resolution. Every answer ends with the files the
   run's extractors read that have since changed on disk, compared against
   the inputs recorded with the stream. The comparison is re-measured at most
   every 10 s, and a size-and-mtime match is taken as unchanged. That is fine
   for "is this answer stale?"; reuse itself always re-hashes.

Both reuses are on by default; `--no-reuse` on `extract`, `history` and `scan`
turns them off.

Separately, and not a reuse: `analyze` stopped re-deriving package ancestry
once per cycle hop and per cluster neighbour (the same 889 findings and
citations on nacos, 33 s → 4 s).

## Alternatives considered

**Per-file or per-module Java re-extraction.** This would be the only way to
get a Java edit down to seconds. Rejected: cross-file state means a changed
file can alter the facts of files that were not re-parsed. Getting it right
would need a dependency-tracking extractor that knows which facts each input
influenced, a much larger change that should be measured before it is built.

**Copy the previous run's rows with SQL instead of replaying the stream.**
About 2–3 s faster on nacos. Rejected for now: the writer merges a node that several
extractors emit into one row (it keeps the first declaration), so which rows
"belong" to an extractor is not a clean partition. Replaying the stream
is equivalent by construction; copying rows would need its own proof.

**Keying on `git ls-files -s` blob hashes.** Cheap, but the extractors read
the disk, not the index. An untracked or modified file changes their output
without changing the index.

**Keying on size and mtime.** Tools that restore mtimes (`cp -p`, `rsync -t`,
archives) could replay stale facts. Hashing nacos's inputs costs under 1 s.

**Pinning the MCP run and only reporting that a newer one exists.** It keeps
ADR-0015 as written, but then every refresh needs a client restart, and the
plan asks for the server to stay current.

## Consequences

- On nacos a TypeScript-only edit refreshes (`extract`, `history`, `analyze`)
  in about 15 s under load instead of about 78 s. Replaying 400k facts is most
  of what is left, about 4.5 s.
- **A Java or Kotlin edit still re-parses the whole program** (33 s on nacos).
  This is the stated limit of this ADR, not an oversight.
- The TypeScript key cannot see a `node_modules` tree changed without either
  its install record or the directory's mtime changing (for example a hand
  edit inside a package). `--no-reuse` is the remedy.
- A `.facts` directory beside each store holds one stream per extractor
  (nacos: 9 MB). Its file names end in extensions no extractor reads, so it
  cannot change a key.
- A store extracted before 2.1 has no input records. `describe_run` says that
  drift cannot be measured for it rather than implying there is none.
