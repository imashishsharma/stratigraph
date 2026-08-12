# ADR-0023: Earning resolution through a wildcard import

- Status: accepted
- Date: 2026-08-01
- Milestone: M7 (decided before the code, per "write the ADR before the code when
  the decision is architectural")

## Context

ADR-0005 rule 4 refuses to resolve an unqualified annotation name in any file
that contains a wildcard import. The refusal is honest — from one file's source
alone, `@GetMapping` under `import org.springframework.web.bind.annotation.*;`
genuinely could be something else — and it is also, measured at M5, the largest
single gap in the tool's coverage of real Spring code: `jhipster-sample-app`
yielded **2 endpoints out of 136 Java sources**, against 21 `@GetMapping`, 12
`@PostMapping` and 9 `@RequestMapping` diagnostics, because JHipster generates
every REST controller with exactly that wildcard import. With no endpoints, the
M5 cross-stack linker had nothing to match, so the Angular half of the monolith
could not be joined to the Java half either (ADR-0018).

ADR-0005 already names the way out: *earn* the resolution rather than assume it.
This ADR is that analysis. The rule it must not break: assuming `@GetMapping`
under a wildcard import is Spring's is name-matching dressed up as analysis — a
repository can declare its own `GetMapping`, and a map that guesses otherwise is
the confidently-wrong map CLAUDE.md forbids.

## Decision

**An unqualified annotation name reached through a wildcard import resolves when
three conditions hold together, and stays a diagnostic otherwise.**

1. **The simple name is in the known-FQN table under a package the file
   wildcard-imports.** The table (`FrameworkAnnotations`, ADR-0005 rule 5) is
   shipped data: it says Spring declares
   `org.springframework.web.bind.annotation.GetMapping`. The wildcard import
   says this file can see that package. Both are facts.
2. **That wildcard import is the file's only wildcard import.** A second
   wildcard-imported package — known or unknown — could supply the same simple
   name, and nothing can prove it does not: the known-FQN table lists the
   annotations we recognise in a package, not the package's full contents, and
   an unknown package's contents are not observable at all. Two wildcard
   imports therefore leave the name ambiguous no matter what the table says.
3. **No type of that simple name is declared anywhere in the parsed source
   set.** A first-party type named `GetMapping` — in the file's own package,
   where it would shadow the import, or anywhere a wildcard could reach — makes
   the repository one of the ones that declares its own. The extractor already
   parses every discovered source in one pass with a shared type cache
   (ADR-0006); a pre-pass over the parsed compilation units collects every
   declared type's simple name, nested types included, before any resolution
   happens.

When all three hold, the resolution is not a guess: exactly one package in
scope is known to declare the name, no other package in scope can be shown to
compete, and the repository demonstrably does not declare it. The resulting
facts carry a distinct provenance — `resolution: "wildcard-import"` — so every
consumer can tell an earned wildcard resolution from a single-type import
(`import`) and from type attribution (`classpath`). Ordering is unchanged:
attribution still wins outright, and a single-type import still beats a
wildcard, exactly as `javac` would resolve the name.

Every refusal now says *why*. The diagnostic distinguishes an unrecognised
name (not in the table), competing wildcard imports (named), and a shadowing
declaration (the declaring file named) — so the report can say "3 files could
not be resolved, and here is what would resolve them" instead of one
undifferentiated count.

### The `java.*` extension, earned at the acceptance run

**Excluding `java.*` wildcard imports from condition 2.** The argument: the
JLS reserves `java.*` packages, the parser always has the JDK on its
classpath, and a name suppliable from a JDK package would have been
type-attributed and never reached this code — so `import java.util.*;`
alongside the Spring wildcard provably cannot supply `@GetMapping`, and can
be discounted. This was deliberately left out of the first implementation
because no measured repository had yet needed it; the M7 acceptance run then
measured exactly the anticipated case — three of `jhipster-sample-app`'s
controllers (`AccountResource`, `PublicUserResource`, `UserResource`) refused
only because `import java.util.*;` sat beside the Spring wildcard — so the
extension was implemented, with its own fixture, as this section said it
should be. Condition 2 itself is unchanged: any non-`java.*` second wildcard
still refuses.

## Alternatives considered

**Resolve when the name is in the table, full stop.** Rejected. That is ADR-0005's
"match on the simple name" alternative wearing a wildcard import as a fig leaf;
it guesses wrong the moment a repository declares its own `GetMapping`.

**Allow multiple wildcard imports when only one is "known".** Rejected. It
mistakes the table for an enumeration. The table says what a package *does*
declare among the annotations we care about; it cannot say what a package does
*not* declare, and for an unknown package it says nothing at all. Condition 2
is the difference between an argument and a hunch.

**Check only the file's own package for shadowing, not the whole source set.**
Rejected. Cheaper, but wrong for the same repository-declares-its-own case when
the declaration sits in another package the wildcard reaches — and the whole
source set is already parsed and in memory, so the broader check costs one
cheap pre-pass and refuses strictly more often, never less.

**Resolve against the classpath by downloading the dependencies.** Rejected at
ADR-0005 and still rejected: extraction is offline by design, and the
repositories this tool targets are the ones least likely to build.

## Consequences

- The parsed source set's closure has a caveat: a file that failed to parse
  (`ParseError`) contributes no declared names, so a shadowing type inside it
  is invisible to condition 3. That file already produced its own `error`
  diagnostic — the loss is reported, not silent — and a repository whose
  unparseable file declares a type named `GetMapping` is a corner accepted
  knowingly.
- `fixtures/tiny-spring/LegacyReportController.java` changes meaning. Its
  single Spring wildcard import satisfied all three conditions, so under this
  ADR it would resolve — its ambiguity was an artifact of the old rule, not
  real. It gains a second wildcard import so it keeps guarding the refusal
  path with an ambiguity that is now genuine, and a new controller with the
  single-wildcard JHipster shape demonstrates the earned resolution next to it.
- The known-FQN table becomes more load-bearing: a wrong entry would now
  mis-resolve wildcard-imported names instead of only single-type-imported
  ones. It remains data in one file, and every earned fact's provenance says it
  came through this path.
- Measured on `jhipster-sample-app` after implementation (the M7 acceptance
  run, 2026-08-13): **41 endpoints** where M5 measured 2, from 80 annotations
  earning `wildcard-import` resolution. 8 mapping refusals remain, all in
  `AccountResource`, where a first-party
  `io.github.jhipster.sample.web.rest.errors.*` wildcard competes with the
  Spring one — condition 2's genuine case, refused and named. The cross-stack
  linker now has endpoints to match: 6 Angular calls matched ambiguously
  (`GET {}/{}` — the URL is built dynamically, so the pattern matches 8
  endpoints equally well; ADR-0018's URL-builder gap, out of M7's scope) and
  11 matched nothing, so the published link count is zero, as this ADR
  expected. `tiny-spring`'s `LegacyReportController` (now two wildcards)
  still refuses, and `DailySummaryController` demonstrates the earned
  resolution beside it — both asserted exactly in the golden.
