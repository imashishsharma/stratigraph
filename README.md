# stratigraph

**Read the layers of a codebase.**

[![npm](https://img.shields.io/npm/v/stratigraph)](https://www.npmjs.com/package/stratigraph)
[![CI](https://github.com/imashishsharma/stratigraph/actions/workflows/ci.yml/badge.svg)](https://github.com/imashishsharma/stratigraph/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node >=18.18](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](package.json)

Stratigraphy is how archaeologists read a site: layer by layer, deducing the
order things happened from what sits on top of what. `stratigraph` does the same
to a large codebase — it reads the source, reads the git history, and
reconstructs how the thing came to be shaped the way it is.

Aimed at monoliths and multi-module builds of 100k+ LOC where nobody remembers
why things are the way they are. Java, Kotlin and Angular first. It runs on
repositories that do not compile, have never had `node_modules` installed, and
use layouts nobody has used since Ant — because those are exactly the
repositories nobody remembers.

## What comes out

- **A fact graph** — packages, classes, methods, endpoints, DI edges, routes,
  O/R mappings — in a local SQLite file, every row citing a file and line, a
  commit sha, or the build file it was read from.
- **History you can act on** — hotspots ranked by churn × complexity, files
  whose history is one person, and files that change together over and over
  with *nothing in the code connecting them*.
- **C4 diagrams at all four levels**, an ER model read out of the O/R mappings,
  the HTTP surface, and a ranked findings list — as Structurizr DSL, as
  Mermaid, and as one self-contained HTML page: no script, no network, no CDN.
- **A diff between two runs**, so CI can fail a pull request for the cycle it
  *added* and stay quiet about the six hundred that were already there — the
  only gate a legacy monolith can switch on today.
- **An MCP server**, so an agent working in the codebase can ask structural
  questions instead of grepping for them.
- **Optionally, model-written names and descriptions** for the package
  clusters — under a citation check, enforced in code, that rejects any
  sentence naming something the model was not shown.

## Sixty seconds

```sh
npm install -g stratigraph      # or run every command through: npx stratigraph

cd ~/work                       # the fact store lands here, not in the repo
stratigraph init    --repo ../some-monolith   # create the fact store
stratigraph extract --repo ../some-monolith   # parse the source into facts
stratigraph history --repo ../some-monolith   # mine git: churn, coupling, authors
stratigraph analyze --repo ../some-monolith --no-llm  # cycles, clusters, hotspots
stratigraph report  --repo ../some-monolith --out ./arch
open ./arch/index.html
```

TypeScript and Angular analysis works out of the box — the extractor ships in
this package and runs on the Node you already have. Java and Kotlin need a JDK 17+ and
one more command, `stratigraph fetch-extractor`, which downloads the extractor
jar and verifies it against a checksum pinned in this package. No API key is
needed for any of the above: `--no-llm` is the whole structural report, and a
model only ever adds prose on top of it.

```sh
stratigraph doctor    # says which of these your machine can do right now
```

## Contents

- [The rule that shapes everything](#the-rule-that-shapes-everything)
- [Measured on real repositories](#measured-on-real-repositories)
- [Install](#install)
- [Set your API key](#set-your-api-key) — optional
- [Use](#use)
  - [Angular, and the endpoint it might be calling](#angular-and-the-endpoint-it-might-be-calling)
  - [History, and the coupling nobody wrote down](#history-and-the-coupling-nobody-wrote-down)
  - [Clusters, and the packages whose name is a lie](#clusters-and-the-packages-whose-name-is-a-lie)
  - [Interpretation, and what stops it inventing things](#interpretation-and-what-stops-it-inventing-things)
  - [The report you would actually show someone](#the-report-you-would-actually-show-someone)
  - [Ask it questions from an agent](#ask-it-questions-from-an-agent) — MCP
  - [The JVM extractor — Java and Kotlin](#the-jvm-extractor--java-and-kotlin)
  - [The TypeScript extractor](#the-typescript-extractor)
  - [Keeping the fact store small](#keeping-the-fact-store-small)
  - [In a pipeline: JSON and a quality gate](#in-a-pipeline-json-and-a-quality-gate)
  - [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)

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

## Measured on real repositories

Every milestone ended with an acceptance run against a repository that is not a
fixture. The numbers below come from those runs, each recorded in an ADR with
what produced it — including the runs that produced nothing.

**[apache/dubbo](https://github.com/apache/dubbo)** — 4,053 Java files, no
Spring Boot, `javax.*`, Spring XML wiring: 47,350 nodes and 163,693 edges in
18 seconds; 17 package cycles across 652 packages, three verified by hand
against the cited lines. History: 8,893 commits mined in 4.5 seconds (332 MB
peak), 6,189 paths resolved through rename chains, 3,303 co-changing file
pairs the dependency graph cannot explain. The interpretation layer's citation
check held at 38 of 38 grounded cluster descriptions accepted, zero
fabrications missed — and it is re-run against five kinds of mutated
identifier on every change to the rule.

**[bitwarden/clients](https://github.com/bitwarden/clients)** — 5,788
TypeScript sources, analysed with no `node_modules` present: 42,016 nodes and
76,179 edges in 5.6 seconds, including 7,024 DI edges, 165 routes and 4,013
component relationships read out of templates. 87% of the DI edges resolve
through the type checker, which is what follows a barrel re-export to the file
the class is actually declared in.

**[spring-petclinic](https://github.com/spring-projects/spring-petclinic)** —
49 Java sources, 1,040 commits: 6 tables with 4 relationships, 6 class
diagrams, 17 endpoints and 44 ranked findings, every one carrying a
`file:line` or a commit sha.

**[jhipster-sample-app](https://github.com/jhipster/jhipster-sample-app)** —
the wildcard-import stress test. JHipster generates every REST controller with
`import org.springframework.web.bind.annotation.*;`, which a source-only
resolver must not guess through — a repository can declare its own
`@GetMapping`. v1.3 read 2 endpoints out of 136 Java sources and said why on
every refusal. v1.4 *earns* the resolution instead
([ADR-0023](docs/adr/0023-earning-resolution-through-a-wildcard-import.md))
and reads 41 — while still refusing the 8 that are genuinely ambiguous,
naming the competing imports on each one.

And over MCP: a fresh Claude Code session, with dubbo out of its context,
answered five structural questions from the store correctly — every answer
checked by hand against the lines it cited. One of its numbers disagreed with
`git log --follow`, and the tool turned out to be right.

## Install

```sh
npm install -g stratigraph
```

Requires Node 18.18 or newer. Nothing else, until you analyse Java — the Java
extractor needs a JDK 17+ available, and tells you so rather than crashing.
`stratigraph doctor` is the honest inventory of what your machine can do:

```console
$ stratigraph doctor
ok   stratigraph     v1.4.0, fact-store schema v1
ok   node            v20.11.1 on darwin-arm64
ok   git             git version 2.50.1
warn java            1.8.0_432 from JAVA_HOME is below JDK 17; the Java extractor
                     will not run (this limits the analyser, not the code it can analyse)
warn java extractor  jar not found — see the README for the two commands that build it
ok   ts extractor    dist/extractors/typescript/main.js (built, no JDK required)
ok   config          defaults (no stratigraph.config.json found)
warn model           claude-opus-5, but no credential found
--   database        .stratigraph/my-repo.db does not exist yet — run `stratigraph init`
```

Every `warn` above still leaves a working tool: that machine can analyse any
TypeScript or Angular repository, mine any git history, and produce the full
structural report. `stratigraph fetch-extractor` clears the second warning;
the first needs a JDK 17+, which the tool will find wherever it is installed
rather than making you export `JAVA_HOME`.

For environments where you would rather not think about toolchains at all,
the image carries its own JDK, git and extractor:

```sh
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/out:/work" \
  ghcr.io/imashishsharma/stratigraph doctor
```

## Set your API key

**Only if you want cluster names and ADR candidates.** Everything structural —
the dependency graph, cycles, clusters, hotspots, coupling, the intent-vs-
structure findings — runs with no key and no configuration at all. Skip this
section entirely and use `analyze --no-llm`.

Pick one. They are tried in this order:

```sh
stratigraph config set-key sk-ant-...     # writes ~/.config/stratigraph/config.json, chmod 600
```
```sh
export ANTHROPIC_API_KEY=sk-ant-...       # this shell; put it in ~/.zshrc to keep it
```
```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env   # this directory; gitignore it
```
```sh
ant auth login                            # no key at all, if you use the Anthropic CLI
```

> **A Claude Pro or Max subscription is not API credit.** Those cover Claude.ai
> and Claude Code; this tool calls `api.anthropic.com`, which is billed
> separately from the [Console](https://console.anthropic.com). A key from an
> account with no API balance authenticates fine and then fails with *"Your
> credit balance is too low"*. `ant auth login` does not change this — the
> OAuth token carries a `user:inference` scope but the organisation still needs
> credit. Interpretation is the only part affected; everything structural runs
> regardless.

Then confirm — it prints where the key came from, never the key:

```console
$ stratigraph doctor
ok   model        claude-opus-5, credential from ~/.config/stratigraph/config.json
```

Not sure what is picked up? `stratigraph config` lists every file that can
affect a run, whether or not it exists, and which one won:

```console
$ stratigraph config
Files that configure a run, weakest first. Later ones win.

found   /home/me/.config/stratigraph/config.json    you, every repository
absent  /home/me/work/stratigraph.config.json       this project, committed  (no key here)
absent  /home/me/work/stratigraph.config.local.json this project, your machine
absent  /home/me/work/.env                          environment, e.g. ANTHROPIC_API_KEY

model        claude-opus-5
credential   /home/me/.config/stratigraph/config.json
```

**A key never goes in `stratigraph.config.json`.** That file is meant to be
committed, and the tool refuses to load one that contains a key — by the time
anyone notices, it has to be rotated rather than deleted. The full reference,
including per-project settings and `apiKeyFile`, is under
[Configuration](#configuration).

## Use

```sh
stratigraph init    --repo ../some-monolith   # create the fact store
stratigraph extract --repo ../some-monolith   # run every applicable extractor into it
stratigraph history --repo ../some-monolith   # mine git: churn, complexity, authors
stratigraph analyze --repo ../some-monolith   # cycles, clusters, coupling, hotspots, ownership
stratigraph report  --repo ../some-monolith --out ./arch   # C4 diagrams, HTML, ranked findings
stratigraph diff    --repo ../some-monolith   # what changed since the previous run
stratigraph mcp     --repo ../some-monolith   # serve it all to an agent over MCP
stratigraph prune   --repo ../some-monolith --keep 2   # drop old runs, reclaim the space
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

`extract` runs **every extractor the repository needs**, detected from what is
on disk, and writes them all into **one run** — which is what lets an Angular
service and the Spring endpoint it calls be joined at all, since nodes are
scoped by `run_id`. `--lang java|ts|all` overrides the detection. A missing JDK
skips the Java half and keeps going rather than failing the command.

`stratigraph extract --emit` writes the raw NDJSON to stdout instead of storing
it, and `stratigraph ingest --from facts.ndjson` replays a captured stream.

### Angular, and the endpoint it might be calling

The TypeScript extractor emits components, injectables, NgModules, DI edges,
routes with their lazy-loaded boundaries, and the component-to-component edges
that only exist inside a template. Directories become `package` nodes, so cycle
detection, clustering and every MCP query work on Angular with no change — a
package cycle in `app/admin/metrics` reads exactly like one in
`com.example.web`, with the template line cited as evidence where a template is
what created it.

Then `analyze` matches Angular HTTP calls against Spring endpoints:

```
1 cross-stack HTTP call(s) — INFERRED, not observed:

  GET /api/orders/{}  ->  GET /api/orders/{id}
    web/src/app/core/order.service:OrderService#findOne()
      web/src/app/core/order.service.ts:15

  Matched by URL pattern against a declared endpoint. Nothing in either file
  says these are connected; check the cited lines before relying on one.
```

Every one of those edges is stored with `confidence = 'inferred'` and is
excluded from the package graph, so no cycle can be assembled out of a string
match. Only literal and template-literal URLs are matched; a computed one gets
a diagnostic and no edge, and a URL matching two endpoints equally well gets a
diagnostic naming both rather than a coin toss
([ADR-0018](docs/adr/0018-cross-stack-links-are-inferences.md)). On a real
JHipster monolith that honesty is visible: its Angular services build every
URL dynamically, so the six candidate calls match eight endpoints equally
well each — and the run records six diagnostics naming all eight, not six
guessed edges.

It also reports subscriptions nothing can end — no `takeUntil`, no retained
`Subscription`, no `ngOnDestroy` on the class. All three have to hold, so a
teardown it cannot see produces silence rather than an accusation.

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

A fourth decides how loudly it is reported. `gradle-wrapper.jar` and
`gradlew.bat` change together in 11 of 11 commits — a perfect co-change score
that means one tool regenerates both. **A pair is rated on its strength only
when a dependency between the two files could have been observed at all**: the
run has a static graph, and both files are ones an extractor parses. Otherwise
it is `low`, because the finding's own detail already says no dependency could
have been seen either way, and a finding must not be rated as strongly as one
whose evidence does not disclaim it. On petclinic that is the difference
between 23 high findings and 7 — and between a `--fail-on high` gate that fires
on every repository with a build wrapper and one worth turning on
([ADR-0028](docs/adr/0028-severity-and-what-was-checkable.md)).

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

### The report you would actually show someone

```sh
stratigraph report --repo ../some-monolith --out ./arch
```

```
arch/index.html                 self-contained: no script, no network, no CDN
arch/workspace.dsl              Structurizr, all three views, with provenance
arch/c4-context.mmd             Mermaid, level 1
arch/c4-container.mmd           level 2
arch/c4-component-<module>.mmd  level 3, one per container
arch/c4-code-<package>.mmd      level 4, one class diagram per package
arch/data-model.mmd             the ER model, from the declared O/R mappings
arch/findings.md                the ranked list, for pasting into an issue
```

The HTML page carries all of that plus the HTTP surface, a package dependency
matrix and ranked hotspots — with a contents list, and a panel of the numbers
worth knowing before you read the rest.

**C4 is a projection of the fact graph, not a new model.** A container is a
`module` node from a build file; a component is a package; a data store exists
because a `@Table` mapping was read; an external system exists because an
extractor read an absolute URL out of a literal. Where C4 asks for something no
fact supplies, the diagram omits the box and says so on the page:

> No fact in this run identifies a person, a role or a user, so no actor is
> drawn. C4 normally puts one here; this diagram shows only what a parser read.

Every C4 diagram you have seen has a stick figure in the top left. Drawing one
here would take four lines of code and nobody would question it — and it would
be a box in an architecture map that no parser ever produced
([ADR-0019](docs/adr/0019-c4-is-a-projection-of-the-fact-graph.md)).

The HTML renders its own SVG rather than bundling a renderer or shelling out to
a headless browser, so a 40 KB page opens from a file share, survives being
emailed, and works with scripting disabled. The layout is deterministic to the
pixel — the same run produces the same bytes, which is what lets a fixture test
assert the whole SVG rather than that it contains a `<rect>`
([ADR-0020](docs/adr/0020-the-report-renders-its-own-svg.md)).

Findings are ranked by severity, then observation before inference, then how
much evidence there is, then rule name, then id — arithmetic over stored
columns, total, and reproducible. No weighted score, because a constant
invented in the report layer is a judgement nobody can argue with. And this is
where the promise the schema has carried since M0 is finally kept: **a finding
with no citation is not published**, it is excluded from every count, and the
number excluded is printed
([ADR-0021](docs/adr/0021-finding-rank-and-publishability.md)).

**Level 4 is one class diagram per package** — a package is something the
source states, where a cluster is something an algorithm decided, and the level
where a reader is closest to the code is the wrong place to introduce a
grouping that is not in the code. Boxes carry stereotypes, fields and methods
as declared; generalisation, realisation and association are drawn as UML draws
them.

**The data model is read out of the O/R mappings.** The entity is the table,
its columns are the mapped class's fields *including the ones it inherits* —
JPA maps a mapped-superclass chain into the subclass's table, so without that
`owners` would have no primary key — and cardinality comes from the JPA
annotation rather than from a field being plural.

That last part cost an extractor change worth recording. `List<Pet>` erases to
`java.util.List` for the fqn, and has to, or two overloads differing only by
type argument become two nodes. It also destroys the only thing that says what
the collection holds: on petclinic, **three of four entity associations had a
readable cardinality and an unreadable target.** The extractor now records the
type arguments beside the erased type — no fqn changes — and all four
relationships come out
([ADR-0022](docs/adr/0022-code-level-and-the-data-model.md)). An association
whose target still cannot be read gets a row in its own table saying why, never
a line to a plausible one.

Run against [spring-petclinic](https://github.com/spring-projects/spring-petclinic)
— 49 Java sources, 1,040 commits — it produces 6 tables with 4 relationships,
6 class diagrams, 17 endpoints, and 44 findings, every one carrying either a
`file:line` or a commit sha, and each one states its own limits inline:

> `mvnw` and `mvnw.cmd` change together — 11 of the 11 commits touching either
> file touch both, 65.1× what independent files would share. *No extractor
> parses `mvnw` or `mvnw.cmd`, so no dependency could have been observed
> between them either way. This is co-change without a checkable explanation,
> not a demonstrated absence of coupling in the code.*

### Ask it questions from an agent

`stratigraph mcp` serves the fact store over MCP on stdio, so an agent working
in the codebase can ask structural questions instead of grepping for them.

```sh
claude mcp add stratigraph -- stratigraph mcp --repo ../some-monolith
```

Nine tools, all read-only:

| Tool | Answers |
| --- | --- |
| `describe_run` | What this store contains, and — the point of it — what it does not |
| `find_node` | Resolve a name you have to the exact `fqn` the other tools take |
| `query_dependencies` | What a package or type depends on, and what depends on it |
| `find_callers` | Every observed call or injection into a method or type |
| `describe_module` | One package in full: types, endpoints, tables, churn, cluster |
| `list_endpoints` | The HTTP surface, with the method that serves each route |
| `find_hotspots` | Churn × complexity, or files whose history is one person |
| `trace_to_table` | The types mapped to a table, and what reaches them |
| `check_cycle` | Whether two packages depend on each other, with the edges |

**The server only reads.** It opens the database read-only and never starts an
extractor: a stale store is reported as stale, not silently rebuilt, because a
tool call is a bad place to start a JVM over 4,000 files. It also pins one run
at startup, so two answers in a session cannot describe two different commits.

Every result carries a file and line, an `fqn` or a sha. Anything a model wrote
comes back labelled `authoredBy: "model"` and is never blended into the
structural answer. And every tool that can return nothing says which kind of
nothing it is — `found` for "that name is not in this run", `covered` for "this
run could not have answered that" — because to an agent an empty array reads as
"there is no such thing" either way
([ADR-0015](docs/adr/0015-the-mcp-query-surface.md)).

Pointed at dubbo, with the repository itself out of context, it answered five
structural questions correctly — a cycle with both directions cited, the sole
call site of a method, a bus-factor file, a package summary — and each answer
was checked by hand against the lines it cited. One of its numbers disagreed
with `git log --follow`, and the tool turned out to be right; the run is
recorded in the ADR.

### The JVM extractor — Java and Kotlin

Needs a JDK 17+ to *run in*; it parses source of any vintage, including Java 8.
It **parses the source set and never runs or resolves your build**
([ADR-0006](docs/adr/0006-parse-the-source-set-not-the-build.md)), so it works
on a repository that does not compile, has no build file, or uses a layout
nobody has used since Ant. Plain core Java with no framework at all gets the
full structural output — package graph, cycles and all.

**Kotlin is read by the same extractor, in the same run.** That last part is
the point: Kotlin turns up *inside* Java repositories — a Spring Boot service
with a Kotlin test module, a team migrating package by package — and two
separate analyses could not join a Kotlin service to the Java repository it
calls, because nodes are scoped by `run_id`. One run, one graph.

Everything built on the fact graph therefore works on Kotlin without knowing
about it. On a four-file Kotlin fixture:

```
node  class     com.example.shop.service.OrderService
edge  annotated_with  OrderService -> org.springframework.stereotype.Service
edge  injects         OrderService -> repo.OrderRepository
node  endpoint  GET /api/orders/{id}
edge  handles         OrderController#byId(long) -> GET /api/orders/{id}
edge  maps_to         domain.Order -> orders
```

— constructor injection, the HTTP surface, and an ER model with `Long id PK`
read out of `@Entity` and `@Id`. `--lang kotlin`, `kt` and `jvm` all name this
extractor; `.kt` files select it with no flag at all. A `build.gradle.kts` is
read as a module's identity, never as a source file.

What the `J` model has no place for is read as its nearest Java shape or not at
all: extension functions appear as methods, and coroutines and `object`
declarations have no distinct representation yet. Nothing is guessed
([ADR-0029](docs/adr/0029-kotlin-rides-the-java-extractor.md)).

**One boundary is worth knowing before you rely on a mixed repository.** The two
languages are parsed by different parsers that cannot see each other's sources,
so a Kotlin class injecting a Java one resolves — that comes from the import and
the declared type — while a *call* from Kotlin into a Java method does not:

```
edge  injects  com.example.NewService -> com.example.LegacyRepository   ✓
info: 1 call site(s) could not be resolved to a declaring type and were
      not recorded as edges
```

Closing that would mean compiling the Java half and handing the Kotlin parser a
classpath, which is the one thing this extractor will not do. So it is an
absence with a diagnostic attached, never a guessed edge.

The npm package does not ship the jar — it is 22 MB of JVM bytecode, and most
installs never analyse a line of Java. One command downloads it:

```sh
stratigraph fetch-extractor
```

It is verified against a SHA-256 **written into the npm package by the same
release job that built and attached the jar**, so the digest never arrives from
the same place as the file it describes. A mismatch writes nothing and says so.
There is no flag to skip the check. The jar is cached per version under
`~/.cache/stratigraph/` — keyed by version, so installing an older
`stratigraph` cannot silently run a newer extractor — and every command finds
it there afterwards with no flag.

**This is the only thing in the tool that touches the network, and it is a
command rather than something `extract` does on your behalf.** Extraction and
history mining are entirely local; keeping that true is worth one extra line
([ADR-0004](docs/adr/0004-distribution-and-runtime-independence.md)).

`--dry-run` prints the URL, the target path and the pinned digest without
downloading. For an air-gapped machine, fetch the jar somewhere else and drop
it in — `STRATIGRAPH_CACHE_HOME` points the cache anywhere:

```sh
STRATIGRAPH_CACHE_HOME=/mnt/share/stratigraph stratigraph extract --repo ../monolith
```

Building it yourself still works and still wins over a downloaded jar, because
a developer who has just run maven means the jar they just built:

```sh
git clone https://github.com/imashishsharma/stratigraph
cd stratigraph/extractors/java && ./mvnw package
```

You can also point at one with `--extractor-jar <path>`, `java.jar` in the
config file, or `STRATIGRAPH_JAVA_JAR`. `stratigraph doctor` reports which of
these it found, and when the jar was built.

#### Or skip the toolchain question entirely

The image carries its own JDK 17, git and the extractor, so nothing on the host
matters:

```sh
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/out:/work" \
  ghcr.io/imashishsharma/stratigraph extract --repo /repo
```

The repository is mounted read-only and the fact store is written to `/work`,
never inside the repository being analysed — the same rule the CLI follows.

**Wildcard imports are refused, then earned.** `@GetMapping` under
`import org.springframework.web.bind.annotation.*;` is genuinely ambiguous
from one file's source — a repository can declare its own `GetMapping` — so
the extractor does not guess. Since v1.4 the resolution is *earned* instead
([ADR-0023](docs/adr/0023-earning-resolution-through-a-wildcard-import.md)):
the name resolves when the known-annotation table places it in the one
wildcard-imported package and no type of that name is declared anywhere in the
parsed source set. Facts resolved this way carry
`resolution: "wildcard-import"` so they can always be told apart from a
single-type import, and every refusal that remains names the condition that
failed — the competing wildcard imports, or the shadowing declaration and the
file it sits in. On JHipster's generated controllers this is the difference
between 2 endpoints and 41.

What it cannot see without a classpath is stated rather than guessed:
meta-annotated custom stereotypes, members inherited from third-party
supertypes, anything an annotation processor generates, and bean wiring defined
in XML. Each of those produces a diagnostic and an absence, never a wrong edge.

### The TypeScript extractor

Needs no JDK and no download — it ships inside this package and runs on the Node
already executing, as a separate process so that a parser exhausting memory on a
huge workspace takes down one extractor rather than the analysis.

It **parses the source set and never installs or type-checks your project**
([ADR-0016](docs/adr/0016-angular-without-the-angular-compiler.md)), which is
why it does not use `@angular/compiler-cli`: `NgtscProgram` needs installed
`node_modules`, a resolvable `tsconfig.json` and a project that compiles, and
the repositories this tool exists for routinely have none of the three.
`tsconfig.json` is read as plain JSON for `compilerOptions.paths` and nothing
else — those aliases matter, because in an Nx workspace they are the only way
cross-project imports are ever written.

What it cannot see is stated rather than guessed: anything declared in a package
you have not installed (an `is_stub` node, named by the import that introduced
it), template type-checking, and DI through a factory or an `InjectionToken`.
Each produces a diagnostic and an absence, never a wrong edge.

The fact store defaults to `.stratigraph/<repo-name>.db` **under your current
directory**, never inside the repository being analysed.

### Keeping the fact store small

Every `extract`, `history` and `ingest` opens a **run**, and a run holds a whole
copy of the graph for the commit it read. That is what lets you keep last
quarter's structure next to today's — and it means a store analysed on a
schedule grows without bound.

```console
$ stratigraph prune --repo ../some-monolith --keep 2
run 1    2026-08-12T22:00:06.038Z      343 nodes      205 commits  delete
run 2    2026-08-12T22:03:23.143Z      343 nodes        0 commits  delete
run 3    2026-08-12T22:03:25.010Z      343 nodes        0 commits  delete
run 4    2026-08-13T03:25:56.552Z      343 nodes        0 commits  keep
run 5    2026-08-13T03:25:58.507Z      343 nodes        0 commits  keep
3 run(s) deleted. 2.1 MB -> 792.0 KB (1.3 MB reclaimed).
```

Every run is listed with what it holds and what is about to happen to it,
because a destructive command reporting only a total gives you no way to notice
it took the wrong two. `--dry-run` prints exactly that table and writes nothing.
`--keep` defaults to 3 and must be at least 1; if you want no runs at all,
delete the file.

The space is actually returned rather than left on SQLite's free list — the
delete cascades through every table, then the store is vacuumed and the
write-ahead log folded back in, so the file on disk shrinks.

**Recency is the wrong axis for one thing, and it says so.** `history` attaches
to the run `extract` opened, so two bare extracts leave the newest runs with no
commits and all the mined history on an older one. Pruning by recency would
then delete it, and re-mining a large repository is minutes rather than
seconds — so that case is a warning before it happens:

```
warning: every run being deleted carries the git history and none of the kept
runs has any. After this the store has no commits, and hotspots, churn and
co-change all become unavailable until you run `stratigraph history` again.
```

Nothing prunes automatically. A tool that silently discarded the run you were
about to compare against would be worse than a large file.

### In a pipeline: JSON and a quality gate

`--format json` is global. Every command that produces a result emits one
document on stdout; progress stays on stderr, so a pipe carries only the
document:

```console
$ stratigraph analyze --repo ../monolith --no-llm --format json | jq '.findings.bySeverity'
{
  "high": 9,
  "medium": 35,
  "low": 10
}
```

Every document carries `format: 1`. That number moves only for a change a
parser could trip over, so a consumer can say which shape it understands.

Three things in the shape are worth knowing about, and all three exist for the
same reason the rest of the tool does:

- **`run.coverage` and `run.gaps` travel with the findings.** An empty
  `findings.items` and a clean repository are otherwise the same document
  ([ADR-0026](docs/adr/0026-coverage-describes-the-store.md)).
- **`findings.shown` and `findings.truncated`** say when the item list is capped
  by `--top` while the counts describe the whole run. Totals that do not add up
  should be explained by the document, not discovered by the reader.
- **`findings.unpublishable`** counts findings withheld for carrying no
  citation, rather than dropping them silently
  ([ADR-0021](docs/adr/0021-finding-rank-and-publishability.md)).

#### Failing the build

`--fail-on <severity>` on `analyze` or `report` exits **3** when any publishable
finding reaches that severity:

```console
$ stratigraph analyze --repo . --no-llm --fail-on high
error: 9 finding(s) at or above `high` (9 high). Run `stratigraph report` for the evidence behind each one.
$ echo $?
3
```

**Three, not one.** A pipeline has to tell "this build has nine high findings"
from "the tool could not run" — and a broken analyser read as a clean
repository is the CI version of the mistake this whole project is written
against. The codes are `0` success, `1` unexpected error, `2` a reported error,
`3` the gate.

The gate counts exactly what the report publishes: a finding with no citation
fails no build, because it is a claim the report itself refuses to show. And
the document is written *before* the non-zero exit — a gate that failed still
hands the pipeline the findings that failed it.

#### Failing only on what got worse

`--fail-on` has a problem on the codebases this tool exists for: a 100k-LOC
monolith nobody remembers has hundreds of findings on day one, so a gate that
fails from the first commit gets deleted from the pipeline in a week.

`stratigraph diff` compares two runs, and `--fail-on-new` gates on the
difference:

```console
$ stratigraph diff --repo ../monolith --fail-on-new high
run 41 (a3f19c2e04, 2026-08-06T09:14:02Z) -> run 47 (7b02de1188, 2026-08-13T09:02:55Z)

Findings
  new           3  2 high, 1 medium
  resolved      1  1 high
  unchanged   612

New since the earlier run:
  [high] Package cycle: com.shop.web ⇄ com.shop.billing
  ...

error: 2 new finding(s) at or above `high` since run 41 (2 high). Findings that
were already there do not count.
```

**That gate can be switched on today by a repository that would fail
`--fail-on` on every commit for a year.** The two answer different questions —
"is this codebase acceptable" and "did this change make it worse" — and only the
second one can be asked of a monolith on day one.

Findings are matched across runs by rule and title, which every rule builds
deterministically from the entities involved. Cycles are matched on their *set*
of packages, because the title names the shortest path through a component and
that path rotates when an unrelated edge appears — same cycle, different
sentence. Two analyses of an unchanged repository produce an empty diff; on
spring-petclinic that is 44 findings, 0 new, 0 resolved, in 0.13s.

What it cannot see is a finding whose wording changes while the problem stays:
renaming a package reports its old findings resolved and new ones added. That
is the deliberate trade — matching fuzzily would report a genuinely new cycle as
an old one under a new name, and a gate that quietly does not fire is worse than
one that reports a rename
([ADR-0027](docs/adr/0027-comparing-two-runs.md)).

#### A pipeline that works on a repository with existing debt

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }        # a shallow clone understates every history metric

# The base commit, so there is something to compare against.
- run: |
    git checkout -q ${{ github.event.pull_request.base.sha }}
    npx stratigraph init    --repo .
    npx stratigraph extract --repo .
    npx stratigraph history --repo .
    npx stratigraph analyze --repo . --no-llm

# Then this one. Both land in the same store as consecutive runs.
- run: |
    git checkout -q ${{ github.sha }}
    npx stratigraph extract --repo .
    npx stratigraph history --repo .
    npx stratigraph analyze --repo . --no-llm

- run: npx stratigraph diff --repo . --fail-on-new high --format json > diff.json

- if: always()
  run: npx stratigraph report --repo . --out ./arch
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: architecture, path: ./arch }
```

`history` reports `"shallow": true` in its document when the clone is shallow,
so a pipeline can catch a missing `fetch-depth: 0` rather than silently
comparing understated numbers.

Keep the store between runs (cache `.stratigraph/`) and `stratigraph prune
--keep 10` on a schedule; keep it per-job and the base analysis above is what
gives `diff` its second run.

### Configuration

No config file is required. `stratigraph analyze --no-llm` needs none at all,
and every value below has a working default. You create a file to change
something — see [Set your API key](#set-your-api-key) for the common case.

```sh
stratigraph config                      # what is in play right now
stratigraph init --write-config         # scaffold stratigraph.config.json
```

`init --write-config` writes the defaults spelled out, so the file is a menu of
what can be changed rather than decisions made on your behalf. It never
overwrites an existing one.

#### Where the files go

Four places, none of which exists until you create it, merged weakest first:

| File | Scope | Committed? | Key allowed? |
| --- | --- | --- | --- |
| `~/.config/stratigraph/config.json` | you, every repo you analyse | no — outside every repo | yes |
| `stratigraph.config.json` | one project, everyone on it | **yes** | **no** |
| `stratigraph.config.local.json` | one project, your machine | no — `.gitignore` it | yes |
| `.env` | environment variables | no — `.gitignore` it | yes |

The project files and `.env` are looked up **in the working directory first,
then in the repository being analysed** — so `cd ~/work && stratigraph analyze
--repo ../monolith` reads `~/work/stratigraph.config.json`, then falls back to
`../monolith/stratigraph.config.json`. `--config <path>` overrides the lookup.

On Windows the user file is `%APPDATA%\stratigraph\config.json`.
`XDG_CONFIG_HOME` and `STRATIGRAPH_CONFIG_HOME` are both honoured.

Precedence, highest first: **CLI flags → local → project → user → defaults.** A
project pinning `"model": "claude-opus-5"` beats your personal default; your
`.local.json` beats the project. A variable already exported always beats
`.env`, so a committed `.env` cannot override a secret CI set.

Unknown keys are an error, not a shrug. An explicit `null` means "use the
default", which is why the scaffolded file can spell every option out.

#### The credential, in full

| Where | How |
| --- | --- |
| `llm.apiKey` | Inline. Allowed in the user file and `*.local.json`; **refused** in `stratigraph.config.json` |
| `llm.apiKeyFile` | Path to a file holding the key. `~` expands; relative paths resolve against the config file |
| `llm.apiKeyEnv` | Which environment variable to read — default `ANTHROPIC_API_KEY`, so a team can point at `WORK_ANTHROPIC_KEY` |
| `.env` | Sets that variable, if it is not already exported |
| — | `ANTHROPIC_AUTH_TOKEN`, or a profile from `ant auth login` |

A configured `apiKeyFile` that cannot be read is an error, rather than a quiet
fall-through to whatever else is lying around: silently using a different
credential than the one you asked for is how the wrong account gets billed.

Without a credential, `analyze` prints one line saying so — with the three
commands that would fix it — and the structural report is unchanged.

#### What you can set

The full shape is in
[`stratigraph.config.example.json`](stratigraph.config.example.json), which
ships with the package. The three worth knowing:

- **`llm.model`** — defaults to `claude-opus-5`. `--model <id>` overrides it per
  run. Whichever model *answered* is recorded on every row it writes.
- **`interpret.couplingWeight`** — decides the clustering, so `analyze` prints
  the value it used. `0` clusters on structure alone.
- **`interpret.maxClusters`** — caps how many clusters are sent to the model, so
  a large repository cannot run away with your bill.

`llm.sendSource` is off by default and loudly logged when on. Extraction and
history mining are entirely local; only the interpretation layer talks to a
model API, and only about structural metadata unless you opt in.

## Architecture

Five layers, strictly one-directional. Layers do not reach backwards;
presenters never call extractors.

```
extractors ──NDJSON──▶ fact store ──▶ history miner ──▶ interpreters ──▶ presenters
 (Java: JVM)            (SQLite)        (git log)      (clustering + LLM)   (MCP server,
 (TS: compiler API)                                                          Structurizr,
                                                                             Mermaid, SVG,
                                                                             HTML, Markdown)
```

Presenters read the store and derive nothing. `stratigraph report` opens the
database read-only, and every diagram it draws is a projection of rows that
`extract`, `history` and `analyze` already wrote — so a report cannot disagree
with the `analyze` run that produced it, and two reports of one run are
byte-identical.

Extractors are separate processes that emit newline-delimited JSON on stdout.
The core never links against a parser, which is why a JVM-only Java parser and a
Node-only Angular parser can coexist without either infecting the core
([ADR-0001](docs/adr/0001-language-split.md),
[ADR-0003](docs/adr/0003-ndjson-fact-protocol.md)). The TypeScript extractor is
Node like the core, so the boundary is enforced by the build rather than by
convention: it compiles under its own `rootDir`, and an import from `src/` into
it fails to compile.

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

### Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the conventions, and they are stricter
than most: a parser change without a fixture test does not get merged, every
non-obvious decision gets an ADR, and nothing may state a fact it cannot cite.

**The most useful contribution right now is not code.** Run it against a
repository I have never seen and tell me what it got wrong — a wrong edge, a
missed endpoint, a finding that is noise. A confidently wrong dependency map is
the failure this project is built to avoid, so a fact that should not be there
is as valuable a report as one that is missing. There is an issue template for
exactly that.

Security reports go through [SECURITY.md](SECURITY.md), never a public issue.
[CHANGELOG.md](CHANGELOG.md) is what changed and why.

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
