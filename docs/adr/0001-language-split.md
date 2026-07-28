# ADR-0001: Language split — TypeScript core, per-language extractor processes

- Status: accepted
- Date: 2026-07-28
- Milestone: M0

## Context

The tool must read Java (Spring Boot, Maven and Gradle) and TypeScript (Angular)
with enough fidelity to produce type-attributed call and injection graphs.

The best available parsers do not live in one language:

- Java: OpenRewrite's LST is type-attributed, understands whole builds, and
  handles both Maven and Gradle. It is JVM-only.
- Angular: resolving DI, standalone components, NgModules, routes and template
  bindings requires the TypeScript compiler API plus `@angular/compiler-cli`.
  Both are Node-only.

The MCP SDK is also best supported in TypeScript.

## Decision

- The Java extractor is written in Java, because OpenRewrite is JVM-only.
- Everything else — core, fact store, history miner, interpreters, presenters,
  MCP server — is TypeScript.
- **Extractors are separate processes.** They emit newline-delimited JSON facts
  on stdout and human-readable logs on stderr. The core never links against a
  parser and never loads one in-process.

## Alternatives considered

**Everything in Java.** OpenRewrite in-process, and Angular parsed by a
JVM-hosted JS engine or a hand-written TS parser. Rejected: no JVM-side parser
resolves Angular DI correctly, and the MCP ecosystem would fight us.

**Everything in TypeScript.** Use `java-parser` or tree-sitter-java instead of
OpenRewrite. Rejected: neither gives type attribution or build awareness, so
`service.doThing()` cannot be resolved to a declaration. The output would be
name-matching dressed up as a dependency graph — precisely the confidently wrong
map the project exists to avoid.

**One process, JNI / GraalVM polyglot.** Rejected: puts a JVM inside the core,
which CLAUDE.md forbids, and makes a crash in one parser a crash of the whole
run.

**Language server protocol instead of a custom fact protocol.** Rejected: LSP is
built for editor interactions, not bulk whole-repo fact extraction, and would
constrain the fact vocabulary to what LSP happens to model.

## Consequences

- A parser crash or OOM kills one extractor, not the analysis. Partial results
  survive and the failure is recorded as a diagnostic.
- Extractors can be run by hand and their output captured, diffed, and replayed
  (`stratigraph ingest --from facts.ndjson`). This makes fixture testing exact.
- Someone can add an extractor for a language we have never heard of without
  touching the core, in whatever language that ecosystem's parser lives in.
- Cost: an IPC boundary and a serialization format to maintain, and users of the
  Java extractor need a JVM available. See ADR-0004 for how that is kept from
  being the user's problem.
