# ADR-0039: An offline classpath when there is one; Lombok and @Bean wiring either way

- Status: accepted; amends ADR-0006
- Date: 2026-09-28
- Milestone: M13 (before the code)

## Context

ADR-0006 made extraction source-only: parse the source set, never the build.
Two costs showed on real code. Types from jars stay unattributed, so resolution
leans entirely on imports (ADR-0005/0023/0038). And the way most modern Spring
code injects — a Lombok `@RequiredArgsConstructor` over `final` fields — has no
constructor in the source at all, so those beans had no injection edges; nor
did the parameters of `@Bean` factory methods, which is how configuration
classes wire everything else. Nothing said how many injection points were
missed.

## Decision

1. **Classpath, opportunistically and offline.** When the repository root has a
   Maven build, `extract` runs `mvn -o dependency:build-classpath` (the
   project's `mvnw` only if its Maven distribution is already cached — the
   wrapper otherwise downloads one) with a timeout, and passes the jars to the
   Java extractor (`--classpath-file`), which gives them to OpenRewrite for
   type attribution. Nothing is ever downloaded. Any failure leaves the run
   source-only. The run records which — `typed: N jars…` or `source-only: why`
   — on the Java extractor's `extractor_run` row, and every structural view's
   coverage prints it. `java.classpath: "off"` disables the attempt. Gradle
   classpaths are not resolved yet, and say so.
2. **Lombok constructors are constructors.** On a stereotyped class with no
   hand-written constructor, `@RequiredArgsConstructor` injects every `final`
   or `@NonNull` instance field without an initializer, and
   `@AllArgsConstructor` every instance field — Spring's sole-constructor rule,
   with Lombok's generated constructor as the sole one (`via:
   lombok-required-args` / `lombok-all-args`).
3. **`@Bean` method parameters are injected** into the declaring configuration
   class (`via: bean-method`).
4. **Unresolved injection points are counted.** Each is a diagnostic, and
   structural coverage states "N of M injection points resolved to a type".

## Alternatives considered

**Run the build (`mvn compile`) or delombok.** Needs network, the right JDK and
a working build — the half of enterprise repositories where that fails are the
ones this tool is for. The product plan's warning stands: classpath is a
rabbit hole; make source-only honest instead of making the build a
precondition.

**Resolve Gradle's cache by hand.** The file layout is reproducible, but
choosing versions without Gradle's resolution rules would attribute types from
jars the build does not use. Deferred until it can be done by Gradle itself,
offline.

## Consequences

- On a machine where the project has been built, types resolve through the
  classpath and coverage says "typed"; on a clean machine the same run is
  source-only and says that instead.
- `extract` may take longer on a Maven repository (bounded by the timeout).
