# ADR-0005: Resolve framework annotations from source, not from a classpath

- Status: accepted
- Date: 2026-07-28
- Milestone: M0 (decided before M1, per "write the ADR before the code when the decision is architectural")

## Context

M1 must emit Spring stereotypes, REST endpoints and JPA entity-to-table
mappings, and fixture tests must assert those facts exactly.

That creates a tension. CLAUDE.md says fixtures are tiny, hand-written, and
assert exact output; it also says extraction runs entirely locally with no
network access. But a Spring annotation is only *fully* resolvable with
`spring-web`, `spring-context` and `jakarta.persistence` on the classpath — and
putting them there means either committing jars into the repository or having
the test suite resolve dependencies from Maven Central, which makes an offline,
deterministic test run impossible.

The tempting shortcut is to match on the annotation's simple name: see
`@RestController`, emit an endpoint. That is name-matching dressed up as
analysis, and it is exactly the kind of confidently-wrong output this project
exists not to produce.

## Decision

**An annotation's fully-qualified name is derived from what the parser
saw: the annotation itself plus the compilation unit's import statements.**
Both are facts from a parser. Neither requires the annotation's jar.

Specifically:

1. `import org.springframework.web.bind.annotation.RestController;` plus
   `@RestController` on a class ⇒ the class is annotated with
   `org.springframework.web.bind.annotation.RestController`. **Fact.** Cite the
   import line and the annotation line.
2. A fully-qualified annotation in place (`@org.springframework.stereotype.Service`)
   ⇒ same, trivially. **Fact.**
3. A same-package annotation with no import ⇒ resolvable against the file's own
   package. **Fact.**
4. **A wildcard import (`import org.springframework.web.bind.annotation.*;`)
   makes the FQN ambiguous. We emit no stereotype fact and emit a `diagnostic`
   naming the file and line.** We do not guess, and we do not quietly skip:
   the diagnostic is how the report can say "3 files could not be resolved"
   rather than under-reporting endpoints as if the codebase had fewer.
5. **Meta-annotations need the classpath.** Spring composes stereotypes —
   `@RestController` is itself `@Controller`, which is `@Component`; a team's
   custom `@ApplicationService` may be meta-annotated `@Service`. Whether an
   unknown annotation is a stereotype cannot be determined from source alone.
   Known framework annotations are matched against a table of FQNs shipped with
   the extractor. An unrecognised annotation produces no stereotype fact; when
   the classpath *is* available (a real analysis run over a built project,
   where OpenRewrite has the dependencies), meta-annotation chains are followed
   and the resulting fact records that it came from type attribution.

So facts get a resolution provenance: `import` (source-only) or `classpath`
(type-attributed). Both are facts. Neither is a guess.

Fixtures therefore need **no jars**: `fixtures/tiny-spring` is hand-written
Java with real Spring and JPA imports and no dependencies, and the extractor
tests assert exact output from source-only resolution — including the
diagnostic for the wildcard-import file.

## Alternatives considered

**Commit real jars into `fixtures/`.** Rejected: megabytes of binaries in the
repository, tied to specific framework versions, and it tests the classpath path
while leaving the far more common source-only path untested. Real repositories
frequently cannot be resolved — a private Nexus that is unreachable, a build
that does not compile — and source-only resolution is what runs then.

**Resolve dependencies from Maven Central during tests.** Rejected: tests stop
being offline and deterministic, and CI starts failing for reasons that have
nothing to do with the code.

**Match on the annotation's simple name.** Rejected outright. `@Service` is not
necessarily Spring's `@Service`, and a dependency map that assumes it is, is the
confidently-wrong map that CLAUDE.md forbids.

**Skip Spring facts unless the classpath resolves.** Rejected: it would make the
tool useless on precisely the legacy monoliths it targets, which are the ones
least likely to build cleanly on first contact.

## Consequences

- Fixture tests stay offline, tiny, hand-written, and exact.
- The extractor has two resolution paths to maintain, and every annotation-derived
  fact records which one produced it. Reports can therefore distinguish "no
  endpoints found" from "endpoints could not be resolved".
- A codebase that uses wildcard imports heavily will produce many diagnostics and
  few stereotype facts. That is the correct output: the honest answer is
  "unresolved", and the report must show the count rather than hide it.
- The known-annotation FQN table is a maintenance burden and will lag new
  framework releases. It is data, not logic, and lives in one file.
