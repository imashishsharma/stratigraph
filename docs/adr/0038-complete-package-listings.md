# ADR-0038: Complete package listings let a wildcard import be ruled out

- Status: accepted; amends ADR-0023 condition 2
- Date: 2026-09-28
- Milestone: M13 (before the code)

## Context

ADR-0023 resolves an annotation reached through a wildcard import only when
that wildcard is the file's only non-`java.*` one, because the known-annotation
table lists what a package declares, never what it does not. The first
benchmark run (ADR-0035) measured the cost: every JHipster entity imports
`jakarta.persistence.*` beside `com.fasterxml.jackson.annotation.*`, and every
JHipster REST resource imports the Spring web annotations beside another
wildcard — so 4 of 5 entities and 7 of 38 endpoints on jhipster-sample-app
were refused, though no reader would doubt where `@Entity` comes from.

The doubt is answerable. A framework package's contents are published: the
jar lists every type it declares. And a first-party package's contents are
known completely — the extractor parses the whole source set, and condition 3
already refuses when the source set declares a type of that name anywhere.

## Decision

**The extractor ships complete top-level type listings for common framework
packages** (`known-packages.txt`, generated from the published jars by
`scripts/gen-known-packages.sh`: Jakarta Persistence and Validation, Jackson
annotations, Lombok, Spring web/context/beans/tx/data/security/boot, Hibernate
annotations; the `javax.*` persistence and validation packages as the jakarta
names, a superset that can only make them compete *more*).

**Condition 2 becomes: exactly one wildcard-imported package could supply the
name.** A package cannot supply it when it is first-party (all its types are
known, and condition 3 found none of that name) or when it is listed and its
listing lacks the name. An unlisted third-party package can always compete.
**Condition 1** accepts the name when the known-annotation table *or* the
supplying package's listing contains it. Condition 3 is unchanged and checked
first. The provenance stays `wildcard-import`.

## Alternatives considered

**Resolve with a real classpath.** Exact when it is available, and the plan
keeps it for the M13 classpath work; but most repositories analysed cold have
no resolved dependencies on disk, and this rule is sound without one.

**List only annotations.** That is the known-annotation table, and it cannot
rule a package out — the whole point is the complete listing.

## Consequences

- JHipster-style code resolves source-only; the tiny-spring refusal fixture now
  competes against an unlisted third-party package to keep proving refusal.
- A framework version that adds a type with a colliding simple name is a
  listing to regenerate; the listing is data with a script, not code.
