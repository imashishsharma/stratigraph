# ADR-0041: A split package is one node with a `contains` edge from each module

- Status: accepted
- Date: 2026-09-28
- Milestone: M14 (before the code)
- Amends: ADR-0007 (containment)

## Context

ADR-0007 made a package's `fqn` its dotted name and expressed containment with
`NodeFact.parent` only. A package declared in two modules — `com.acme.util` in
both `core` and `extra`, which is common in enterprise builds and legal on the
classpath — is emitted once, with the `parent` of whichever module's file the
extractor happened to read first. The writer's `ON CONFLICT DO NOTHING` then
keeps that first answer. Every type in the second module's half of the package
was attributed to the first module: the container diagram drew edges from the
wrong box, and module sizes were wrong in both.

## Decision

**The package keeps one node and one identity. Where it is split, membership
is stated by `contains` edges, one from each module that declares a source file
in it.**

- The package `fqn` is unchanged, so every `imports` edge, every MCP query and
  every stored finding that names it still resolves (ADR-0007's reason for
  leaving the module out of type names applies equally to packages).
- When the Java extractor sees a package in a second module, it emits a
  `contains` edge `module → package` for **each** module declaring it,
  cited at the package declaration of the first file it saw in that module, and
  an `info` diagnostic naming the modules. An unsplit package gets no edge:
  there `parent` already says everything, and ADR-0007 declined to duplicate it.
  This is the case ADR-0007 reserved the `contains` kind for — containment that
  is not a tree.
- `parent` stays the first module, because the column needs a value and a
  stored run should not change meaning. Nothing that assigns a type to a
  module reads it for a split package any more.
- **A type's module is found from its package**: `parent` when the package is
  not split; when it is, the `contains` module whose `root` (ADR-0040) is the
  nearest directory above the type's file — the same nearest-root rule the
  extractor itself used to pick the module. One SQL fragment
  (`ancestorOfCte('module', …)` in `src/analysis/package-graph.ts`) carries the
  rule, so the container diagram, module sizes and languages agree.
- A split package appears in the level 3 diagram of every container it belongs
  to.

## Alternatives considered

**Scope package identity by module** (`com.acme:core/com.acme.util`). Rejected:
an `import` names no module, so every import edge would have to guess which
half it meant — the same reason ADR-0007 rejected module-scoped type names.

**A package node per module half, with a shared parent.** Rejected: it
introduces a node kind the package graph does not know, and splits the
package's dependencies in two where the classloader sees one package.

**Derive splits in the core from file paths alone.** Rejected as the only
mechanism: it would put a third copy of the nearest-root rule in the core
with nothing in the store to say a split happened. The `contains` edge makes
the split a cited fact; the core still needs `root` to place each type, which
is why both exist.

## Consequences

- Split packages are visible in the facts and the diagnostics, not only as a
  side effect in a diagram.
- Stores written before this ADR have no `contains` edges and no `root`
  attributes; they read exactly as before.
- The TypeScript extractor never splits a package: its package is a directory
  inside one module (ADR-0042), so the rule costs it nothing.
