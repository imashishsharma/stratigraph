# ADR-0043: Read what the compiler folds — constants, meta-annotations, @Bean-built classes

- Status: accepted; amends ADR-0005 and ADR-0039
- Date: 2026-09-28
- Milestone: M11 follow-up (after the first 20-repository scorecard)

## Context

The first full benchmark run (ADR-0035) put endpoint recall at 50% and
injection resolution at 66%. The misses clustered in three shapes, each a
fact the source states and the extractor did not read:

- **Constants in annotation values.** killbill writes
  `@Path(JaxrsResource.ACCOUNTS_PATH)` where `ACCOUNTS_PATH = PREFIX + "/" +
  ACCOUNTS`; nacos builds its routes the same way. 1 of 100 labelled killbill
  endpoints was read. (Separately, `@PostMapping(path = …)` was ignored — only
  `value` was read — which cost jhipster, realworld and initializr routes.)
- **First-party meta-annotations.** eladmin declares `@AnonymousGetMapping`
  with `@RequestMapping(method = GET)` and uses it on its controllers.
- **Classes constructed by `@Bean` methods.** spring-cloud-gateway and Spring
  Boot Admin build their beans with `new X(a, b)` in configuration classes;
  `X` has no stereotype, so its constructor was not an injection point.

## Decision

1. **Compile-time constants declared in the source set are evaluated**:
   `static final` fields and interface fields whose initializer is literals,
   concatenation and other such constants (`Constants.java`). A constant from
   a jar, or one computed by a call, still yields nothing. Path templates drop
   variable regexes (`{id:[0-9]+}` is `{id}`), and `path =` is read wherever
   `value` is.
2. **A first-party annotation declared with a Spring mapping or stereotype is
   that mapping or stereotype**, to three levels of nesting. The verb comes from
   the declaration and the path from the use, as `@AliasFor` wires it.
3. **A class a `@Bean` method returns or constructs is a bean**, and the
   parameters of its sole constructor are injection points (`via:
   bean-constructor`). Constructors are resolved as each file is read and
   emitted at the end, because the `@Bean` method may be in any file.

## Alternatives considered

**Evaluate any static field.** A non-final or computed value is not what
annotation processing sees; only compile-time constants are folded by javac.

**Treat every single-constructor class as a bean.** It would draw injection
edges for value objects and DTOs; the `@Bean` method is the fact that makes a
class a bean.

## Consequences

- killbill: 1 → 281 endpoints read (278 labelled).
- A controller registered by a framework-private mechanism with no Spring
  meta-annotation (Spring Boot Admin's `@AdminController`) is still not an
  endpoint source, and says nothing it cannot see.
