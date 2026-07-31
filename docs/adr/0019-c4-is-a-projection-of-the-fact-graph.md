# ADR-0019: C4 levels are a projection of the fact graph, and refuse the boxes nothing supplies

- Status: accepted
- Date: 2026-07-31
- Milestone: M6 (before the code)

## Context

PLAN.md's M6 asks for "Structurizr DSL and Mermaid output for C4 levels 1–3".
C4 is a good target: it is the diagram vocabulary most architects already read,
it has a text format with tooling behind it, and its levels correspond roughly
to the levels this store already holds.

Roughly. Not exactly, and the gap is the whole problem.

C4's level 1 is a *system context* diagram: the software system, the **people**
who use it, and the **other systems** it talks to. Level 2 is *containers*:
separately deployable or runnable things, with their technology and their
protocols. Level 3 is *components*.

The fact store contains none of the following, in any run, ever:

- a person, a role, or a user of any kind
- a deployment topology, a process boundary, or a runtime protocol
- a system outside the repository, except where a parser read a literal
  naming one
- what any container is *for*

Every C4 diagram you have ever seen has a stick figure in the top left. Drawing
one here would take about four lines of code and nobody would question it,
because that is what the diagram is supposed to look like. It would also be a
node in an architecture map that no parser, no `git log` and no build file ever
produced — which is the one thing CLAUDE.md says must never happen.

The same pressure applies at every level. "Container" invites the word
`Spring Boot Application`; the store knows the module is called `order-service`
and that its files are Java. "Component" invites a responsibility; the store
knows a package's name and its edges.

So the question is not how to draw C4. It is what to do at every point where C4
asks for something the facts do not contain.

## Decision

**The C4 model is a projection of the fact graph. Each level is an aggregation
of `node` and `edge` rows, every element and every relationship carries the
evidence that produced it, and where a level asks for something no fact
supplies, the diagram omits the box and the report says so on the page.**

An omission that is stated is a finding. An omission that is quietly filled with
a plausible box is the confidently-wrong map this project exists to avoid.

### What supplies each level

**Level 1 — system context**

| Element | Comes from | Evidence |
| --- | --- | --- |
| the system | the `run` row | repo path, `repo_head` |
| a datastore | `table` nodes, when the run has any | the `maps_to` / `reads_table` / `writes_table` edges |
| an external system | the **host** of an absolute URL in `node.attrs.httpCalls` | the call site, file and line |

One datastore box, labelled with how many tables were observed, not one box per
table — a level 1 diagram with forty cylinders on it is not a level 1 diagram.
The table names live in the level 2 evidence, where they belong.

The external systems are the interesting entry. `this.http.get('https://api.stripe.com/v1/charges')`
is a *literal a parser read*, and the host in it is as much a fact as a class
name. **Only an absolute URL produces a box.** A relative URL that matched no
endpoint is almost always an endpoint in this repository that ADR-0005 or
ADR-0018 declined to resolve, and promoting a coverage gap to "external system"
would turn a thing we failed to read into an architectural claim.

There is deliberately no "and it matched no endpoint" clause on the absolute
case, because it would be vacuous: no `endpoint` node in this store carries a
host, so an absolute URL can never match one. Writing the check anyway would
imply a discrimination the data cannot make. Note also what the box does *not*
claim — that the call reached a particular endpoint of that host. It claims the
host was named in a literal passed to an HTTP client, which is why the
relationship is `fact` rather than `inferred`, unlike the same-repository links
of ADR-0018 where the endpoint is exactly what is being guessed.

**No people.** Not "a generic user", not "an operator". The store contains no
evidence that any human being uses this software, and the report states that in
one line under the diagram rather than drawing a figure and hoping nobody asks
where it came from.

**Level 2 — containers**

One container per `module` node. Both extractors emit them — Maven and Gradle
projects from `JavaFactExtractor`, npm packages from the TypeScript extractor —
so "what are the deployable pieces" is answered by the build files, which is
where that answer actually lives.

The technology label is the set of `source_file.language` values under the
module. `Java`, or `TypeScript`, or both. Not `Spring Boot`, not `Angular 19`,
not `REST/HTTPS` — none of that is in the store, and a version number nobody
read is exactly the kind of detail a reader would trust because it is specific.

