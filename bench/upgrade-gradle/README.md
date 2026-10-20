# The upgrade agent on Gradle builds

Gradle support (ADR-0047, amendment of 2026-10-20) was measured on two public
Gradle apps. Both were picked because they are well known and their pinned
commits are on Boot 2. They were not picked for being easy. Two apps are a
smoke test, not a benchmark. The numbers below are reported as they came out.

| App | Commit | Path | Gradle |
|---|---|---|---|
| [spring-boot-realworld-example-app](https://github.com/gothinkster/spring-boot-realworld-example-app) | `ee17e31` (master) | 2.6.3 → 3.5 | 7.4 → 7.6.6 (moved by the recipe) |
| [jhipster-sample-app-gradle](https://github.com/jhipster/jhipster-sample-app-gradle) | `v7.9.4` | 2.7.3 → 3.5 | 7.4.2 → 7.6.6 |

Run with `stratigraph upgrade run <repo> --to 3.5 --ai claude-code`. The only
per-repo flag was `--build-args "-x webapp -x webapp_test"` on JHipster (see
below). There were no human edits.

## Result

| App | Result | Tests passing after (before) | Known fixes | AI fixes kept / rejected | Builds | Min | AI $ |
|---|---|---|---|---|---|---|---|
| spring-boot-realworld-example-app | ✅ parity | 68 (68) | 1 | 1 / 0 | 5 | 3 | 0.33 |
| jhipster-sample-app-gradle 7.9.4 | 🔴 stuck, 1 compile error | — (162 of 172) | 0 | 4 / 1 | 7 | 41 | 2.14 |

### spring-boot-realworld-example-app

- **Baseline.** Upstream master already fails its own `spotlessJavaCheck` (a
  test file has format violations). The agent rebuilt with the check skipped,
  kept it skipped for every build, and says so in the report. 68/68 tests pass.
- **The recipe** ran through OpenRewrite's Gradle plugin, applied by an init
  script. It changed 37 files: Boot 3.5.16, Java 17, mybatis 3, rest-assured
  5, the Security DSL, and the wrapper moved to Gradle 7.6.6.
- **What it left.** First, DGS 4.9's graphql-java removed
  `DataFetcherExceptionHandler.onException`, which is a judgment (category
  `supertype-api-change`). The AI moved the override to `handleException`
  with the same errors, now wrapped in a `CompletableFuture`. Second, the recipe
  pinned rest-assured 5.1.1 while Boot manages 5.5.7, so two versions ended up
  on one classpath and 35 tests failed with a `NoSuchMethodError`. In the first
  run the AI dropped the pins. That is now the known fix
  `gradle-drop-managed-pins`: it reads Spring Boot's BOM from the local cache
  and drops only the pins the BOM manages and the failure names.

### jhipster-sample-app-gradle 7.9.4

- **Frontend skipped.** JHipster 7's Angular 14 tooling spawns an x86-only
  binary, and the measuring machine is Apple Silicon without Rosetta. That
  fails with `spawn Unknown system error -86` and then hangs. The run therefore
  used `-x webapp -x webapp_test`. Only the backend is measured.
- **Baseline.** 162 of 172 tests pass. The 10 red ones are not the upgrade's to
  fix, and the report says so.
- **What the AI did (4 commits kept).** Hibernate 6 versions and the removed
  `PASS_DISTINCT_THROUGH` hint. Boot 3's BOM imported over
  `jhipster-dependencies` 7.9.3, which pinned the Boot 2.7 stack (javax
  servlet, thymeleaf-spring5), the case the new category
  `jakarta-api-missing` names. Liquibase label API changes. Spring Security
  6.1's `permissionsPolicy` → `permissionsPolicyHeader`, with the policy string
  unchanged. One attempt made things worse and was rejected.
- **Where it stopped.** `LiquibaseConfiguration.java:58`: JHipster 7's
  `jhipster-framework` calls a Liquibase API (`setLabelFilter`) that the Boot
  3.5-managed Liquibase no longer has. The real fix is JHipster 7 → 8, a
  generator upgrade, which is the project's decision. Stopping there is the
  intended behaviour.

## What the runs changed in the agent

Each of these is a commit with a test written from the real output:

- A download timeout (the wrapper's distribution, a dependency, the recipe's
  own fetch) is a `network` failure, retried once and handed back as such.
  Before, it was reported as a broken baseline.
- A formatting check that already fails at baseline is skipped rather than
  blocking the run. This applies to Maven too.
- A build stopped by the timeout says so, as a `build-timeout` decision.
- Files the baseline build creates (a `package-lock.json` from an npm task) are
  never committed. One had landed in an AI commit.
- The OpenRewrite Gradle plugin is pinned to 7.39.0. Versions 7.40 and later
  need a `rewrite-bom` that only Code Genome serves.
- New categories: `gradle-too-old`, `supertype-api-change`,
  `jakarta-api-missing`. Linkage errors (`NoSuchMethodError` and similar)
  count as `third-party-library`.

## The measuring machine

One of GitHub's four release-asset addresses was unreachable from it.
Java's HTTP client tries only the first address a host resolves to, so Gradle
distribution downloads timed out where curl succeeded. The distributions were
placed in the Gradle and OpenRewrite caches with curl before the runs. This is
a property of that network, not of the agent, which now reports it as a
network failure.
