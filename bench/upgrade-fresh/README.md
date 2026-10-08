# The upgrade agent on 9 apps it had never seen

The agent's rules and known fixes were developed on the gap map's 10 repos
([`../upgrade-gap/`](../upgrade-gap/README.md)), so its 5/10 there could be a
home-turf number. This corpus checks that. It is nine public Spring Boot apps
the agent was never run on while it was being built, chosen mechanically:

- GitHub code search for root `pom.xml` files with `spring-boot-starter-parent`;
- kept if 25+ stars, not a fork, a single Maven module, Boot 2.0–3.4, and at
  least two Java files under `src/test`;
- excluded if in either existing corpus.

Each app is pinned at its newest commit on 2026-10-08 (`corpus.tsv`). The
baseline JDK follows the declared `java.version`. There were no per-repo
flags and no human edits.

Run with `CORPUS=bench/upgrade-fresh/corpus.tsv bench/upgrade-gap/agent-bench.sh --ai`.

## Result

**8 of 9 reach parity**: every test that passed before the upgrade passes
after it. The ninth (jtt808-demo) builds but runs no tests, and its report
says its behaviour is unverified.

| App | Path | Result | Tests passing after (before) | Known fixes | AI fixes | Min | AI $ |
|---|---|---|---|---|---|---|---|
| microservice-rbac-user-management | 2.2 → 3.5 | ✅ parity | 95 (95) | 0 | 1 | 2 | 0.16 |
| OnlineBankingRestAPI | 2.6 → 3.5 | ✅ parity | 67 (67) | 0 | 1 | 3 | 0.47 |
| Refactoring-Bot | 2.1 → 3.5 | ✅ parity | 62 (62) | 1 | 1 | 1 | 0.24 |
| spring-boot-testing-reddit-clone | 2.1 → 3.5 | ✅ parity | 5 (5) | 1 | 2 | 4 | 0.76 |
| sql-dog-backend | 3.1 → 4.0 | ✅ parity | 5 (5) | 0 | 3 | 3 | 0.62 |
| springboot-file-uploader | 2.0 → 3.5 | ✅ parity | 2 (2) | 0 | 1 | 3 | 0.18 |
| xiaoyuanxianyu | 2.2 → 3.5 | ✅ parity | 1 (1) | 1 | 2 | 2 | 0.40 |
| Opentheso | 3.3 → 4.0 | ✅ parity | 1 (1) | 0 | 2 | 4 | 0.42 |
| jtt808-demo | 2.7 → 3.5 | builds; **unverified** (no tests) | 0 (0) | 0 | 1 | 9 | 0.54 |

## Read this before quoting the number

- **How much a parity verifies depends on the tests.** Three apps carry real
  suites (95, 67, 62 passing tests). Five rest on five or fewer: many of
  their tests fail before the upgrade too (no database or service in the
  sandbox), and a test red before and after says nothing either way. The
  reports list those as *failed before and still fail*. They don't hide
  them.
- **Three of the AI fixes changed application code to make failing tests
  pass** (reddit-clone, file-uploader, xiaoyuanxianyu). The reports list them
  first for review, under *Application code changed to make failing tests
  pass*.
- These apps are smaller and simpler than the gap map's WebGoat or JHipster.
  None of them hit a decision (authorisation, HTTP contract), so none
  exercised the handoff.

## What the unseen corpus found in the agent

Four bugs, each fixed with a test and then confirmed by re-running the app:

| App | What went wrong | Fix |
|---|---|---|
| OnlineBankingRestAPI, xiaoyuanxianyu | `mvnw` committed without its executable bit (authored on Windows): the run died on `EACCES` | Run the wrapper through `sh` |
| Refactoring-Bot | After the Maven-wrapper known fix, Surefire failed with its reason on the lines after `on project X:`; the parser saw no failure and judged the build worst | Read the reason from the following lines. A failed build no rule recognises now yields a failure with its last error lines. |
| OnlineBankingRestAPI | A Maven Central timeout during the baseline made a healthy app look baseline-broken | Retry a build once on a transfer timeout or reset, and name network failures as such |
| (all, on Windows CI) | AI-edit tidying compared against the stored blob, not the checked-out file, so CRLF files turned LF under `core.autocrlf` | Compare against `git cat-file --filters` |

The first pass, before these fixes, scored 5 of the 7 apps it could run at
parity. The table above is after them.
