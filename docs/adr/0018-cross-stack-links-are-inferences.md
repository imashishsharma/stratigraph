# ADR-0018: A cross-stack link is an inference, and matched conservatively

- Status: accepted
- Date: 2026-07-31
- Milestone: M5

## Context

PLAN.md's M5 asks for "cross-stack edges where an Angular service calls a Java
endpoint — match on URL patterns, mark as inferred, not fact." Those edges are
the single most valuable thing this tool can produce on a full-stack monolith:
they answer "if I change this endpoint, what breaks in the UI?", which on a
100k-line codebase nobody can currently answer at all.

They are also the most dangerous thing it can produce, and for exactly the same
reason. Every other edge in the store came from a parser looking at a
declaration. This one comes from comparing two strings that were written years
apart by different people, and there is no declaration anywhere that says they
are connected. CLAUDE.md's rule is unambiguous about what that makes it:
interpretation, not fact.

Three questions have to be settled before any matching happens.

**Where does it run?** The TypeScript extractor has never seen a Spring
endpoint — it is a separate process pointed at the same repository, and ADR-0001
keeps it that way. It cannot possibly resolve a URL to something it has no
knowledge of.

**What counts as a URL?** `this.http.get('/api/orders')` is legible.
`this.http.get(this.base + path)` is not, and neither is
`this.http.get(API.orders.byId(id))`. Real Angular code is full of both.

**What happens when a URL matches more than one endpoint?** A repository with
`GET /api/orders/{id}` and `GET /api/orders/summary` gives the literal
`/api/orders/summary` two plausible matches, and only one of them is right.

## Decision

**Matching runs in the core, during `analyze`, over facts both extractors have
already written into one run.** Not in an extractor, which cannot see the other
stack; and not as a new command, because nothing yet justifies one.

`src/analysis/http-links.ts` reads the observed calls the TypeScript extractor
recorded on each method (`attrs.httpCalls`), matches them against `endpoint`
nodes, and writes `http_calls` edges with **`confidence = 'inferred'`**. The
schema has carried that column since M0 for precisely this, and
`src/analysis/package-graph.ts` already filters on `confidence = 'fact'` — so a
package cycle can never be assembled out of a guess, without any change here.

### The matching rules

1. **Only a literal URL is matched.** A plain string literal is itself; a
   template literal keeps its literal segments and each `${…}` becomes a
   single-segment wildcard. Anything else — a concatenation, a variable, a
   helper call — produces a diagnostic at the call site and **no edge**. The
   extractor makes this decision, at the one moment the syntax is visible.
2. **A path parameter matches exactly one segment.** Spring's `{id}` and
   Angular's interpolated `{}` are both wildcards, and `/api/orders/{id}` does
   not match `/api/orders/1/lines`. Spring's `**` matches any remainder, and is
   the only thing that does.
3. **Query strings and trailing slashes are dropped** before comparison. Neither
   is part of what a `@GetMapping` declares.
4. **The most specific match wins**: fewest wildcards consumed, so
   `/api/orders/summary` prefers the literal endpoint over `/api/orders/{id}`.
   This is the same rule Spring's own `AntPathMatcher` applies at runtime, so
   the tool agrees with the framework rather than inventing a policy.
5. **A genuine tie produces no edge and a diagnostic naming every candidate.**
   Two endpoints equally specific for one URL means we do not know which is
   called. Emitting both would assert two dependencies where there is one;
   emitting either would be a coin toss presented as analysis.
6. **A URL matching nothing produces no edge and no diagnostic.** It is almost
   always a call to a service outside the repository, which is not a defect and
   not worth a line of output per occurrence.

### Where the inference is visible

`analyze` prints how many calls were linked, how many were ambiguous and how
many matched nothing, so the ratio is on screen rather than buried. Every
consumer that renders an `http_calls` edge must label it as inference; the
`confidence` column is how, and it is not nullable.

## Alternatives considered

**Emit an `endpoint` node for the observed client-side URL and link to that.**
Rejected. `/api/orders/5` is not an endpoint anyone declared, and putting it in
the `node` table next to endpoints a parser read out of `@GetMapping`
annotations would make the fact table contain a thing nobody wrote. The store's
value is that everything in it was observed somewhere.

**Emit all candidates on a tie, each marked inferred.** Rejected, and it is the
tempting one — it never loses a real edge. But "this component depends on both
of these endpoints" is a stronger claim than "one of these two, we cannot tell",
and the store has no way to say the second. A diagnostic can.

**Match on the last path segment, or on a similarity score.** Rejected. It would
link `/api/orders` to `getOrders()` on name resemblance, which is the
name-matching-dressed-up-as-a-dependency-graph that ADR-0001 already rejected
for Java, and it would be right often enough to be trusted and wrong often
enough to be dangerous.

**Resolve `this.base + path` by constant-folding the class's fields.** Rejected
for M5, though it is the most defensible extension: `private base = '/api'` is
right there and a narrow fold over string-literal fields in the same class would
resolve a real share of real code. It is deferred rather than closed, because
the first version of this should under-report while the matching rules earn
trust. The diagnostic already names every call site it would fix.

**Have the interpretation layer propose the links.** Rejected outright. This is
string matching with a deterministic answer; handing it to a model would convert
a checkable rule into an unfalsifiable one, and the model would have no evidence
to cite beyond the same two strings.

## Consequences

- The most valuable edges in the store are the least trusted ones, by
  construction, and every report that shows them has to say so. That is the
  correct discomfort.
- Coverage is deliberately partial. A codebase that builds its URLs through a
  constants file gets few links and a diagnostic per call site — an honest
  "could not read this" rather than a confident wrong answer.
- The rules are checkable by hand, which is what makes M5's acceptance criterion
  meaningful: every inferred edge can be opened at its cited line and compared
  against the `@GetMapping` it claims to reach.
- Both stacks must be extracted into one run for any of this to exist. That is
  what `stratigraph extract` now guarantees, and a run holding only one stack
  produces zero links rather than a wrong number of them.
