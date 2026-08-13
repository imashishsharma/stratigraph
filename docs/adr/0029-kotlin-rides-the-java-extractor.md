# ADR-0029: Kotlin is parsed by the Java extractor, in the same jar

- Status: accepted
- Date: 2026-08-13
- Milestone: M9

## Context

Java and TypeScript were the first two languages because they were the two the
target repositories were made of. Kotlin is the obvious third: it turns up
*inside* Java repositories rather than instead of them — a Spring Boot service
with a Kotlin test module, or a team migrating package by package — and a tool
that reported the Java half of a build and silently omitted the Kotlin half
would be doing the thing this project exists to prevent.

The question was what that costs. OpenRewrite publishes `rewrite-kotlin`, so
there was a plausible cheap path and a plausible expensive one, and they differ
by about a week. A spike settled it before any of the work was done
(`KotlinSpikeTest`, kept):

- Kotlin parses to an LST, not a `ParseError`.
- **A `JavaIsoVisitor` sees Kotlin classes and functions.** The Kotlin LST is
  built out of the same `J` elements, so a class is a `J.ClassDeclaration`
  whichever language declared it.
- Kotlin types are attributed, which matters more than the shapes: facts are
  only emitted for what the parser attributed (ADR-0005), so an unattributed
  LST would have been worthless even with matching shapes.
- Annotations are attributed, which is the whole Spring story.

So the parsing half was a branch, not a second extractor.

## Decision

**One jar parses both languages, and the existing visitor walks both.**

### The type the extractor gates on

`JavaFactExtractor` gated on `J.CompilationUnit`. A Kotlin file parses to a
`K.CompilationUnit`, which is **not** a `J.CompilationUnit` but **is** a
`JavaSourceFile` — the interface carrying the package declaration, the imports
and the classes, which is everything the extractor reads. Kept as the narrower
type, every Kotlin file was walked straight past: a `file` fact with no
declarations under it, and no diagnostic, because nothing had failed.

The gate is now `JavaSourceFile`. That change alone produced classes, methods,
calls and annotations from Kotlin, and **changed no Java fact** — every existing
golden is byte-identical across it.

### Kotlin imports are read off the qualified id

Three `J.Import` accessors mean something else on a Kotlin unit, and the first
cost every Spring annotation its resolution:

| accessor | on Java | on Kotlin |
| --- | --- | --- |
| `isStatic()` | true only for a static import | **true for every import** |
| `getTypeName()` | the type's fqn | the *package* |
| `getClassName()` | `Outer.Inner`, or `*` | the simple name; never `*` |

The Java path skips static imports because they name members rather than types.
Applied to Kotlin that discarded the entire import list, so `@Service` resolved
against the local package and came out `com.example.Service` — a confidently
wrong fact, cited to a real line. `TypeResolver` now reads the qualified id,
which prints the same dotted name in both languages, and takes the Kotlin branch
per file.

These are properties of `rewrite-kotlin` rather than of this project, so they
are pinned by tests. A version bump that changes any of them fails loudly
instead of quietly un-resolving every annotation in every Kotlin file.

### One jar, not two

`kotlin-compiler-embeddable` is 57 MB against the 22 MB everything else weighs.
The jar goes from 22 MB to 87 MB, and a Java-only user pays all of it.

The alternative — a second artefact, fetched only by Kotlin users — is what
ADR-0004's own reasoning suggests, and it was rejected on cost of machinery
rather than principle: a second shade execution, a per-language dimension in
`fetch-extractor`, `doctor` and the cache layout, and a runtime failure mode
where the wrong jar is present and the error has to explain which. That is a lot
of surface for an artefact fetched once and cached per version by a tool whose
users routinely pull larger things from an internal Nexus.

`.kt` therefore selects the same extractor as `.java` on the Node side, and
`--lang kotlin`, `kt` and `jvm` are all accepted as names for it. The
distinction survives where it is load-bearing: every `file` fact records `java`
or `kotlin` individually, so a store can still say which half of a mixed
repository is which.

`.kts` is deliberately not a source: `build.gradle.kts` names a module
(ADR-0006) and declares no domain type.

## Alternatives considered

**A second extractor written against the Kotlin compiler directly.** Rejected
by the spike, which is what the spike was for. It would have been a week's work
for output the existing visitor already produces.

**Two jars, Java-only and JVM.** Rejected as above — on machinery, not on
principle. Revisit if the download turns out to be an adoption complaint;
nothing here forecloses it, and the jar name is the only thing that would move.

**Share a type cache between the two parsers**, so a Kotlin file calling a Java
method in the same repository resolves through. Tried, and it does not work:
both builders take a `JavaTypeCache`, and handing them one changes nothing —
the call is `UNRESOLVED` either way, because the Kotlin parser cannot see Java
sources it was not given, and it cannot be given them.

The only route that would work is compiling the Java half and handing the
Kotlin parser a classpath, which is the one thing ADR-0006 forbids: this
extractor parses the source set and never runs or resolves the build, because
the repositories it exists for do not compile.

So the boundary is real and is reported rather than papered over. On a mixed
fixture, a Kotlin `@Service` injecting a Java `@Repository` **does** produce an
`injects` edge — that resolves through the import and the declared type — while
a call from the Kotlin service into the Java class does not, and leaves:

> `1 call site(s) could not be resolved to a declaring type and were not
> recorded as edges`

An absence and a diagnostic, never a guessed edge (ADR-0005).

## Consequences

- Every projection built on the fact graph works on Kotlin with no further
  change, because they are projections. The `tiny-kotlin` fixture yields a
  package graph, an `injects` edge from constructor injection, an endpoint from
  `@GetMapping`, and an ER model with `Long id PK` read out of `@Entity`/`@Id`.
- The jar is 87 MB. `fetch-extractor` verifies and caches it per version, so it
  is downloaded once; the Docker image grows by the same amount.
- Java behaviour is unchanged, and the goldens prove it rather than the claim
  resting on review.
- A mixed Java/Kotlin repository is analysed in **one run**, so a Kotlin service
  calling a Java repository is one graph — which is the case the whole thing was
  worth doing for.
- Kotlin-specific constructs the `J` model has no place for — extension
  functions as anything but methods, coroutines, `object` declarations as
  distinct from classes — are read as their nearest Java shape or not at all.
  Nothing is guessed, and the next milestone that cares can add them.
