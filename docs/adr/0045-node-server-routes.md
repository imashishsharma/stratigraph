# ADR-0045: Koa and Express routes are endpoints, when the router is provably one

- Status: accepted
- Date: 2026-09-28
- Milestone: M11 follow-up

## Context

bitwarden/clients' CLI serves a local HTTP API (`bw serve`) with `@koa/router`:
`router.get("/status", …)`. The benchmark labelled 17 such routes; the
TypeScript extractor read Angular only, so the HTTP surface of that
repository was empty and said nothing about why.

## Decision

The TypeScript extractor reads `x.get|post|put|delete|patch|head|options(path,
…)` as a route **only when `x` is provably a Koa or Express router**: its
binding is initialised by `new Router()`, `express()` or `express.Router()`
where the callee comes from an import of `@koa/router`, `koa-router` or
`express`, or it is a parameter or variable typed with such an import. The
path must be a string literal; `:param` becomes `{param}`. The endpoint is
cited at the call, and `handles` runs from the enclosing method or function.

## Alternatives considered

**Any `.get("/…")` call.** A cache, a map or an HTTP client has the same shape;
without the import the call is not a route, and reading it as one would be the
guess CLAUDE.md forbids.

## Consequences

- A router passed through several layers without a type annotation is not
  recognised; its routes stay unread.
- NestJS, Fastify and other frameworks are not read.
