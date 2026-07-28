# ADR-0007: Fact identity — how a node's `fqn` is formed

- Status: accepted
- Date: 2026-07-29
- Milestone: M1 (before the code — every later milestone joins on this)

## Context

`NodeFact.fqn` is the identity of everything in the fact store. The schema
enforces `UNIQUE (run_id, kind, fqn)`, edges refer to nodes by `{kind, fqn}`
rather than by row id, and `src/facts/writer.ts` creates a stub node the first
time an edge names an `fqn` nothing has declared. The comment in
`src/facts/types.ts` says it outright: "the extractor owns this identity".

That makes the naming scheme load-bearing in a way that is easy to
under-estimate. Consequences of getting it wrong show up late and everywhere:

- Two extractors (Java now, TypeScript at M5) must agree on the shape, or
  cross-stack edges cannot be expressed at all.
- The history miner joins facts to file paths; the interpretation layer cites
  node ids; the MCP server at M4 takes an `fqn` as a query argument typed by a
  human or an agent. If the scheme is not guessable, M4 is unusable.
- Overloaded methods are *different* methods. A scheme that cannot tell
  `findById(Long)` from `findById(String)` silently merges two call graphs.

This wants deciding once, in writing, rather than emerging from whatever the
first extractor happened to do.

## Decision

| kind | `fqn` | example |
| --- | --- | --- |
| `module` | Maven `groupId:artifactId`; otherwise the repo-relative directory | `com.example:shop-web`, `.` |
| `package` | dotted package name; the default package is `<default>` | `com.example.shop.web` |
| `class` `interface` `enum` `annotation` | JVM binary name: dotted package, `$` before a nested type | `com.example.shop.web.OrderController`, `com.example.Outer$Inner` |
| `method` | `<owner>#<name>(<params>)` | `com.example.shop.service.OrderService#findOne(java.lang.Long)` |
| `field` | `<owner>#<name>` | `com.example.shop.domain.Order#customerRef` |
| `endpoint` | `<HTTP-METHOD> <path>` | `GET /api/orders/{id}` |
| `table` | the table name, lower-cased | `orders` |

Rules that the table alone does not settle:

- **`#` separates a member from its owner.** `.` is already doing two jobs
  (package separator, nested-type separator in source form); a third would make
  `com.example.Order.id` ambiguous between a field and a class. `#` is what
  Javadoc and JLS references use, so it is the least surprising choice.
- **`$` for nested types**, matching the JVM binary name. It is what a stack
  trace prints and what the `.class` file is called, so an `fqn` can be pasted
  into a log search.
- **Method parameters are erased and fully qualified**, comma-separated, **no
  spaces**. Generics erase to their bound (`T extends Number` → `java.lang.Number`,
  bare `T` → `java.lang.Object`); varargs become the array type
  (`String...` → `java.lang.String[]`). Erasure is what makes the name stable
  under the type information we actually have, and matches how the JVM itself
  distinguishes overloads.
- **Constructors are `<init>`, static initialisers `<clinit>`.** Same reason:
  these are their JVM names.
- **A `table` fqn is lower-cased** because SQL identifiers are conventionally
  case-insensitive and `@Table(name = "Orders")` and `orders` must not become two
  tables. The declared spelling is preserved in `NodeFact.name`.
- **Endpoint paths are recorded as declared**, including the framework's own
  placeholder syntax (`{id}`), with the class-level prefix concatenated to the
  method-level suffix and duplicate slashes collapsed. The scheme is
  framework-neutral on purpose: Spring MVC's
  `@RequestMapping(method = RequestMethod.GET)`, Boot's `@GetMapping` and
  JAX-RS's `@Path` + `@GET` all land on the same shape, with the observed
  framework recorded in `attrs.framework`.

### Containment

Containment is expressed with `NodeFact.parent` only — package → type → member,
and module → package where a module is known. `src/facts/writer.ts` maps it to
`node.parent_id`. We do **not** also emit `contains` edges: they would duplicate
`parent_id` exactly, double the edge table, and create a second thing to keep
consistent. The `contains` edge kind stays in the vocabulary for a future
extractor whose containment is not a tree.

### Duplicate declarations are reported, not silently merged

A type `fqn` deliberately does not include its module, because an `import`
statement does not name one — including it would make imports unresolvable.
The consequence is that two modules declaring the same fully-qualified type
(vendored copies, a forked utility class, shaded sources) collide on one node.

That is the same thing the JVM classloader does, but it is not obviously right,
and it must not be invisible. **When a type `fqn` is declared in more than one
file, the extractor emits a `warn` diagnostic naming both files.** The node
merges; the report can say so.

## Alternatives considered

**Use the row id and let names be attributes.** Rejected: the writer's stub
mechanism requires an extractor to name a node it has not emitted — a call into
a class in another file, or into a jar we never read. A content-independent id
cannot do that.

**Include the source file path in the `fqn`.** Rejected: it makes identity
unstable under a file move, breaks the moment two extractors must agree, and
makes an `import` statement unresolvable to the class it names.

**Include the module in a type's `fqn`** (`com.example:shop-core/com.example.Order`).
Rejected for the reason above — imports carry no module — but it is the honest
answer to the duplicate-declaration problem, which is why that problem gets a
diagnostic instead.

**Full JVM descriptors for methods** (`findOne(Ljava/lang/Long;)Lcom/example/Order;`).
Rejected: precise and unreadable. An `fqn` will be typed by a human and by an
agent at M4; `#findOne(java.lang.Long)` is both unambiguous among overloads and
legible. The return type is not part of the identity because Java does not
overload on it.

**Keep the source form of nested types** (`Outer.Inner`). Rejected: it collides
with the field/class ambiguity that `#` and `$` exist to remove.

## Consequences

- Overloads are distinct nodes, so call graphs do not silently merge.
- An `fqn` is guessable from source, which is what makes the M4 MCP server
  usable by an agent that has the file open but not the database.
- Erasure means a call to `List<Order>#get(int)` and `List<String>#get(int)`
  land on the same method node. Correct — they are the same method — but it
  means generic instantiation is not recoverable from the graph.
- The `<default>` package will appear on old codebases. It is a real package and
  gets a real node rather than being dropped.
- Changing any of this after M1 is a data migration, not an edit. That is the
  point of writing it down before the extractor exists.
