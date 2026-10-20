# ADR-0047: The upgrade agent: recipe, known fixes, an opt-in AI loop, and a handoff when a human must decide

- Status: accepted
- Date: 2026-09-30
- Milestone: Phase D (Upgrade Agent MVP)

## Context

The gap map (`bench/upgrade-gap/`) ran OpenRewrite's Spring Boot upgrade
recipes, alone, on 10 public applications:

- **0/10 built green.** There were 44 distinct breakages. 27 of them needed
  judgment, and 9 were introduced by the recipe itself.
- An AI agent working the failures by hand brought **7/10 back to their
  baseline test results**. The 3 that stayed red were stopped by real
  decisions: an authorisation rule, a Hibernate data behaviour, and a library
  with no Jakarta release.

So the value lies in four things: the loop after the recipe, how that loop is
verified, and a report of what it could not decide that someone can act on.

The product's rules apply here too:

- **Facts come from tools.** The build log, the test reports, git and the
  recipe are the tools here.
- **A model never produces a fact.**
- **Source goes to a model only on an explicit flag.**
- **Nothing is claimed that isn't cited.**

## Decision

`stratigraph upgrade plan` and `stratigraph upgrade run`, for Maven projects,
with Spring Boot 2.7 → 3.5 as the first path and 3.x → 4.0 as the second.

### The run

1. **Preconditions.** The work tree must be clean. The run works on a new
   branch, `stratigraph/upgrade-spring-boot-<to>`, and never on the branch the
   user is on.
2. **Baseline.** `mvn verify` with the JDK the project declares, keeping going
   past test failures. Every test's outcome is read from the Surefire/Failsafe
   XML. This is the reference: "red" after the upgrade means *was passing
   before, fails now*, never merely "the build exited 1". A test red at
   baseline (Docker, a browser, a network) is not the upgrade's to fix and is
   reported as such.
3. **Recipe.** The rewrite-maven-plugin is invoked by coordinates, with pinned
   plugin and recipe versions, on the target JDK. Its output is one commit,
   "recipe", so reviewers can tell it apart from everything after it. Known
   recipe hazards are prevented rather than repaired: Gradle wrapper files are
   excluded when a Maven project also carries them.
4. **Loop.** Build, then read the failures. There are three kinds: POM model
   errors, compiler errors with file:line, and tests that were green at
   baseline and fail now.

   Each failure gets a **category** from rules over the log text. The gap
   map's categories are the starting vocabulary, and each rule is written
   from a real log excerpt that becomes its test. Each category has a
   **disposition**:
   - *mechanical*: a known fix exists.
   - *judgment*: a fix exists but needs reading the code.
   - *decision*: the fix changes behaviour someone has to choose. Examples
     are two security filter chains matching every request, an HTTP status
     that changed, and a data or transaction semantic.

   Then, in order:
   1. **Known fixes.** These are deterministic, written from the gap map's
      fixes, and each is one commit, e.g. `known-fix: add -parameters (Spring
      6.1)`.
   2. **The AI fixer**, only with `--ai claude-code`, and only for
      *mechanical* and *judgment* failures. It never handles a *decision*:
      that goes to the handoff. The fixer is the Claude Code CLI run headless
      in the repository, with a prompt carrying the failure, its category's
      guidance and the constraints. The constraints are: no deleting or
      disabling tests, no changing assertions, no weakening security, and the
      smallest change that restores the baseline behaviour.
   3. **Acceptance.** Every attempt is rebuilt. It is kept, as one commit,
      only if the set of failures shrank and no baseline-green test turned
      red. Otherwise the tree is reset to the last accepted commit. A change
      to a test file is flagged for review in the report even when it is
      accepted.

   The loop ends at baseline parity, at a budget (iterations, wall-clock), or
   when every remaining failure is a *decision* or has resisted its attempts.
5. **Report.** `upgrade-report.md` and `upgrade-report.json` at the repository
   root, in the last commit. The status is one of:
   - `parity`: every baseline-green test is green.
   - `needs-decision`: stopped on decisions.
   - `stuck`: failures the loop could not fix.

   The report also gives:
   - The per-test diff against the baseline.
   - The commits in three layers: recipe, known fixes, AI fixes, each with its
     SHA.
   - Every test-file change.
   - For each remaining failure, a **handoff**: its evidence (log excerpt,
     file:line, test), category, what was tried (commits reverted, with
     diffs), and the options.

   For *decision* categories the options are written text from a playbook.
   Anything a model wrote is marked `authoredBy: model`.

