# ADR-0040: A C4 container is a deployable, proved by a build file or a main class

- Status: accepted
- Date: 2026-09-28
- Milestone: M14 (before the code)
- Amends: ADR-0019 (level 2)

## Context

ADR-0019 drew one container per `module` node, on the grounds that "what are
the deployable pieces" is answered by the build files. It is — but a `module`
node is every build file, not every deployable. On a real multi-module Maven
build the container diagram showed the parent POM, the aggregator, the BOM and
every shared library as containers beside the two applications that actually
run. Level 2 is the level where a reader most expects to see real deployables,
and it was showing the build's folder structure.

The information that separates the two is in the same files ADR-0006 already
reads, and in one annotation the Java extractor already resolves:

- `pom.xml`: `<packaging>war</packaging>`, `<packaging>pom</packaging>`, and
  `spring-boot-maven-plugin` declared under `<build><plugins>` (not
  `<pluginManagement>`, which only configures children).
- `build.gradle[.kts]`: the `org.springframework.boot` or `war` plugin applied
  in the project's own top-level `plugins {}` block or by a top-level
  `apply plugin:` — not `apply false`, and not from inside `subprojects {}` or
  `allprojects {}`, whose effect on a given child is build logic we do not run.
- `angular.json`: `projects.<name>.projectType`.
- Nx `project.json`: `projectType`.
- `@SpringBootApplication` on a class: an `annotated_with` edge the Java
  extractor emits today (ADR-0005), cited at the annotation's line.

## Decision

**A container is a module with at least one deployability proof. Everything
else is grouping.**

1. **The build-file proofs are facts on the module node**, written by the
   extractor that read the build file:

   | attr | meaning |
   | --- | --- |
   | `root` | the module's directory, repo-relative, `.` for the root |
   | `buildFile` | the file that named the module |
   | `packaging` | Maven packaging, when declared |
   | `modules` | Maven `<modules>`, when declared |
   | `projectType` | `application` or `library`, from `angular.json` / `project.json` |
   | `deployable` | `spring-boot`, `war`, `angular-app` or `nx-app` |
   | `deployableFile`, `deployableLine`, `deployableRule` | where the proof is, and which rule read it |

   The vocabulary lives in `src/facts/types.ts` (`DEPLOYABLE_KINDS`).

2. **`@SpringBootApplication` is joined in the core, not re-derived in the
   extractor.** The annotation is already an `annotated_with` edge with a file
   and a line; `src/analysis/deployables.ts` attributes it to the module that
   holds the class (ADR-0041's membership rule) and cites the edge. A main class
   in a test file does not count (ADR-0034). Re-deriving it in the extractor
   would mean a second resolution of the same annotation, in a file another
   change is rewriting.

3. **A `pom`-packaged module is never a container**, whatever plugins it
   declares: it is a parent, an aggregator or a BOM, and it produces no
   artifact that runs.

4. **When `angular.json` and a `project.json` disagree about one root**, the
   `project.json` wins and the extractor emits a `warn` diagnostic citing both.
   In an Nx workspace `project.json` is the project's own definition;
   `angular.json` is kept for tooling that has not moved. `bitwarden/clients`
   is the case in point: `libs/components` is an `application` to
   `angular.json` (a Storybook build) and a `library` to Nx.

5. **Level 2 draws deployables only.** Relationships between containers are
   code edges from one deployable's code into another's. Library modules are
   compiled *into* the deployables that use them, so an edge into a library is
   not a container relationship.

6. **Libraries appear inside the containers that depend on them.** A container's
   level 3 diagram shows its own packages and, grouped under `library <name>`,
   the library packages its packages depend on directly. The container diagram's
   notes name every module that is not a container and why (library,
   aggregator/BOM, or no proof found).

7. **If no module in a run is deployable, level 2 falls back to one container
   per module** — ADR-0019's behaviour — and says so in the notes. A repository
   whose deployable is assembled by a script nobody has read is a normal input
   (ADR-0006); an empty container diagram would be a worse answer than an
   honestly labelled one.

## Alternatives considered

**Keep every module and tag the non-deployables.** Rejected: the complaint was
that the diagram is wrong, not that it lacks a legend. A reader of a container
diagram reads boxes as things that run.

**Detect the main class by text search in discovery.** Rejected: `@SpringBootApplication`
matched by name, without checking its import, is ADR-0005's guess.

**Treat any `main` method as a deployable.** Rejected: every CLI utility,
code generator and test harness has one. The rule would be true of processes,
not of what the team deploys.

**Resolve inherited plugins through the parent POM.** Rejected for the reason
ADR-0006 gives: the parent may not be in the repository, and resolving it is a
build. A child that inherits the Boot plugin from a parent's `<build><plugins>`
is still found through its main class; one that is found by neither is listed
in the notes as having no proof.

## Consequences

- On a multi-module build, level 2 shrinks to the applications. That is the
  correction.
- A deployable proved only by a build convention we do not read (a version
  catalog alias for the Boot plugin, a plugin applied from `buildSrc`) is not a
  container unless its main class is visible. It is named in the notes, so the
  gap is visible.
- A library that no deployable depends on appears in no diagram; the notes list
  it.
- Every existing module fact gains attributes; goldens change on that line only.

## Amendment (M11 scorecard)

- A Boot proof needs a `main` method in the module, whichever form it takes:
  a library applying the plugin to share build configuration ships nothing
  runnable (nacos maintainer-client), and a `@SpringBootConfiguration` class
  with no `main` is a configuration a test boots (spring-cloud-gateway
  mvc-failure-analyzer). `@SpringBootConfiguration` + `@EnableAutoConfiguration`
  count as `@SpringBootApplication`. WAR packaging remains its own proof.
- An Nx project rooted in an `e2e` directory or named `*-e2e*` is a test
  harness, not a deployable, whatever its `projectType` says.
