# stratigraph

**Read the layers of a codebase.**

Stratigraphy is how archaeologists read a site: layer by layer, deducing the
order things happened from what sits on top of what. `stratigraph` does the same
to a large codebase — it reads the source, reads the git history, and
reconstructs how the thing came to be shaped the way it is.

Aimed at monoliths and multi-module builds of 100k+ LOC where nobody remembers
why things are the way they are. Java/Spring Boot and Angular first.

> **Status: M0.** The skeleton — CLI, config, fact store, extractor protocol —
> is in place and tested. The extractors themselves land next: Java first, then
> Angular. Nothing here invents facts yet because nothing here produces facts
> yet.

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
ok   stratigraph  v0.0.0, fact-store schema v1
ok   node         v20.11.1 on darwin-arm64
ok   git          git version 2.50.1
warn java         1.8.0_432 from JAVA_HOME is below JDK 17; the Java extractor
                  will not run (this limits the analyser, not the code it can analyse)
ok   config       defaults (no stratigraph.config.json found)
--   database     .stratigraph/my-repo.db does not exist yet — run `stratigraph init`
```

A Docker image is the second channel, for environments where you would rather
not think about toolchains at all. See
[ADR-0004](docs/adr/0004-distribution-and-runtime-independence.md).

## Use

```sh
stratigraph init --repo ../some-monolith      # create the fact store
stratigraph ingest --repo ../some-monolith --from facts.ndjson
```

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
  "java": { "home": "/opt/jdk21" },
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
```

Conventions:

- Test-first for anything in the fact layer. A parser change without a fixture
  test does not get committed.
- Fixtures in `fixtures/` are tiny, hand-written, and assert exact fact output.
- No speculative abstraction: two concrete implementations before an interface.
- Every non-obvious decision gets an ADR in [`docs/adr/`](docs/adr/).

## Licence

Apache-2.0.
