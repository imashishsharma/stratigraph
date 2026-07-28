# Fixtures

Tiny, hand-written repositories that extractor tests assert **exact** fact output
against. They are not built and not run; they exist to be parsed.

Rules:

- Small enough that a human can list every fact they should produce.
- No external dependencies, so tests stay offline and version-independent.
- Nothing derived from any real codebase.

## `tiny-java`

Five classes across three packages, with the shapes a dependency graph needs:
an interface and its implementation, constructor injection, a cross-package call
chain (`web` → `domain` → `repo`), and a class with no outgoing edges.

Deliberately plain Java: no Spring annotations, no JPA. Resolving framework
annotations requires those jars on the classpath, which would make the fixture
depend on a network fetch and on a particular framework version. **Open question
for M1:** how to assert Spring stereotype / endpoint / JPA facts offline — either
a vendored minimal jar, or a second fixture that the test suite skips when its
classpath is unavailable. Decide it in an ADR before writing the extractor.
