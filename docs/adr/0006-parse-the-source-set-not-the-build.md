# ADR-0006: Parse the source set, not the build

- Status: accepted
- Date: 2026-07-29
- Milestone: M1 (before the code — this determines what the extractor can know)

## Context

CLAUDE.md describes the Java extractor as using "OpenRewrite's LST
(type-attributed, whole-build, handles Maven and Gradle)". OpenRewrite's
canonical way to get that is `rewrite-maven-plugin` or `rewrite-gradle-plugin`:
the build runs, dependencies resolve, and the LST comes back fully
type-attributed, including types from third-party jars.

That is the highest-fidelity option, and it is unavailable on most of the
codebases this tool exists for.

The target is "monoliths and multi-module builds of 100k+ LOC where nobody
remembers why things are the way they are". Those repositories routinely:

- resolve dependencies from a private Nexus or Artifactory that is unreachable
  from wherever the analysis is being run;
- do not currently compile, which is often *why* someone is pointing an
  archaeology tool at them;
- build with Ant, or with a Maven build whose parent POM lives in another
  repository;
- have no build file at all, because the deployable is assembled by a script
  nobody has read since 2014.

There is a second, quieter problem. Running the target project's build means
executing arbitrary code from the repository under analysis — plugin
executions, `maven-antrun-plugin` tasks, Gradle build scripts. "Extraction runs
entirely locally" is about data not leaving the machine; it should also mean
that pointing this tool at a repository does not run that repository.

## Decision

**The extractor parses the source set. It does not run, resolve, or otherwise
execute the build.**

Concretely:

1. **Discovery walks the filesystem for `.java` files**, honouring the config's
   `include`/`exclude`. It does not glob `src/main/java`. Legacy layouts —
   `src/`, `source/`, `java/`, `WebContent/WEB-INF/src`, or sources sitting at
   the repository root — are found because nothing keys off the path.
2. **Build files supply module identity where they exist, and nothing else.**
   `pom.xml` is read as plain XML for `groupId`/`artifactId`/`<modules>`;
   `build.gradle[.kts]` and Ant's `build.xml` for a name. We deliberately do
   *not* use OpenRewrite's `MavenParser`, which resolves parent POMs over the
   network. **A repository with no build file is a normal case, not an error**:
   it becomes one module named for its directory.
3. **One parse pass over every discovered source with a shared
   `JavaTypeCache`.** Because all first-party sources are parsed together, types
   resolve across module boundaries — a call from module B into module A's class
   attributes correctly even though A's jar was never built.
4. **Third-party types stay unresolved, and say so.** A supertype, annotation or
   invocation target that resolves to nothing outside the parsed source set
   becomes an `is_stub` node (the schema has carried `node.is_stub` since M0
   precisely for this) or, for invocations, no edge at all plus a diagnostic.
   We never guess what an unresolved symbol referred to.
5. **A file that fails to parse produces an `error` diagnostic and the run
   continues.** Partial results beat no results, and a repository containing one
   file of Java 1.4 that the parser chokes on must still yield a map of the other
   99,000 lines.

### What this costs, stated plainly

Without a classpath the extractor cannot see:

- **meta-annotation chains.** A team's custom `@ApplicationService`
  meta-annotated `@Service` is not recognisable as a stereotype from source
  alone. ADR-0005 already committed to this: unrecognised annotation, no
  stereotype fact.
- **inherited members from third-party supertypes.** A repository interface
  extending `JpaRepository` gets `findById` from a jar we did not read, so calls
  to it resolve to nothing.
- **the effect of annotation processors.** Lombok-generated getters, MapStruct
  implementations and QueryDSL Q-classes do not exist in the source, so they do
  not exist in the graph.

Each of these produces *absence*, never a wrong edge. That is the trade this
project is set up to prefer: CLAUDE.md's "a confidently wrong dependency map is
worse than no map".

### The classpath path is not closed

ADR-0005 already defines a `classpath` resolution provenance alongside `import`.
When a classpath is available, meta-annotation chains are followed and the facts
record that they came from type attribution. This ADR says only that M1 does not
*produce* one, and that nothing in the design may assume one exists.

## Alternatives considered

**Run `rewrite-maven-plugin` / `rewrite-gradle-plugin` against the target
repository.** Rejected. Highest fidelity, but it requires the build to work and
its dependencies to be reachable, which excludes the majority of the intended
targets. It also executes the analysed repository's build logic, which is a
thing a read-only analysis tool should not do.

**Resolve dependencies ourselves from the POM without running the build** (Aether
against Maven Central plus any declared repositories). Rejected for M1. It
reintroduces the network into extraction, fails on private repositories anyway,
and it is a large amount of machinery — transitive resolution, version
mediation, profiles, properties, dependency management inheritance — for a
benefit that shows up as a slightly denser graph.

**Use an already-built `target/classes` or `build/classes` when present.**
Tempting, cheap, and rejected for now only on grounds of scope: it is a genuine
improvement for repositories that *have* been built, and it should be revisited
as an optional input. It is not a substitute for source-only working, because
the first thing an unfamiliar repository does is fail to build.

**Parse each module separately.** Rejected. It is the obvious reading of
"multi-module", and it silently loses every cross-module type — which on a
50-module monolith is most of the interesting coupling. One pass with a shared
type cache costs memory and buys the edges the tool exists to find.

**Require the repository to compile, and refuse otherwise.** Rejected. It would
make the tool useless on precisely the codebases it targets.

## Consequences

- The extractor runs on any Java repository on disk, including one that does not
  build, has no build file, or uses a layout nobody has used since Ant.
- Extraction stays hermetic: no network, no execution of the analysed repository.
- Memory, not wall-clock, is the scaling limit — one parse pass holds the whole
  first-party type universe. Expect this to be the first thing that needs work on
  a genuinely large monolith, and measure it during M1 acceptance rather than
  guessing now.
- The graph is *sparser* than a classpath-resolved one, and the gap is
  concentrated in framework-mediated edges. Reports must distinguish "no
  endpoints found" from "endpoints could not be resolved" — the diagnostic
  counts are how they do it.
- Two resolution provenances exist in the data model from the start
  (`import` and `classpath`), even though M1 only ever emits the first. Adding
  the second later must not require a schema change.