### Plan

`upgrade plan` needs no build and no network. It reads:

- The Spring Boot version (parent, BOM import or property) and the Java
  version from the POM.
- The installed JDKs.
- A cited survey of the code, where each hit is a file:line of a pattern the
  gap map tied to a category. Examples: `extends
  WebSecurityConfigurerAdapter`, springfox, `@Type(type = ...)`, jjwt 0.9,
  `javax.xml.bind`, a table named `user`.

From these it predicts which categories to expect. The prediction is labelled
as such: a pattern hit is a fact, and "this will break" is an expectation.

### Network and source

- Unlike extraction, an upgrade builds the project. Maven downloads the
  dependencies of the new versions and the rewrite plugin. The run says so
  before it starts.
- Source reaches a model only with `--ai`. It goes to the Claude Code CLI the
  user already runs, under their account. The run logs that loudly.
- Without `--ai`, the run is the recipe, the known fixes, the verification
  and the report, and it is still useful: it turns "the build is red" into a
  categorised, cited list.

## Alternatives considered

**Recipe only, then hand off.** This is what OpenRewrite already does. 0/10
is the result.

**Let the AI fix everything, decisions included.** The three red repos in the
gap map were red because a behaviour had to be chosen. An agent choosing an
authorisation rule silently is the failure reviewers fear most. Stopping with
options is the product.

**Accept an AI attempt if the build compiles.** Two regressions in the gap map
compiled cleanly and only showed as test failures: Spock's null injection and
the trailing-slash change. Acceptance must be per test, against the baseline.

**Call the Anthropic API directly with a patch format.** That makes the fixer
more deterministic and cheaper to meter, and it is likely the second fixer.
Claude Code first, because it can read around a failure, run a narrower build
and edit several files, and because it runs under an account the user already
has. The API fixer is added when a measured need appears (CLAUDE.md: no
speculative abstraction).

**Gradle and multi-module first.** They are out of the MVP scope in the
product note, and the gap map covered only Maven.

## Consequences

- The upgrade command builds, downloads and edits, so it is the first part of
  stratigraph that is not read-only. It confines itself to a branch and a
  clean tree, and it never pushes.
- Category rules are pattern-matched, and every pattern is tested against a
  real excerpt. An unrecognised failure is reported as `uncategorised` with
  its excerpt rather than guessed.
- The gap-map corpus becomes the upgrade benchmark. The measures are repos
  reaching parity, human decisions per repo, and wall-clock time.
- Known fixes must stay exact. A fix that could change behaviour is not a
  known fix; it is a judgment for the AI or a decision for a person.

## Amendment (2026-10-08): how "better" is judged, learned from the benchmark

