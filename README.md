# stratigraph

**Read the layers of a codebase.**

Stratigraphy is how archaeologists read a site: layer by layer, deducing the
order things happened from what sits on top of what. `stratigraph` does the same
to a large codebase — it reads the source, reads the git history, and
reconstructs how the thing came to be shaped the way it is.

Aimed at monoliths and multi-module builds of 100k+ LOC where nobody remembers
why things are the way they are. Java/Spring Boot and Angular first.

> **Status: M2.** The Java extractor, the package graph, and history mining all
> work. Pointed at [apache/dubbo](https://github.com/apache/dubbo) — 4,053 Java
> files, no Spring Boot, `javax.*`, Spring XML wiring — it produces 47,350 nodes
> and 163,693 edges in 18 seconds and reports 17 package cycles across 652
> packages, three verified by hand against the cited lines. It then mines 8,893
> commits in 4.5 seconds (332 MB peak), resolving 6,189 paths through rename
> chains, and finds 3,303 co-changing file pairs the dependency graph cannot
> explain.
>
> Interpretation (M3), the MCP server (M4) and the Angular extractor (M5) are
> still ahead.

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
stratigraph analyze --repo ../some-monolith   # cycles, clusters, coupling, hotspots, ownership
```

`analyze --no-llm` is the whole report minus the prose: clusters, mismatches,
cycles, coupling, hotspots and ownership all come out of algorithms. The model
adds names and readings on top of that, and never replaces any of it.

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

### Clusters, and the packages whose name is a lie

`analyze` groups packages into communities over one graph built from **both**
layers: the dependency edges the extractor observed, and the co-change the
history miner measured. History is allowed to move a package into the group it
actually belongs to, which is the point of combining them at all.

```
3 package clusters (modularity 0.412, coupling weight 1):

1. Order handling (com.example.shop.order) — 7 packages
   Serves the order lifecycle and persists it.
     com.example.shop.order.api
     ...
```

`coupling weight` is printed because it decides the answer: at `0` the grouping
is purely structural, and raising it lets history outvote the imports. Run it
again with `--coupling-weight 0` and see what moves. The algorithm is Louvain
with every source of randomness removed, so the same facts always give the same
clusters — a partition that shifted between runs would make every finding built
on it unfalsifiable ([ADR-0012](docs/adr/0012-the-combined-graph-and-louvain.md)).

The finding worth the milestone is the next one:

```
1. [high] shop.billing.report is named under shop.billing but clusters with shop.admin
   All of the 3 packages named under shop.billing sit in shop.billing:
   shop.billing.invoice, shop.billing.ledger, shop.billing.payment.
   This one sits in shop.admin instead.
   connected to shop.admin.role: imports shop.billing.report.A → shop.admin.role.A
     (src/shop/billing/report/A.java:201)
```

A package name is a path, so the packages sharing its parent path are its
declared neighbourhood, and "named alongside these three, clustered with those
three" is arithmetic — not a model's opinion about what `report` sounds like.
The model may later describe what the two responsibilities appear to be; it
never decides that a mismatch exists
([ADR-0014](docs/adr/0014-intent-versus-structure.md)).

### Interpretation, and what stops it inventing things

Names, descriptions and ADR candidates are the only things a model writes, and
they are written under a contract enforced in code rather than in the prompt.

Each cluster is packed into a numbered list of evidence — packages, edges with
file and line, files with their churn, commits — where every item carries an
**opaque, pack-local id** (`e12`, not the database's edge id). A model that
guesses a database id lands on a real row, so guessing fails open. A model that
guesses `e99` in a pack of twelve lands on nothing.

Four rules reject a response outright:

1. a citation that is not an id in the pack;
2. a claim that cites nothing;
3. **any identifier, path or commit sha in the prose that the pack did not
   contain** — this is the one that catches a real citation attached to a
   sentence about a class that does not exist;
4. an ADR candidate whose evidence does not resolve.

A rejected response is retried once with the violations attached, then
discarded. Nothing rejected is ever stored, and every give-up leaves a
`diagnostic` row — because a cluster nobody could describe must not read like
one nobody tried to describe
([ADR-0013](docs/adr/0013-the-grounding-contract.md)).

```
Interpretation by claude-opus-5 — 12 of 14 clusters described.
  Names and descriptions above this line are inference, not observation.
  2 description(s) failed the citation check and were discarded — see the diagnostic table.
```

What the check cannot do is verify that the evidence *supports* the sentence. A
model can cite seven genuine imports and draw the wrong conclusion from all of
them. That is exactly why the mismatch claim above stays algorithmic, and why
everything model-authored is stored with `authored_by = 'model'`, the model id
that answered, and a report that says which lines are inference.

Without a credential — or with `--no-llm` — `analyze` says so in one line and
prints the structural report unchanged.

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

Two files, looked up in the working directory and then the repo. CLI flags win
over the local file, the local file wins over the shared one, and that wins over
defaults. Unknown keys are an error, not a shrug.

**`stratigraph.config.json`** — the project. Commit this one.

```json
{
  "repo": "../some-monolith",
  "db": ".stratigraph/monolith.db",
  "exclude": ["node_modules", "target", "generated"],
  "java": { "home": "/opt/jdk21", "jar": "./stratigraph-java-extractor.jar" },
  "history": { "since": "3 years ago", "maxFilesPerCommit": 50, "minShared": 5 },
  "interpret": { "couplingWeight": 1, "minClusterSize": 2, "maxClusters": 25 },
  "llm": { "enabled": true, "model": "claude-opus-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }
}
```

**`stratigraph.config.local.json`** — the machine. Add it to `.gitignore`.

```json
{
  "llm": { "model": "claude-sonnet-5", "apiKey": "sk-ant-..." }
}
```

Merged over the shared file key by key, so a team commits one config and each
person overrides the model, the credential, or any threshold without touching
it.

#### The credential

Four ways, in the order they are tried. `stratigraph doctor` prints which one
answered — and never prints the key itself.

| Where | How |
| --- | --- |
| `llm.apiKey` | Inline, **only** in `stratigraph.config.local.json` |
| `llm.apiKeyFile` | Path to a file holding the key; `~` expands, relative paths resolve against the config file |
| `llm.apiKeyEnv` | Name of the environment variable to read (default `ANTHROPIC_API_KEY`) |
| — | `ANTHROPIC_AUTH_TOKEN`, or a profile from `ant auth login` |

`llm.apiKey` in the **shared** `stratigraph.config.json` is refused outright,
with an error naming the alternatives. That file is meant to be committed, and a
key in it is a key in the repository's history — by the time anyone notices, it
has to be rotated rather than deleted. A warning would scroll past.

A configured `apiKeyFile` that cannot be read is an error too, rather than a
quiet fall-through to whatever else is lying around: silently using a different
credential than the one you asked for is how the wrong account gets billed.

```console
$ stratigraph doctor
ok   config       stratigraph.config.json + stratigraph.config.local.json
ok   model        claude-opus-5, credential from stratigraph.config.local.json
```

#### The rest

`llm.sendSource` is off by default and loudly logged when on. Extraction and
history mining are entirely local; only the interpretation layer talks to a
model API, and only about structural metadata unless you opt in.

`interpret.couplingWeight` is the knob that decides the clustering, so `analyze`
prints the value it used. `maxClusters` caps how many clusters are sent to the
model, so a large repository cannot run away with your bill. The model comes
from `--model`, then `llm.model`, then the default; whichever *answered* is
recorded on every row it writes.

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
