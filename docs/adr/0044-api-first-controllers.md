# ADR-0044: An API-first controller serves the OpenAPI operations it overrides

- Status: accepted
- Date: 2026-09-28
- Milestone: M11 follow-up

## Context

spring-petclinic-rest generates its controller interfaces from
`src/main/resources/openapi.yml` at build time. The committed controllers only
`@Override` the generated methods; every route annotation lives in generated
code that is not in the repository. The benchmark read 0 of its 38 endpoints,
and said nothing about why. The routes are stated in a committed file — the
spec — and the generator names each interface method after the operation's
`operationId`.

## Decision

The Java extractor reads OpenAPI specs (`*openapi*`, `*swagger*`, `*api*`
YAML/JSON outside test roots, whose head names `openapi` or `swagger`): each
operation's method, path, `operationId`, and the line it is declared on.

A method of a controller-stereotyped class that carries `@Override` and whose
name is an `operationId` handles that operation. The endpoint is the spec path
joined to the controller's class-level mapping, cited **at the spec line**
(`framework: openapi`); the `handles` edge is cited at the method.

## Alternatives considered

**Emit every spec operation as an endpoint, handler or not.** The spec also
describes APIs a repository only calls; tying an operation to an override is
what shows this application serves it.

**Match by generated interface name** (tag → `OwnersApi`). Generator
configuration renames interfaces freely; `operationId` is the one name that
survives into the method.

## Consequences

- A spec whose `paths` use YAML anchors or flow style beyond the common forms
  is read partially; missed operations stay missed, never guessed.
- A servlet context path (`server.servlet.context-path`) is not part of an
  endpoint's identity, here as everywhere else.
