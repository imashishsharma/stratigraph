# stratigraph

**Read the layers of a codebase.**

Stratigraphy is how archaeologists read a site: layer by layer, deducing the
order things happened from what sits on top of what. `stratigraph` does the same
to a large codebase — it reads the source, reads the git history, and
reconstructs how the thing came to be shaped the way it is.

Aimed at monoliths and multi-module builds of 100k+ LOC where nobody remembers
why things are the way they are. Java/Spring Boot and Angular first.

> **Status: M1.** The Java extractor works and the first analysis runs on top
> of it. Pointed at [apache/dubbo](https://github.com/apache/dubbo) — 4,053
> Java files, no Spring Boot, `javax.*`, Spring XML wiring — it produces 47,350
> nodes and 163,693 edges in 18 seconds, then reports 17 package cycles across
> 652 packages. Three were verified by hand against the cited lines.
>
> History mining (M2), interpretation (M3), the MCP server (M4) and the Angular
> extractor (M5) are still ahead.

## The rule that shapes everything

**Static analysis produces facts. The LLM produces interpretation. The LLM never
invents a fact.**

Every node and edge comes from a parser, from `git log`, or from a build file.
Every claim in a generated report carries a provenance reference — a file and
line, a commit sha, or a fact-table row. When the model wants to assert
something it cannot cite, the correct output is "no evidence found".

This is enforced in the schema, not only in prompts: interpretation lives in
different tables from facts, edges are marked `fact` or `inferred`, and a
citation row has a `CHECK` constraint forcing it to point at something real.
See [ADR-0002](docs/adr/0002-sqlite-fact-store.md).

The whole pipeline runs with `--no-llm` and still produces a useful report.

## Install

```sh
npx stratigraph --help
```

Requires Node 18.18 or newer. Nothing else, until you analyse Java — the Java
extractor needs a JDK 17+ available, and tells you so rather than crashing:

```sh
stratigraph doctor
```

```
ok   stratigraph  v1.0.1, fact-store schema v1
ok   node         v20.11.1 on darwin-arm64
ok   git          git version 2.50.1
warn java         1.8.0_432 from JAVA_HOME is below JDK 17; the Java extractor
                  will not run (this limits the analyser, not the code it can analyse)
warn extractor    Java extractor jar not found — build it with
                  `cd extractors/java && ./mvnw package`
ok   config       defaults (no stratigraph.config.json found)
--   database     .stratigraph/my-repo.db does not exist yet — run `stratigraph init`
```

A Docker image is the second channel, for environments where you would rather
not think about toolchains at all. See
[ADR-0004](docs/adr/0004-distribution-and-runtime-independence.md).

## Use

```sh
stratigraph init    --repo ../some-monolith   # create the fact store
stratigraph extract --repo ../some-monolith   # run the Java extractor into it
stratigraph history --repo ../some-monolith   # mine git: churn, complexity, authors
stratigraph analyze --repo ../some-monolith   # cycles, coupling, hotspots, ownership
```

`history` attaches to the run `extract` opened, so both halves share one
`run_id` — which is what lets `analyze` say exactly which co-changing files
have no dependency between them. Either half works alone: on a machine with no
JDK, `init` + `history` + `analyze` still produces a full history report, and
`analyze` says which sections it could not fill rather than leaving them out.

`analyze` prints each cycle as a path with the edges that justify every hop:

```
1. [high] com.example.web → com.example.service → com.example.repo → com.example.web
   com.example.web → com.example.service
     imports  web.OrderController → service.OrderService  [src/web/OrderController.java:9]
   ...
```

Every hop names a file and a line, because a dependency cycle you cannot check
is not worth reporting. Cycles are stored as findings with citations into the
edges that produced them, never as facts — see
[ADR-0008](docs/adr/0008-cycles-are-findings-not-facts.md).

`stratigraph extract --emit` writes the raw NDJSON to stdout instead of storing
it, and `stratigraph ingest --from facts.ndjson` replays a captured stream.

### History, and the coupling nobody wrote down

The output worth having is the second section: files that change together over
and over with **nothing in the code connecting them**. The static graph cannot
see that by construction.

```
Files that change together with no dependency between them (top 20):

1. src/main/java/com/example/order/OrderService.java
   src/main/resources/db/migration/V12__order_status.sql
   31 shared commits — strength 0.86, 9.4x chance (36 and 41 commits respectively)
```

Every such pair is stored as a finding citing the commit shas that produced it,
so `git show` settles any disagreement. Nothing is filtered silently: the
report says how many commits were considered, how many were too broad to pair,
and how many pairs each threshold removed — an empty section reads like a clean
repository unless it says what was examined.

Three things decide whether that output is signal or noise, and all three are
written down in [ADR-0011](docs/adr/0011-which-commits-count.md): merge commits
are excluded, commits touching more than 50 files take no part in pairing (one
repo-wide reformat otherwise couples everything it touched), and a pair must
co-change *more often than chance*, not merely often.

Renames are followed, so a file moved three years ago has one history rather
than two halves. `git log --follow` cannot do this — it takes exactly one
pathspec — so the miner makes one whole-repository pass and resolves the rename
chains itself ([ADR-0009](docs/adr/0009-rename-tracking-without-follow.md)).

Alongside it: hotspots ranked by churn × complexity, and files whose history is
concentrated in one person. Complexity is total indentation — a proxy, named as
one, chosen because it needs no parser and therefore also scores the XML, SQL
and properties files that turn up in coupling pairs constantly.

```sh
stratigraph history --repo ../some-monolith --since '3 years ago'
stratigraph analyze --repo ../some-monolith --top 40
```

### The Java extractor

Needs a JDK 17+ to *run in*; it parses source of any vintage, including Java 8.
It **parses the source set and never runs or resolves your build**
([ADR-0006](docs/adr/0006-parse-the-source-set-not-the-build.md)), so it works
on a repository that does not compile, has no build file, or uses a layout
nobody has used since Ant. Plain core Java with no framework at all gets the
full structural output — package graph, cycles and all.

Until the first release with a jar attached, build it from a checkout:

```sh
cd extractors/java && ./mvnw package
```

`stratigraph doctor` reports where it found the jar and when it was built.

What it cannot see without a classpath is stated rather than guessed:
meta-annotated custom stereotypes, members inherited from third-party
supertypes, anything an annotation processor generates, and bean wiring defined
in XML. Each of those produces a diagnostic and an absence, never a wrong edge.

The fact store defaults to `.stratigraph/<repo-name>.db` **under your current
directory**, never inside the repository being analysed.

### Configuration

`stratigraph.config.json`, looked up in the working directory then the repo.
CLI flags win over the file; the file wins over defaults. Unknown keys are an
error, not a shrug.

```json
{
  "repo": "../some-monolith",
  "db": ".stratigraph/monolith.db",
  "exclude": ["node_modules", "target", "generated"],
  "java": { "home": "/opt/jdk21", "jar": "./stratigraph-java-extractor.jar" },
  "history": { "since": "3 years ago", "maxFilesPerCommit": 50, "minShared": 5 },
  "llm": { "enabled": true, "sendSource": false }
}
```

`llm.sendSource` is off by default and loudly logged when on. Extraction and
history mining are entirely local; only the interpretation layer talks to a
model API, and only about structural metadata unless you opt in.

## Architecture

Five layers, strictly one-directional. Layers do not reach backwards;
presenters never call extractors.

```
extractors ──NDJSON──▶ fact store ──▶ history miner ──▶ interpreters ──▶ presenters
 (Java: JVM)            (SQLite)        (git log)      (clustering + LLM)   (Mermaid,
 (TS: compiler API)                                                          C4, HTML,
                                                                             MCP server)
```

Extractors are separate processes that emit newline-delimited JSON on stdout.
The core never links against a parser, which is why a JVM-only Java parser and a
Node-only Angular parser can coexist without either infecting the core
([ADR-0001](docs/adr/0001-language-split.md),
[ADR-0003](docs/adr/0003-ndjson-fact-protocol.md)).

## Development

```sh
npm install
npm test           # vitest
npm run typecheck
npm run build
npm run stratigraph -- doctor      # run the CLI from source

cd extractors/java && ./mvnw verify # the extractor and its golden tests
```

The TypeScript suite never needs a JDK — the core is tested against a fake
extractor that prints canned NDJSON, because the protocol is the whole
contract. The extractor's own suite asserts exact fact output for every
fixture, and CI runs one job where a real jar meets the real fact store.

It needs git for exactly one test, which builds its own repository with fixed
dates and authors. Everything else about history is driven from a captured
`git log` in `fixtures/git-log/` or from seeded rows, so the three-OS matrix
depends on no binary it did not install.

Conventions:

- Test-first for anything in the fact layer. A parser change without a fixture
  test does not get committed.
- Fixtures in `fixtures/` are tiny, hand-written, and assert exact fact output.
  The one exception is `fixtures/git-log/`, captured from a real git — it
  asserts what *git* emits, and inventing that from memory is how a parser ends
  up handling a format nobody produces.
- No speculative abstraction: two concrete implementations before an interface.
- Every non-obvious decision gets an ADR in [`docs/adr/`](docs/adr/).

## Licence

Apache-2.0.
