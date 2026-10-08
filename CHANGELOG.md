# Changelog

Notable changes per release. Dates are release dates; the ADR behind a
decision is linked where there is one, because *why* is usually the part worth
reading.

This project follows semantic versioning. The **fact store schema** and the
**`--format json` documents** are the two things a consumer can depend on: the
schema carries a `user_version` and is migrated forward, and every JSON
document carries `format`, which moves only for a change a parser could trip
over.

## [2.1.0] — 2026-10-08

### Added

- **`stratigraph upgrade plan|run`: a Spring Boot upgrade agent**
  ([ADR-0047](docs/adr/0047-the-upgrade-agent.md)). It handles 2.7 → 3.5 and
  3.x → 4.0 for Maven projects.
  - `plan` reads the project with no build and no network. It lists the
    versions and the JDKs it will use, and cites each file:line where the gap
    map saw an upgrade break.
  - `run` works on a new branch. It builds and tests the project as it is,
    then runs the OpenRewrite recipe as one commit. It then loops: build,
    classify each failure, apply a known fix, rebuild. With `--ai
    claude-code`, the Claude Code CLI also attempts what the known fixes
    cannot.
  - A change is kept only if the build gets further and no passing test
    turns red. A change that disables or deletes tests is rejected outright.
  - Decisions are never attempted: an authorisation rule, or an HTTP
    contract change such as how trailing slashes are matched.
  - `upgrade-report.md` is committed on the branch. It shows every test
    compared with its result before the upgrade, and the commits in three
    layers: recipe, known fixes and AI fixes. For everything left it gives
    the evidence, what was tried, and the options for each decision.
  - On the 10 public apps of [`bench/upgrade-gap/`](bench/upgrade-gap/README.md),
    OpenRewrite alone left 0/10 green. Three reached parity with no human
    edits (spring-petclinic, jwt-spring-security-demo, jhipster-sample-app).
    One stops with an HTTP-contract decision and its options
    (spring-petclinic-rest). The rest come back with categorised, cited
    reports.
- **Incremental re-runs** ([ADR-0046](docs/adr/0046-incremental-runs-replay-unchanged-inputs.md)).
  `extract` replays an extractor's stored facts when every file it could read,
  and the extractor itself, are byte-identical to the last run. `history`
  reuses the last mine when HEAD and every log option are unchanged. Both are
  exact by construction; `--no-reuse` turns them off. On nacos, a
  TypeScript-only edit refreshes in about 15 s instead of about 78 s. A Java
  or Kotlin edit still re-parses the whole program.
- **The MCP server stays current.** Without `--run`, it moves to each newer
  completed run and announces the move in the next answer. Every answer names
  the files changed on disk since the run read them.

### Changed

- **`analyze` is about 8× faster on large repositories.** Cycle hops, cluster
  neighbours and MCP dependency rows no longer re-derive package ancestry once
  per row (nacos: 33 s → 4 s, with identical findings and citations).
- The README's MCP section lists all thirteen tools.
- Releases publish through npm trusted publishing (OIDC). No npm token is
  stored anywhere.

### Fixed

- **A JDK with no `release` file was reported as absent** (e.g. Corretto 8).
  `java -version` prints to stderr and exits 0, and only stdout was read.
  This affected `doctor` and the JDK choice.

## [2.0.1] — 2026-09-29

### Fixed

- **The Docker image ships a JDK, not a JRE.** The 2.0.0 image lacked
  `jdk.compiler`, so the Java extractor could not run in it and Java code went
  unread (reported honestly as a skipped extractor).
- **JHipster-style Angular clients link to their Spring endpoints.** A base
  URL glued to a relative path (`{}api/x`) is read as that path, and
  `this.resourceUrl` resolves to a `readonly` field's literal initializer,
  including one on a base class in the same file. jhipster-sample-app had no
  cross-stack links in 2.0.0 ([ADR-0018](docs/adr/0018-cross-stack-links-are-inferences.md)).
- The Windows cache-path test and the image's `doctor` check in CI.

### Added

- A product website at https://imashishsharma.github.io/stratigraph/, now the
  npm package's homepage.

## [2.0.0] — 2026-09-29