The first rule was "fewer failures and no newly red test." The agent benchmark
(`bench/upgrade-gap/agent-bench.sh`, the gap map's 10 repos) rejected seven
correct fixes under it. Each was a fix that let the build get further and
reveal errors that had always been there. A build is now compared in this
order, the first difference deciding:

1. **Stage.** The POM cannot be read or resolved, then it fails to compile or
   a plugin fails, then it builds with red or missing tests, then parity
   (blog-app: dropping a stale BOM override exposed compile errors).
2. **How far through the lifecycle it got**, counted in plugin goals Maven
   started (kafdrop: the wrapper fix let `clean` run, then `compile` failed).
3. **Whether javac started at all.** An option error that names no file is
   worse than source errors (kafdrop: `--add-exports` with `--release`).
4. **Whether javac got past parsing.** Syntax errors are worse than
   unresolved names, at any count; javac stops at 100 errors, so counts tie
   (petclinic-reactjs: the generator's escaping bug).
5. **Whether its imports resolve.** A missing package stops javac before it
   checks the code that uses it (petclinic-reactjs: the deleted
   `orm.hibernate5` import, then a Jackson 3 builder method).
6. **Fewer build failures**, then **fewer red or missing tests**.

A test is *newly red* only if it passed in the previous build, not merely at
baseline: getting 39 skipped integration tests to run, 34 green and 5 red,
is progress (WebGoat). A green build that runs fewer of the baseline's
passing tests is itself a failure to work on. A failure caused by other
failures (a coverage gate) waits for them and does not set the status.
Parity with no tests is reported as unverified.

## Amendment (2026-10-20): recipes leave Maven Central

OpenRewrite now publishes new recipe releases to the authenticated Code Genome
Project. Maven Central stops at rewrite-spring 6.37.1 and rewrite-maven-plugin
6.46.1. The defaults stay pinned to those versions: they run with no
credentials, and they are the versions every benchmark result was measured
on. Newer recipes are used by configuring the repository in
`settings.xml` and passing `--rewrite-spring` and `--rewrite-plugin`. The
report already records the versions that ran. Re-running the benchmarks on a
newer recipe set is a separate measurement and is reported as one.

## Amendment (2026-10-20): Gradle builds

The loop is unchanged; what it asks the build is now behind a small
`BuildTool` (`src/upgrade/build-tool.ts`) with two concrete implementations,
Maven and Gradle — the second implementation that the no-speculative-abstraction
rule waits for.

- **Facts** (`src/upgrade/gradle.ts`). The Boot version is read from where
  Spring Boot projects write it: the plugins block, `gradle.properties`
  (`springBootVersion`, JHipster's `spring_boot_version`), an `ext` property, a
  buildscript classpath, or `gradle/libs.versions.toml`. A version written
  anywhere else — computed, or in a convention plugin — is reported as not
  declared. It is never guessed. The wrapper's Gradle version comes from
  `gradle-wrapper.properties`.
- **Recipe.** OpenRewrite's Gradle plugin (`org.openrewrite:plugin`, 7.39.0)
  is applied by an init script
  written into the run's log directory, so the project's build files are not
  edited to add it. That is the same rule as invoking the Maven plugin by
  coordinates. The recipe runs on the baseline JDK. On a Gradle build it is the
  recipe that moves the wrapper (`UpdateGradleWrapper ^7.4`), and an old wrapper
  cannot start on JDK 17. The pinned version is the last whose rewrite core
  (8.89.0) matches the pinned Maven plugin and is on Maven Central. 7.40.0 and
  7.41.0 are on the Plugin Portal, but they need `rewrite-bom` 8.91.0, which
  only Code Genome serves. That was found on the first real run.
- **JDKs follow the wrapper.** The baseline JDK is the declared one if the
  wrapper's Gradle runs on it (the compatibility matrix in
  `toolchain/classpath.ts`). After the recipe, each build reads the wrapper
  again and runs on the lowest JDK that is at least the target Boot's minimum
  and that this Gradle accepts.
- **Build.** `clean check --continue --console=plain`. A build that fails only
  on failing tests counts as built, as Maven's `-Dmaven.test.failure.ignore`
  does. Tests are judged from the JUnit XML under `build/test-results/`, the
  same as Surefire's.
- **Output.** javac (`File.java:12: error:`), Kotlin (`e: file://…`) and the
  `* What went wrong:` blocks are read into the same `BuildLog` shape. A failure
  in a build script or plugin application is stage 3, like a broken pom. A
  wrapper that dies before Gradle starts is read from its exception line.
- **Known fixes** are per tool. The Gradle ones are: the wrapper to 8.14.3
  (category `gradle-too-old`), `-parameters` through
  `tasks.withType(JavaCompile)`, `spotlessApply` or `format`, and the Flyway
  10 database module. Fixes that edit only Java source (relocations, private
  `@Bean` methods) apply to both tools. Like the Maven fixes, they edit only
  the root build script, and `upgrade plan` lists this as a limit.

Found on the first real run: a download timeout of the wrapper's distribution
was read as a broken baseline. Network failures now include the wrapper's
`Downloading from … failed` and Gradle's `Could not GET/HEAD`, and they are
retried once and handed off as `network`, like Maven's. On the test machine the
cause was one unreachable GitHub CDN address. The JVM's HTTP client tries only
the first address a host resolves to, where curl tries the others.
