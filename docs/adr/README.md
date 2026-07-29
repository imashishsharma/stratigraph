# Architecture decision records

This project produces ADR candidates from other people's codebases, so it keeps
its own.

Write the ADR **before** the code when the decision is architectural, **after**
the code when it is incidental. Either way, before the commit.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-language-split.md) | TypeScript core, per-language extractor processes | accepted |
| [0002](0002-sqlite-fact-store.md) | SQLite fact store; facts and interpretation in separate tables | accepted |
| [0003](0003-ndjson-fact-protocol.md) | NDJSON over stdout as the extractor protocol | accepted |
| [0004](0004-distribution-and-runtime-independence.md) | One npm package, fetched extractor jar, Docker image | accepted |
| [0005](0005-framework-annotations-without-a-classpath.md) | Resolve framework annotations from source, not from a classpath | accepted |
| [0006](0006-parse-the-source-set-not-the-build.md) | Parse the source set; never run or resolve the target's build | accepted |
| [0007](0007-fact-identity.md) | How a node's `fqn` is formed | accepted |
| [0008](0008-cycles-are-findings-not-facts.md) | A package cycle is a finding with citations, not a fact | accepted |
| [0009](0009-rename-tracking-without-follow.md) | One whole-repo `git log -M` pass; resolve rename chains ourselves | accepted |
| [0010](0010-history-metrics-and-coupling-claims.md) | History metrics are arithmetic; coupling claims are findings citing commits | accepted |
| [0011](0011-which-commits-count.md) | Merge exclusion, the sweeping-commit cap, and the coupling thresholds | accepted |

Format: context, decision, alternatives considered (with why each was rejected),
consequences — including the costs, not only the benefits.
