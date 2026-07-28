# CLAUDE.md — Codebase Archaeologist

## What this project is

A tool that reads a large enterprise codebase (Java/Spring Boot and Angular) plus its
git history, and produces: a domain map, a dependency and coupling graph, C4 diagrams,
a ranked list of structural problems, and an MCP server so an agent can query the
codebase's structure directly.

Target: monoliths and multi-module builds of 100k+ LOC where nobody remembers why
things are the way they are.

## The inviolable rule

**Static analysis produces facts. The LLM produces interpretation. The LLM never
invents a fact.**

- Every node and edge in the graph comes from a parser, from `git log`, or from a
  build file. Never from a model inference.
- Every claim in any generated report must carry a provenance reference: file path
  and line, or a commit SHA, or a fact-table row id.
- If the model wants to assert a relationship it cannot cite, the correct output is
  "no evidence found", not a plausible guess.
- Interpretation layers (naming a cluster, describing a responsibility, flagging a
  smell) are clearly marked as inference in both the data model and the UI.

A confidently wrong dependency map is worse than no map. This rule is not negotiable
and should not be relaxed to make a milestone pass.

## Architecture

Five layers, strictly one-directional:

1. **Extractors** — produce facts. Java extractor uses OpenRewrite's LST
   (type-attributed, whole-build, handles Maven and Gradle). TypeScript/Angular
   extractor uses the TypeScript compiler API plus `@angular/compiler-cli` to resolve
   DI, standalone components/NgModules, routes, and template bindings.
2. **Fact store** — SQLite (DuckDB if analytics get heavy). Nodes: package, class,
   method, endpoint, table, component, service, route. Edges: calls, injects,
   implements, extends, reads-table, writes-table, http-calls.
3. **History miner** — `git log` derived metrics: churn, co-change coupling
   (files that change together without a static dependency), hotspots
   (churn x complexity), author concentration / bus factor.
4. **Interpreters** — graph clustering, then LLM naming and description of clusters,
   intent-vs-structure mismatch detection, ADR candidate generation. All outputs
   carry citations into layer 2/3.
5. **Presenters** — Mermaid and Structurizr DSL diagrams, static HTML report, ranked
   findings, and an MCP server exposing structured queries.

Layers do not reach backwards. Presenters never call extractors.

## Language split

- Java extractor: Java (OpenRewrite is JVM-only).
- Everything else: TypeScript (the Angular extractor needs the TS compiler API
  anyway, and the MCP SDK is best supported there).
- Extractors are separate processes that emit newline-delimited JSON facts to stdout.
  The core never links against a parser.

Record this as ADR-0001 with the alternatives considered.

## Conventions

- Test-first for anything in the fact layer. A parser change without a fixture test
  does not get committed.
- Fixture repos live in `fixtures/`, are tiny and hand-written, and assert exact
  fact output.
- Small commits, conventional commit messages.
- **No `Co-Authored-By` or agent-session trailers in commit messages.** They turn
  the assistant into a listed GitHub contributor, which misrepresents authorship
  of the project.
- No speculative abstraction. Two concrete implementations before extracting an
  interface.
- Every non-obvious decision gets an ADR in `docs/adr/`. This project dogfoods the
  practice it is meant to support.

## Data handling

This tool is generic and open source. It must never contain anything
Relatient-specific: no domain names, no schema fragments, no sample data, no
customer-derived fixtures.

Extraction and history mining run entirely locally with no network access. Only the
interpretation layer calls a model API, and it must be possible to run the whole
pipeline with interpretation disabled (`--no-llm`) and still get a useful report.
The interpretation layer sends structural metadata by default; sending raw source
bodies requires an explicit `--send-source` flag that is off by default and loudly
logged.

## When to ask instead of proceeding

- A milestone's acceptance criteria are ambiguous.
- A change would require the LLM to produce a fact.
- A dependency would add a heavyweight runtime (a database server, a JVM in the core,
  a browser).
- Schema changes to the fact store after M1.

Otherwise proceed and show the diff.