Relationships aggregate every `edge` whose source and destination resolve to
different modules, walking `parent_id` upward the same way the package graph
already does. `http_calls` edges are `confidence = 'inferred'` (ADR-0018) and
are drawn dashed and labelled, at every level they appear.

**Level 3 — components**

Per container: its packages, and the dependencies between them. This is
`buildPackageGraph` partitioned by module — no new aggregation, and therefore no
second definition of "depends on" that could drift from the one the cycle
detector uses. Relationship evidence comes from `supportingEdges`, which already
returns the file and line of each underlying reference.

Where clusters exist (ADR-0012) they become boundary groups. A cluster's **name
and description are model-authored**, so those elements are marked as inference
in the model, rendered with a visible marker, and explained in the legend. A
cluster with no model name shows its package prefix instead — which is
observation, and reads as such.

### Every element carries its evidence

The C4 model type is not `{id, name, kind}`. Every element and every
relationship holds the rows that produced it, and each output format has to keep
them:

- the HTML report prints them under the diagram as `path:line`
- the Structurizr DSL puts them in each element's and relationship's
  `properties { }` block
- Mermaid has nowhere to put them, so the `.mmd` files are the one output that
  drops evidence, and the HTML embeds every diagram's Mermaid source next to the
  evidence rather than instead of it

A diagram whose boxes cannot be traced back to a line of code is a picture, not
an analysis.

## Alternatives considered

**Ask the model to assemble the C4 model.** Rejected outright, and it is the
obvious thing to try — an LLM shown the package graph would produce a beautiful
level 1 with users, external systems and crisp container names. Every box on it
would be a fact produced by a model. This is the specific prohibition in
CLAUDE.md, and the fact that the output would be *better looking* is precisely
why the rule exists.

**Let the user declare the missing pieces in config** — people, external
systems, container technologies. Rejected for M6, deferred rather than closed.
It is legitimate (a human asserting something they know is not the tool
inventing it), and it would produce genuinely complete C4. But it needs a
provenance kind the schema does not have — `declared-by-operator`, distinct from
both `fact` and `inferred` — and inventing that to make a milestone's diagram
prettier is the schema change CLAUDE.md says to ask about rather than make. The
report states what is missing, which is the input to that conversation.

**Skip level 1 entirely, since it is nearly empty.** Rejected. A level 1 diagram
showing one system, its datastore, and a line saying "no user or external system
appears in any fact in this run" is a *useful* output: on a repository that
turns out to call four third-party APIs, that box count is the first thing a
reader wants. Emptiness is information when it is labelled.

**Map C4 levels to clusters instead of modules.** Rejected for level 2.
Clusters are a partition of packages by graph structure — a good answer to
"what belongs together", and a bad answer to "what gets deployed". A cluster
also has no build file behind it, so a container derived from one would be a
grouping the model named, sitting at the level where readers most expect to see
real deployables. Clusters do their proper work at level 3.

**Emit Structurizr's own `!docs` / autolayout and let its tooling place the
boxes.** Rejected as the only renderer, kept as an output. The DSL is written
and it works, but a report that requires the reader to install Structurizr to
see anything is not a report. See ADR-0020.

## Consequences

- Level 1 is thin on most repositories, and on some it is one box and a
  sentence. That is an accurate picture of what static analysis of a source tree
  can tell you about a system's context, and the alternative was a prettier
  diagram with invented boxes on it.
- Container technology labels are duller than the ones a human would write. A
  reader who wants "Spring Boot" can see it in the evidence; the box says what
  was observed.
- The projection has no state of its own. Nothing in `src/present/` writes to
  the database, so a report can be regenerated from any stored run at any time,
  and two reports from the same run are byte-identical.
- Because every element carries evidence, adding a fourth output format is
  mechanical, and no format can accidentally launder an inference into a fact —
  the `inference` flag travels with the element rather than being reapplied by
  each renderer.
- The one honest weakness: `module` nodes come from build files, so a repository
  with a single Maven module and a single npm package gets a level 2 with two
  boxes on it. That is correct — it is a monolith and a front end — but it means
  level 2 is only as informative as the target's build layout, and a 400k-line
  single-module monolith gets one container. Level 3 is where its structure
  shows.