v1.6.1 was run on a real enterprise repository and produced output a senior
engineer rejects in thirty seconds: lockfiles ranked riskiest, an empty ER
diagram, aggregator poms drawn as containers, and nothing saying how much of
the code had been read. 2.0 makes every view right or honest about why not,
and measures it against 20 public repositories labelled by hand.

### Breaking

- **Fact-store schema 2** (migration 0002): file roles, the hotspot window,
  per-extractor outcomes. Run `stratigraph init` to migrate; re-extract.
- **Hotspots rank recent change in source files** — commits in a 12-month
  window, sweeps and `.git-blame-ignore-revs` excluded, complexity compared
  within file type — and `find_hotspots` ranks by `change-complexity`
  ([ADR-0031](docs/adr/0031-hotspots-rank-recent-change-in-source.md)).
- **`extract` no longer fails when no extractor can run**; it records a run
  whose extractors were skipped, and commands default to the latest
  *completed* run ([ADR-0032](docs/adr/0032-honest-runs.md)).
- **Test code is not architecture**: package graph, cycles, C4, class diagrams
  and clustering leave it out, and say how much
  ([ADR-0034](docs/adr/0034-test-code-is-not-architecture.md)).
- **A C4 container is a deployable** — a Boot app, a WAR or an Angular/Nx
  application, proved by a build file or a main class; aggregator, BOM and
  library modules are not containers
  ([ADR-0040](docs/adr/0040-containers-are-deployables.md)).
- **Angular packages are structural boundaries** (NgModule, lazy route,
  project), not directories — package fqns change for Angular repositories
  ([ADR-0042](docs/adr/0042-angular-structure.md)).

### Added

- **Every file has a role** — source, test, generated, vendored, lockfile,
  manifest, migration, config, docs, asset — each citing the rule that assigned
  it ([ADR-0030](docs/adr/0030-every-file-has-a-role.md)).
- **Coverage on every view and every MCP answer**: a ratio per extractor and
  per view, with the reasons they differ; a view below its threshold
  (`coverage.minRatio`, default 50%) is withheld with the reason
  ([ADR-0033](docs/adr/0033-coverage-is-a-ratio.md)). The report's Summary
  shows the run's status and what each extractor read.
- **`stratigraph bench`**: the pipeline scored against a pinned 20-repository
  corpus and ground truth labelled without the tool; `--private` for a local
  repository, aggregates only; a nightly CI job
  ([ADR-0035](docs/adr/0035-quality-is-measured.md)).
- **The data model as JPA maps it**: default table names through the module's
  naming strategy, inheritance, `schema=`, embedded values, `@MappedSuperclass`
  only; repositories, `@Query` and JDBC SQL read and write tables
  ([ADR-0036](docs/adr/0036-the-data-model-as-jpa-maps-it.md)).
- **A migrations extractor** — Liquibase (XML/YAML/JSON/SQL, with includes),
  Flyway in version order, standalone DDL — overlaid on the mapping, with
  disagreements as `schema-drift` findings
  ([ADR-0037](docs/adr/0037-the-schema-as-migrations-define-it.md)).
- **Wildcard imports resolved through complete package listings** of common
  frameworks ([ADR-0038](docs/adr/0038-complete-package-listings.md)).
- **An offline Maven classpath when the cache has it**, Lombok constructor
  injection, `@Bean` parameters, and a count of unresolved injection points
  ([ADR-0039](docs/adr/0039-classpath-lombok-and-spring-wiring.md)).
- **Split packages** belong to each module that declares them
  ([ADR-0041](docs/adr/0041-split-packages.md)); **TypeScript service calls**
  are edges.
- **The first hour**: the report opens with five answers — the parts, the
  data, the risk, what is changing, who holds the knowledge — each with its
  coverage.
- **MCP tools** `what_breaks_if`, `who_knows`, `where_is_table_written` and
  `explain_hotspot`.
- **`stratigraph scan [repo]`**: the whole pipeline in one command, ending
  with what was and was not seen.

### Changed

- Bus-factor findings are `medium` only for a file that is a hotspot or among
  the most depended-on; otherwise `low`.

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
