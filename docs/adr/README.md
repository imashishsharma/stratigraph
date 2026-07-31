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
| [0012](0012-the-combined-graph-and-louvain.md) | One undirected package graph from both layers, clustered deterministically | accepted |
| [0013](0013-the-grounding-contract.md) | Opaque evidence packs, and a citation check in code that rejects model output | accepted |
| [0014](0014-intent-versus-structure.md) | Intent-vs-structure mismatch is algorithmic; the model only describes it | accepted |
| [0015](0015-the-mcp-query-surface.md) | The MCP surface: one pinned run, read-only, and empty answers that say which kind of empty | accepted |
| [0016](0016-angular-without-the-angular-compiler.md) | Parse the TypeScript source set; no `@angular/compiler-cli`, no install | accepted |
| [0017](0017-typescript-fact-identity.md) | How a TypeScript node's `fqn` is formed, and where it departs from ADR-0007 | accepted |
| [0018](0018-cross-stack-links-are-inferences.md) | An Angular-to-Spring link is inferred, matched conservatively, and refused on a tie | accepted |
| [0019](0019-c4-is-a-projection-of-the-fact-graph.md) | C4 levels project the fact graph, and omit the boxes no fact supplies | accepted |
| [0020](0020-the-report-renders-its-own-svg.md) | The HTML report lays out and renders its own SVG; no browser, no JavaScript | accepted |
| [0021](0021-finding-rank-and-publishability.md) | Finding rank is arithmetic and total; an uncited finding is excluded and counted | accepted |
| [0022](0022-code-level-and-the-data-model.md) | C4 level 4 per package, an ER model from declared mappings, and the cost of an erased type | accepted |

Format: context, decision, alternatives considered (with why each was rejected),
consequences — including the costs, not only the benefits.
