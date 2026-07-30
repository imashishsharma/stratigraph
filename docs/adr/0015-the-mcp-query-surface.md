# ADR-0015: The MCP surface — one pinned run, read-only, and what it refuses to answer

- Status: accepted
- Date: 2026-07-30
- Milestone: M4 (before the code)

## Context

M4 exposes the fact store over MCP so that an agent working inside a codebase
can ask structural questions instead of grepping for them. It is the first time
anything in this project answers a question it was not asked on a command line,
and the first time the consumer of an answer is a model rather than a person
reading a report.

That change of consumer is the whole design problem. A person reading
`analyze` output sees the section headers, the "no history mined for this run"
line, the count of pairs below the threshold — the context that says how much
was looked at. An agent calling a tool sees a JSON array. An empty array reads
as "there is no such thing" whether the truth is *we looked and found nothing*
or *nothing here was ever parsed*. The second is the confidently-wrong map
CLAUDE.md exists to prevent, arrived at by a different route: not a model
inventing an edge, but a model correctly reporting an absence that was never
established.

Three further things need settling before any tool exists:

- **What the server may do.** It sits at layer 5. Layers do not reach backwards,
  and a tool call is a very tempting place to put "…and if the database is
  stale, re-extract".
- **Which run answers a question.** A database accumulates runs. Two calls in
  one conversation landing on different runs would produce answers that contradict
  each other with both being true.
- **How interpretation travels.** Cluster names and descriptions are
  model-authored (ADR-0013). Handed to another model as plain strings they
  become indistinguishable from facts within one hop.

## Decision

### The server reads. It never writes and never extracts.

The database is opened `readonly: true, mustExist: true`. No tool triggers
extraction, history mining or analysis; a stale or empty database is reported as
what it is, with the command that would fix it. This is the layering rule
(CLAUDE.md: "presenters never call extractors") and it is also the operational
one — an MCP server is started by a client, often several at once, and a tool
call that quietly starts a JVM to parse 4,000 files is not a query.

`stratigraph mcp` therefore fails immediately, with the `init`/`extract` command
in the message, rather than creating a database on demand the way `init` does.

### One run, pinned at startup

The run is resolved once when the server starts — `--run <id>` if given,
otherwise the most recent — and every answer for the life of the process comes
from it. Every response carries `runId`, `repoPath` and `repoHead`, so an agent
that keeps notes across a session can tell whether two answers describe the same
snapshot. Re-pointing at a newer run is a restart, which is a thing clients
already know how to do.

### Every result carries its provenance, and interpretation is labelled

The same rule the report layer already follows, in a shape a caller can branch
on rather than a shape a caller can read:

- Node results carry `fqn`, `kind` and, where the extractor recorded one,
  `file` and `line`.
- Edge results carry the edge kind and the `file:line` of the call site.
- History results carry commit shas.
- Anything a model wrote — a cluster's `name` and `description` — is returned
  under an explicit `authoredBy: "model"` alongside the model id, never merged
  into the surrounding object as though it were observed. A structural answer
  never *requires* the interpretation field to make sense; it is additive.

### An empty answer says which kind of empty it is

Every tool that can return nothing distinguishes the two cases in its response,
not in its prose:

| Field | Meaning |
| --- | --- |
| `found: false` | The subject of the question is not in this run at all. |
| `results: []` with `covered: true` | It is here, we looked, there is nothing. |
| `results: []` with `covered: false` | Nothing in this run could have answered it — no extractor parsed that language, or no history was mined. |

`analyze` already makes exactly this distinction for the static graph, where a
run with no extraction reports every coupled pair as having zero static edges —
because nothing was checked, not because nothing connects them. The tool surface
inherits it. **`describe_run` exists for the same reason**: it reports what the
run contains — which extractors ran, whether history was mined, whether
interpretation ran — so a caller can establish the envelope before asking
questions inside it, rather than inferring the envelope from empty results.

### The tools

PLAN.md names seven. Two more are added, both enablers rather than features:

| Tool | Why |
| --- | --- |
| `describe_run` | The coverage envelope, above. |
| `find_node` | An `fqn` is guessable from source (ADR-0007), which is what makes the other tools usable by an agent with the file open. Guessable is not certain, and the failure mode of a wrong guess is an empty result. This turns a guess into a lookup. |

`trace_to_table` states its own limit in its description and in its output. The
Java extractor emits `maps_to` — a declared `@Entity`/`@Table` correspondence —
and does not emit `reads_table` or `writes_table`. So the trace it returns is a
mapping plus one call hop, each hop a citable edge, and it says so. A tool that
answered "which code touches this table?" by chaining call edges until something
plausible appeared would be inventing the answer it was asked for.

### stdout belongs to the protocol

Stdio transport means anything written to stdout that is not a JSON-RPC frame
corrupts the stream. `src/log.ts` already splits this correctly — `print` to
stdout for command output, `info`/`warn`/`error` to stderr — so the rule is that
the `mcp` command calls `print` nowhere, and a test asserts it.

## Alternatives considered

