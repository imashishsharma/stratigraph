# Changelog

Notable changes per release. Dates are release dates; the ADR behind a
decision is linked where there is one, because *why* is usually the part worth
reading.

This project follows semantic versioning. The **fact store schema** and the
**`--format json` documents** are the two things a consumer can depend on: the
schema carries a `user_version` and is migrated forward, and every JSON
document carries `format`, which moves only for a change a parser could trip
over.

## [1.6.1] — 2026-08-14

- The `--fail-on` tests needed a JDK, which the release workflow does not have
  until after `npm test`. 1.6.0 never published because of it.

## [1.6.0] — 2026-08-14

### Added

- **Kotlin**, parsed by the same extractor as Java, in the same run — so a
  Kotlin service and the Java repository it injects are one graph. Constructor
  injection, `@Entity`/`@Id` into the ER model, and `@GetMapping` into the HTTP
  surface all work; a *call* from Kotlin into Java does not resolve and says so
  rather than guessing ([ADR-0029](docs/adr/0029-kotlin-rides-the-java-extractor.md)).
  The extractor jar is 87 MB as a result.
- **`stratigraph diff`** — findings gained and resolved between two runs, and
  how the structure moved. `--fail-on-new <severity>` fails a build only for
  regressions, which is the gate a repository with existing debt can switch on
  today ([ADR-0027](docs/adr/0027-comparing-two-runs.md)).
- **`--format json`** on every command that produces a result, as a versioned
  contract rather than a dump of internal types. Progress stays on stderr, so
  a pipe carries only the document.
- **`--fail-on <severity>`** on `analyze` and `report`, exiting **3** — distinct
  from 1 and 2, so a pipeline can tell "nine high findings" from "the tool
  could not run".
- **`stratigraph fetch-extractor`** downloads the JVM extractor jar, verified
  against a checksum pinned into the npm package by the same release job that
  built and attached it. Replaces "clone the repository and run maven".
- **A Docker image** carrying its own JDK, git and extractor.
- **`stratigraph prune`** — drop old runs and actually return the disk, with
  every run listed and its fate before anything is deleted.
- `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md` and issue templates.

### Fixed

- **A report of a run nobody analysed claimed every rule had passed.** It now
  says no rule was evaluated, in the HTML, in `findings.md` and on stderr
  ([ADR-0026](docs/adr/0026-coverage-describes-the-store.md)).
- **Severity now reflects how checkable a finding is.** Co-change between files
  no extractor parses — `gradle-wrapper.jar` and `gradlew.bat` — was rated
  `high` on strength alone while the finding's own detail said the claim was
  not checkable. On spring-petclinic that was 20 of 23 high findings; it is now
  7, and on nestjs/nest the high band is entirely package cycles
  ([ADR-0028](docs/adr/0028-severity-and-what-was-checkable.md)).
- `analyze`, `history`, `extract` and `ingest` printed a raw better-sqlite3
  stack trace when run before `init`. They now name the missing store and the
  command that fixes it, like `report` and `mcp` already did.
- `findings.md` carries its own limits section. It is the file that leaves the
  machine, with none of the report around it.

## [1.5.0] — 2026-08-13

- The HTML report is tabbed, with a summary page, a light default and
  white-label branding — a document a company can put its own name on
  ([ADR-0024](docs/adr/0024-the-tabbed-report.md),
  [ADR-0025](docs/adr/0025-report-theming.md)).

## [1.4.0] — 2026-08-13

- **A wildcard-imported annotation is now *earned* rather than refused.** It
  resolves when the known-annotation table places it in the one wildcard
  package and no type of that name is declared anywhere in the source set;
  every remaining refusal names the condition that failed. On a JHipster
  monolith this is the difference between 2 endpoints and 41
  ([ADR-0023](docs/adr/0023-earning-resolution-through-a-wildcard-import.md)).
- C4 level 4 — one class diagram per package — and the ER model read out of
  declared O/R mappings, including fields inherited from a mapped superclass
  ([ADR-0022](docs/adr/0022-code-level-and-the-data-model.md)).
- The extractor records the type arguments erasure throws away, without which
  three of four petclinic entity associations had an unreadable target.
- The static HTML report, ranked findings, and the publishability rule: a
  finding with no citation is not published, is excluded from every count, and
  the number excluded is printed
  ([ADR-0021](docs/adr/0021-finding-rank-and-publishability.md)).
- Diagrams are laid out and rendered as inline SVG — no browser, no JavaScript,
  deterministic to the pixel ([ADR-0020](docs/adr/0020-the-report-renders-its-own-svg.md)).

## [1.3.0] — 2026-07-31

- **The TypeScript and Angular extractor**: components, injectables, NgModules,
  DI edges, routes and template-only component relationships — read from
  decorators rather than from Angular, so no `node_modules` and no compiling
  project is needed ([ADR-0016](docs/adr/0016-angular-without-the-angular-compiler.md)).
- Angular HTTP calls are matched against Spring endpoints as **inference**,
  excluded from the package graph, refused on a tie
  ([ADR-0018](docs/adr/0018-cross-stack-links-are-inferences.md)).
- RxJS subscriptions with no way to unsubscribe.
- `extract` runs every applicable extractor into **one run**, which is what lets
  the two stacks be joined at all.

## [1.2.0] — 2026-07-31

- **The MCP server** — nine read-only tools over stdio, one pinned run, and
  empty answers that say which kind of empty they are
  ([ADR-0015](docs/adr/0015-the-mcp-query-surface.md)).

## [1.1.0] — 2026-07-30

- The grounding contract hardened: rule 3 stopped rejecting ordinary English
  and abbreviation as invention, and a hole in it was closed
  ([ADR-0013](docs/adr/0013-the-grounding-contract.md)).
- Credential handling: config files are chmod-tightened even when they already
  exist, and the credential resolves from the injected environment.
- Documented that a Claude Pro or Max subscription is not API credit.

## [1.0.1] — 2026-07-29

- **The CLI did nothing when installed.** `argv[1]` is the `node_modules/.bin`
  symlink while `import.meta.url` is the real path, so the entry-point check
  never matched and the process exited 0 having done nothing.

## [1.0.0] — 2026-07-29

- The SQLite fact store with its schema and migrations, the NDJSON extractor
  protocol, the Java extractor, and `init` / `ingest` / `doctor`
  ([ADR-0001](docs/adr/0001-language-split.md)–[ADR-0004](docs/adr/0004-distribution-and-runtime-independence.md)).

[1.6.1]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.6.1
[1.6.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.6.0
[1.5.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.5.0
[1.4.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.4.0
[1.3.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.3.0
[1.2.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.2.0
[1.1.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.1.0
[1.0.1]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.0.1
[1.0.0]: https://github.com/imashishsharma/stratigraph/releases/tag/v1.0.0
