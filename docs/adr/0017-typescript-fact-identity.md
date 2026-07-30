# ADR-0017: TypeScript fact identity — extending ADR-0007 to a second stack

- Status: accepted
- Date: 2026-07-31
- Milestone: M5 (before the code — the Java scheme was fixed the same way at M1)

## Context

ADR-0007 fixed how a node's `fqn` is formed and said the reason out loud: two
extractors must agree on the shape or cross-stack edges cannot be expressed at
all. That second extractor arrives at M5, and the scheme ADR-0007 wrote down is
Java's. It settles nothing about a TypeScript class.

It also contains a rule that cannot survive the crossing. ADR-0007 rejected
putting a source file path in an `fqn`, on the grounds that it "makes identity
unstable under a file move, breaks the moment two extractors must agree, and
makes an `import` statement unresolvable to the class it names".

**That reasoning inverts for TypeScript.** A Java `import` names a
package-qualified type and never a file, so the file is redundant. A TypeScript
`import` names a *file* — `import { OrderService } from './order.service'` —
and the same class name recurs in every feature directory of a large Angular
app. Here the module path is not incidental to identity; it *is* identity, and
it is what makes an import resolvable. Omitting it would merge every
`ListComponent` in the repository into one node.

So the exception needs stating explicitly, with its reasoning, rather than
being introduced quietly by whatever the TypeScript extractor happened to do.

## Decision

The **module path** of a TypeScript declaration is its repo-relative path with
forward slashes and the extension removed: `src/app/orders/order.service`.
`index.ts` keeps its segment (`src/app/orders/index`) rather than collapsing to
its directory, which is already the `fqn` of that directory's `package` node.

| kind | `fqn` | example |
| --- | --- | --- |
| `module` | `name` from the nearest `package.json`, else `name` from `project.json`, else the repo-relative directory | `@bitwarden/web-vault`, `.` |
| `package` | repo-relative **directory** path, forward slashes; the repository root is `.` | `src/app/orders` |
| `class` `interface` `enum` | `<module path>:<TypeName>` | `src/app/orders/order.service:OrderService` |
| `method` (member) | `<owner>#<name>()` | `src/app/orders/order.service:OrderService#find()` |
| `method` (module-level function) | `<module path>#<name>()` | `src/app/core/guards#canActivateAdmin()` |
| `field` | `<owner>#<name>` | `src/app/orders/order.service:OrderService#http` |
| `route` | the resolved full path, leading slash | `/orders/:id` |

Rules the table alone does not settle:

- **`:` separates a module from a declaration; `#` separates a member from its
  owner.** ADR-0007 gave `#` the second job and it must not be overloaded with
  the first, or `src/app/orders#OrderService` would be ambiguous between a class
  in a module and a module-level function. `:` is otherwise used only in a Maven
  `module` `fqn`, a different `kind`, so nothing collides.
- **A module-level function is a `method` whose owner is the module.** The
  vocabulary has no `function` kind and does not need one: a route guard written
  as a standalone function and one written as an injectable class method are the
  same thing to every analysis downstream, and `<module>#<name>()` versus
  `<module>:<Type>#<name>()` keeps them distinguishable by eye.
- **Parameters are not part of a method `fqn`**, which is the sharpest
  divergence from ADR-0007 and is deliberate. TypeScript overload *signatures*
  share one implementation and one runtime function; there is nothing to call
  separately, so there is nothing to distinguish. The consequence ADR-0007
  worried about — two call graphs silently merging — does not arise, because
  they were never two.
- **Nested declarations use `.` inside the declaration part**: a class in a
  namespace is `src/app/legacy:Api.Client`. `$` would be a lie — there is no
  binary name to match, and nothing prints `Api$Client` in a TypeScript stack
  trace.
- **A default export is `default`**: `src/app/thing:default`. An anonymous class
  expression assigned to a binding takes the binding's name.