**Hand-roll the JSON-RPC over stdio.** Rejected, though it was close. It is
around 200 lines and would keep the dependency count at three, which matters for
a tool installed with `npx` (ADR-0004). But the milestone's acceptance criterion
is *Claude Code connects and answers correctly*, and protocol drift would show
up as "won't connect" against a client we do not control. `@modelcontextprotocol/sdk`
carries HTTP transports we never use, and that cost is accepted knowingly.

**HTTP transport as well as stdio.** Rejected for now: the client is on the same
machine as the database, stdio needs no authentication story, and a fact store
containing a private codebase's structure is not something to put on a port
before someone asks for it.

**Let tools trigger extraction when the database is stale.** Rejected — the
layering rule, and the operational one above. Staleness is *reported*
(`repoHead` versus the repository's current HEAD is a question the caller can
ask), never silently repaired.

**Answer from the latest run per call rather than pinning.** Rejected: two
answers in one conversation could then describe different snapshots, and nothing
in the transcript would show it.

**Expose the database over MCP resources rather than tools.** Rejected: the
useful unit here is a query with arguments, not a document to read. Resources
would either be one giant blob or a URI scheme reinventing the queries.

**Let the server call the model to summarise answers.** Rejected outright. The
caller *is* a model. A second one in the path would add an uncited paraphrase
between the facts and the agent, which is the exact failure the citation
contract (ADR-0013) was built to prevent.

## The acceptance run

PLAN.md's criterion for M4 is: *Claude Code, connected to the server, correctly
answers five structural questions about a repo it has never had in context.*

Run against [apache/dubbo](https://github.com/apache/dubbo) at `3a30432` — 4,053
files, 47,350 nodes, 163,693 edges, 8,893 commits, 38 clusters, `--no-llm` — with
a fresh headless Claude Code given the server and **no filesystem access to
dubbo**. Every answer was then checked by hand against the repository.

| # | Question | Answer | Verified against |
| --- | --- | --- | --- |
| 1 | What does this store describe, and what does it *not* contain? | dubbo at `3a30432`; no tables, no interpretation, Java only — and stated that empty results in those areas mean "not extracted", not "not present" | `source_file` holds 4,049 java + 4 unknown; `--no-llm` was used |
| 2 | Is there a cycle between `org.apache.dubbo.qos` and `…qos.command.util`? | Yes, with both directions cited — and the observation that the return edge is test-only, so main-source is acyclic | `QosScopeModelInitializer.java:21` and `ServiceCheckUtilsTest.java:23` read exactly as cited |
| 3 | What calls the QoS `Server`'s `start()`? | `QosProtocolWrapper#startQosServer` at `QosProtocolWrapper.java:134`, and it distinguished the QoS `Server` from the unrelated OpenAPI `Server` model | `Server.java:90` declares `start()`; that line is the only QoS `start()` call site in the repository |
| 4 | Biggest hotspot, and a file owned by one person? | `GooglePB.java` tops the arithmetic but is generated, so it named `dubbo.xsd` as the meaningful one; `MetadataInfo.java`, 73 commits, 65.8% one author | `git log --follow` gives 73 commits with 48 of them (65.75%) by that address |
| 5 | Describe `…cluster.router.condition` | 4 types, heaviest dependency `router.state` (160 references), one real consumer `ListenableStateRouter` | The directory holds exactly those 3 main types plus 1 test; `ConditionStateRouter.java:72` and `ListenableStateRouter.java:164,173` read as cited |

Two things this exercise established beyond the criterion.

**The coverage envelope changes the answers, not just the caveats.** In (1) and
(4) the model volunteered what the store could not answer before drawing
conclusions from it, and in (3) it noted that `describe_run` had been denied and
therefore it could not rule out extraction gaps. That is the behaviour
`describe_run` and the `found`/`covered` split were added for, and it is not
behaviour a prompt asked for.

**One number disagreed with `git log --follow`, and the tool was right.** Answer
(4) reported 163 commits for `dubbo.xsd` where `--follow` reports 165. The sets
differ by six commits in total: `--follow` attributes four commits to this file
that actually touched a *different* file with the same basename
(`META-INF/compat/dubbo.xsd`), and misses two that genuinely modified this one
(e.g. `588214b`). That is exactly the heuristic weakness ADR-0009 rejected
`--follow` over, now visible from the other end of the pipeline.

## Consequences

- An agent can establish what is knowable (`describe_run`) before asking what is
  true, and an empty result is never ambiguous.
- The server cannot repair a stale database, so a user who has changed code
  since the last extraction gets answers about the last extraction — clearly
  labelled with `repoHead`, and wrong about their working tree. Documented, and
  the reason `describe_run` reports the head it was built from.
- Nine tools is a large surface to keep consistent. They share one query module
  and one shape for provenance, so consistency is a code property rather than a
  discipline.
- The dependency count goes from three to four, and the install carries HTTP
  server libraries a stdio server never loads. That is the price of not owning
  a protocol implementation, and it is revisitable if the SDK's weight becomes a
  complaint.
