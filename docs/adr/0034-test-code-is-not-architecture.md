# ADR-0034: Test code is not architecture

- Status: accepted
- Date: 2026-09-28
- Milestone: M10 (before the code)

## Context

A Java package usually exists twice: `src/main/java/com/acme/order` and
`src/test/java/com/acme/order`. The extractor names nodes by fqn, so both halves
land in one `package` node, and every test's imports became the package's
dependencies. A test depends on what it tests and on its fixtures, so the
package graph grew arrows the running system does not have; a shared test
support package imported by tests everywhere and importing main code back
closed cycles that exist only in the test classpath; C4 components and class
diagrams counted test classes as parts of the system.

ADR-0030 already gives every file a role, and `file_role` is now written at
extract time (ADR-0033), so which nodes are test code is a stored fact.

## Decision

**Every structural aggregate leaves out nodes declared in a `test`-role file.**
Two SQL predicates in `src/analysis/package-graph.ts` carry the rule so every
consumer applies the same one:

- `declaredInTest(alias)` — the node's file has role `test`. Applied where edges
  are lifted to packages and modules (`ancestorOfCte`, hence the package graph,
  cycles, the dependency matrix, the C4 container and component diagrams, the
  MCP package queries), to class diagrams, to module languages and sizes, and to
  the file-to-package map co-change clustering uses.
- `testOnlyPackage(alias)` — a package declaring at least one type, every one of
  them test code. Such a package is not a node of the architecture. A package
  mixing main and test types stays, with its test types left out.

The facts are untouched: test classes, their edges and their files stay in the
store, and `find_callers` still reports a test that calls a method — a test that
breaks is part of what breaks. Structural views state how many test files were
left out in their coverage reasons.

## Alternatives considered

**Separate test nodes** (`com.acme.order (test)`), as the product plan first
sketched. Deferred: it needs a toggle to be useful and no view wants test
structure yet. Excluding and counting is the default the plan asks for; a
separate node can be added when a second concrete need appears (CLAUDE.md: no
speculative abstraction).

**Filter in the extractor.** Rejected: the extractor would then need the role
rules, which live in the core, and the facts about tests would be lost to every
consumer instead of left out of the ones that describe structure.

**Filter by edge location** (drop edges observed in test files). Covers the
source side only; a test-only package would still be a node, and a main class's
nodes are what decide main packages. The node's own file is the fact to test.

## Consequences

- Cycles closed only by test code are no longer findings.
- C4 and class diagrams shrink on most repositories. That is the correction.
- A run with no `file_role` rows (built before this ADR) excludes nothing, and
  its coverage statement already says its inventory is unknown.