- **Route paths are recorded resolved**, with each ancestor's `path` prefixed
  through `children`, duplicate slashes collapsed, and the framework's own
  placeholder syntax kept as declared (`:id`, `**`). This mirrors ADR-0007's
  treatment of endpoint paths exactly, and keeps an Angular `route` legible next
  to a Spring `endpoint` when M5's cross-stack linker puts them side by side.
- **`package` nodes are parented to their `module`, not to the enclosing
  directory.** Flat, as the Java extractor already emits packages, so
  `src/analysis/package-graph.ts` and Louvain need no change to work on
  TypeScript.

### Two things that can collide, and what happens

ADR-0007 established the principle: a merge is acceptable, an *invisible* merge
is not.

- **A static and an instance member with the same name.** TypeScript permits
  `class A { static x = 1; x = 2 }` because statics live on the constructor;
  Java forbids it, which is why ADR-0007 never had to decide. The two merge onto
  one node carrying `attrs.static`, and **the extractor emits a `warn`
  diagnostic naming the file and line of both**. Encoding staticness into the
  `fqn` was rejected: it would make every member `fqn` less guessable to pay for
  a case that is close to nonexistent in real code.
- **Two route tables declaring the same resolved path**, which lazy-loaded
  feature modules make easy. Same treatment: one node, a `warn` diagnostic
  naming both declarations.

### Java and TypeScript `fqn`s do not overlap

A TypeScript type `fqn` always contains `/` and `:`; a Java one contains
neither. This falls out of the scheme rather than being enforced, and it is not
relied upon for correctness — `node` is unique on `(run_id, kind, fqn)` and both
extractors emit `class` nodes — but it means that reading a mixed repository's
node table, or an MCP answer drawn from one, never leaves you guessing which
stack a name came from.

## Alternatives considered

**Reuse ADR-0007's scheme unchanged**, treating the directory path as a dotted
package and the class name as its member: `src.app.orders.OrderService`.
Rejected: directory names contain characters a dotted scheme cannot survive
(`@bitwarden/common`, `data-access`), two files in one directory can export the
same name, and an `fqn` stops resembling anything a person could paste into an
editor's file finder.

**Use the TypeScript compiler's own symbol identity** (`ts.Symbol` and its
declaration positions). Rejected for the reason ADR-0007 rejected row ids: an
extractor must be able to *name* a node it has not emitted, so that
`src/facts/writer.ts` can stub it. A symbol we never resolved has no identity to
borrow.

**Include the module in a type's `fqn`** (`@myorg/web|src/app/x:Thing`).
Rejected for ADR-0007's reason, which does transfer: an import does not name a
module, and a path alias (`@myorg/data-access/orders`) resolves to a file, not
to a package identity.

**Keep the file extension** (`src/app/orders/order.service.ts:OrderService`).
Rejected: an import never writes the extension, so keeping it means every
consumer of an `fqn` — the MCP server at M4, a person typing one — has to add
back a suffix the source never shows them. It also makes a `.ts` file and its
`.js` sibling look like unrelated declarations.

**Give routes a synthetic id and put the path in `attrs`.** Rejected: it makes
the most queryable thing about a route unqueryable by name, and breaks the
symmetry with `endpoint` that the cross-stack linker depends on.

## Consequences

- An `fqn` is guessable from a file path and a class name, which is what keeps
  the M4 MCP surface usable by an agent that has the file open but not the
  database.
- Identity moves when a file moves. That is a real cost and it is accepted:
  identity has to be *something*, and in a language whose imports are paths,
  a moved file genuinely is a different module. The history miner tracks renames
  independently (ADR-0009) and keeps the file-level story continuous across a
  move even though the node `fqn` does not.
- Two extractors now write `class` nodes into one table with schemes that share
  no separator conventions beyond `#`. Anything that parses an `fqn` rather than
  treating it as opaque has to handle both — `lastSegment` in
  `src/facts/writer.ts` already does, and is the only such place.
- ADR-0007's table is now the Java half of the scheme rather than the whole of
  it. Neither ADR is complete alone; this one names that explicitly so the next
  extractor's author reads both.
