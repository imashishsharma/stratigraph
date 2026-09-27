# ADR-0042: An Angular package is a structural boundary, not a directory; service calls are edges

- Status: accepted
- Date: 2026-09-28
- Milestone: M14 (before the code)
- Amends: ADR-0017 (the `package` row only)

## Context

ADR-0017 made every directory holding TypeScript a `package`. That was a
faithful mirror of the Java package, and on a real Angular application it is
noise: Angular's style guide puts each component in its own directory, so
`bitwarden/clients` produced thousands of `package` nodes, most holding one
class, and every aggregate built on packages — the package graph, cycles,
clusters, level 3 — was a picture of the directory tree.

Angular has structural units of its own, and each is written down:

- a **project** — an `angular.json` project or an Nx `project.json` (the
  "library" and "application" of the workspace);
- an **`@NgModule`** — the pre-standalone unit of compilation and of feature
  boundaries;
- a **lazy route target** — the file a `loadChildren`/`loadComponent` dynamic
  import names, which is exactly what becomes a separate bundle.

Separately, the TypeScript extractor emitted no `calls` edges at all. The Java
side has them; on the Angular side the only coupling visible was `imports` and
`injects`, so "what calls this service method" had no answer.

## Decision

### Packages

In an **Angular workspace** — the repository has an `angular.json` or a
`project.json`, or any class carries an Angular decorator from `@angular/*` —
**a file's `package` is its nearest boundary directory**, where a boundary is:

1. a module root (ADR-0017's `module`: `package.json`, `project.json`, and now
   also an `angular.json` project root);
2. a directory containing a class decorated `@NgModule` from `@angular/core`;
3. the directory of the file a `loadChildren`/`loadComponent` dynamic import
   resolves to, when that file is in the source set.

Boundaries are clipped to the file's module: a boundary above the module root
does not capture its files. A file with no boundary between it and its module
root belongs to the module root's package.

The package's `fqn` is still a repo-relative directory path (ADR-0017's scheme
unchanged); fewer directories qualify. The node carries
`attrs.boundaries: [{ kind, file, line? }]` — `module-root`, `ngmodule` or
`lazy-route` — citing what made the directory a boundary. **No other identity
changes**: types, members, routes and module paths are exactly ADR-0017's, so
every edge between declarations is untouched and only the package they roll up
to moves.

A repository with no Angular in it keeps directory packages: a plain
TypeScript tree has no declared unit smaller than the package, and collapsing
it to one node per `package.json` would lose all its structure.

### Calls

A `calls` edge is emitted from a class member, a module function or an exported
module binding to a **class method declared in the source set**, when the type
checker resolves the call's callee to that method's declaration. The edge is
cited at the call site's line and carries `resolution: "checker"`. A callee that
resolves to an interface member, a function-typed property, a library, or
nothing at all produces no edge: the checker naming the declaration is the
fact, and anything less would be a guess about the receiver's type — the same
refusal ADR-0016 applies to `.subscribe()`.

## Alternatives considered

**A new `feature` node kind above directory packages.** Rejected: every
package-level consumer — cycles, clusters, the combined graph, MCP queries,
coverage — reads `kind = 'package'`, and a second kind would have to be taught
to each, with the directory packages still swamping every one not taught.

**Group by route (every routed component a boundary).** Rejected: eager routes
do not change what is bundled together, and a large application routes to
hundreds of components — the swamp again, one level up.

**Group only by project.** Rejected as the whole answer: an application is one
project, and its feature structure is exactly what a reader opens level 3 to
see. It is the fallback, when a project declares no NgModule and no lazy route.

## Consequences

- Package counts on Angular repositories drop by an order of magnitude; the
  M14 report gives the real numbers for `bitwarden/clients`.
- Package fqns change for Angular repositories, so a finding recognised across
  runs by a directory package (ADR-0027) will read as resolved-and-new once,
  across the upgrade. This is a major-version change already (v2.0).
- A standalone application with no lazy routes is one package per project.
  That is what it declares.
- `calls` edges feed the package graph (they are a dependency kind), so a
  service used only through method calls — never imported by type in the
  caller's package — now shows its coupling.
