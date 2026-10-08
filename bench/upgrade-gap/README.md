# Upgrade gap map: what OpenRewrite alone leaves broken

This is the validation experiment from the Upgrade Agent note ("Validation plan", item 1). I ran OpenRewrite's Spring Boot upgrade recipe, with no other help, on 10 public Maven single-module Spring Boot apps. For each app I logged every breakage, classified it, and repaired it by hand under a time box to find out what kind of judgment each breakage needs.

## Headline

- **0/10 repos were green after the recipe with no human edits.** Nine failed the build outright (compile error, unresolvable POM, or a formatting check). The tenth, dddsample-core, compiled but 20 of its 131 tests went red.
- **44 distinct breakages across the 10 repos.** 27 of them (61%) needed judgment rather than a lookup.
- **9 of the 44 were introduced by the recipe itself.** The recipe produced invalid or ill-typed Java, injected version pins that broke things, or bumped a code generator into a bug.
- **7/10 repos were back to their baseline test results after time-boxed manual fixes.** Each took 1 to 6 fix-and-rebuild iterations. Classified effort was 12 to 154 minutes per repo, with a median of about 60 (`judgment_minutes` + `mechanical_minutes` in `results.json`).
- **3/10 were still red at the time box:**
  - WebGoat: 9/235 tests red.
  - spring-petclinic-reactjs: 182/183 red, from one security-chain decision.
  - dddsample-core: 19/131 red, from a Hibernate merge-semantics change.
- **The closest case to green was spring-petclinic 3.5 → 4.0.** Once the recipe could run at all, the only remaining problem was formatting. The recipe run aborted twice first: it tried to download a Gradle distribution for a repo that also carries a `build.gradle` (see Method notes). After the recipe, the fix was `spring-javaformat:apply`, and then all 56 tests passed.

## Method

- **Tooling.** rewrite-maven-plugin 6.46.1 and rewrite-spring 6.37.1, the latest on Maven Central on 2026-09-29. The plugin is invoked by coordinates, and no pom was edited to add it.
- **Recipes.**
  - Boot 2.x repos: `org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5`. This chains through 2.7 and 3.0 to 3.4.
  - Boot 3.x repos: `org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0`. The recipe resolved Boot to 4.0.8. There is no `UpgradeSpringBoot_4_1` yet.
- **Pinning.** Every repo is pinned to a full SHA (see `corpus.yaml`). For 6 repos the SHA is the last commit before the project's own upgrade commit, so the upstream history holds a human reference migration. I used it twice: for petclinic-rest's openapi-generator fix and for WebGoat's sequence fix.
- **Steps per repo (`run.sh`):** clone at SHA → baseline `mvn -B verify -Dmaven.test.failure.ignore=true` on the original JDK → recipe on JDK 17 → diff stats → the same build on JDK 17. Each subsequent manual fix is a rebuild via `fix.sh`, logged as `fixN` with a note, and the recipe output is committed in the scratch clone so manual edits diff cleanly.
- **Environment limits.** JDK 17 was the newest available (there is no JDK 21), and there was no Docker and no browser. Tests that need Docker, Firefox or an external DB are red at baseline. They are excluded from attribution; each such case is named in `corpus.yaml` and the per-repo table below.
- **Classification.** Every breakage in `results.json` has a category, a location (file:line or test name), a message excerpt, the fix, `judgment|mechanical`, a minute estimate and whether the recipe introduced it. "Mechanical" means a deterministic rename or version lookup that a better recipe could do. "Judgment" means choosing among behaviours, diagnosing a runtime or test failure back to its cause, or rewriting code the recipe gave up on.
- **What the minutes mean.** They are my estimate of the human or agent effort for that item once found, not measured wall time. Wall time was dominated by builds: a WebGoat rebuild takes about 3 minutes and a reactjs rebuild about 10.

## Per repo

"Tests" are shown as total / failures / errors / skipped. Links are to trimmed logs under `logs/`.

| Repo | Path | Recipe diff | Baseline | After recipe, no edits | Breakages (judgment) | After time-boxed fixes |
|---|---|---|---|---|---|---|
| [spring-petclinic-rest](logs/spring-petclinic-rest.txt) | 2.6.2 → 3.5 | 44 files, +149/−124 | green, 172/0/0/0 | compile fail: generated code still `javax.validation` | 4 (3) | green, 172/0/0/0, after 6 iterations |
| [jwt-spring-security-demo](logs/jwt-spring-security-demo.txt) | 2.1.8 → 3.5 | 17 files, +91/−93 | green, 16/0/0/0 | compile fail: `WebSecurityConfigurerAdapter` kept (`WebSecurityConfig.java:26`) | 2 (2) | green, 16/0/0/0, after 2 iterations |
| [mall-tiny](logs/mall-tiny.txt) | 2.7.5 → 3.5 | 32 files, +307/−285 | compiles; tests disabled in pom | compile fail: springfox half-migrated (`BaseSwaggerConfig.java:11`) | 2 (2) | compiles, after 2 iterations |
| [kafdrop](logs/kafdrop.txt) | 2.7.5 → 3.5 | 23 files, +134/−104 | compiles; 4/5 tests need Docker | compile fail: `--release` vs `--add-exports` | 2 (1) | compiles; same 4 Docker-only errors, after 3 iterations |
| [WebGoat](logs/WebGoat.txt) | 2.7.1 → 3.5 | 78 files, +267/−248 | green, 235 unit + 39 IT | compile fail: 38 errors in 6 files | 10 (7) | **red**: 235/4/5/2, 2 items unresolved, after 4 iterations |
| [spring-boot-blog-app](logs/spring-boot-blog-app.txt) | 2.7.4 → 3.5 | 27 files, +91/−87 | 46 unit (1 err) + 7 IT (2 err), all browser tests needing Firefox | POM unresolvable: `selenium-bom:4.3.0` | 6 (4) | same as baseline, after 5 iterations |
| [spring-petclinic](logs/spring-petclinic.txt) | 3.5.6 → 4.0 | 13 files, +47/−33 | green, 56/0/0/2 | recipe aborted twice (Gradle download); then `spring-javaformat:validate` fail | 2 (0) | green, 56/0/0/2, after 1 iteration |
| [jhipster-sample-app](logs/jhipster-sample-app.txt) | 3.5.8 → 4.0 | 31 files, +121/−98 | green, 48 unit + 163 IT | POM invalid: `spring-boot-loader-tools` version missing | 9 (4) | green, 211/0/0/0, after 6 iterations |
| [spring-petclinic-reactjs](logs/spring-petclinic-reactjs.txt) | 3.2.1 → 4.0 | 21 files, +157/−170 | green, 183/0/0/0 | compile fail: openapi-generator 7.16 output does not compile | 4 (2) | **red**: 183/0/182/0 (`UnreachableFilterChainException`), after 4 iterations |
| [dddsample-core](logs/dddsample-core.txt) | 3.3.10 → 4.0 | 18 files, +62/−56 | green, 131/0/0/3 | **compiles, 131/0/20/2** | 3 (3) | **red**: 131/0/19/2 (Hibernate `StaleObjectStateException`), after 2 iterations |

## The upgrade agent on the same 10 repos (2026-10-08)

`stratigraph upgrade run --ai claude-code`
([ADR-0047](../../docs/adr/0047-the-upgrade-agent.md)) ran on the same pinned
commits with the same JDKs and Maven flags. Each repo was cloned fresh, and
there were no human edits. To reproduce: `bench/upgrade-gap/agent-bench.sh
--ai`. The AI cost is what Claude Code reported per run.

| Repo | Path | OpenRewrite alone | Agent | Tests after (baseline) | Known fixes | AI fixes | Min | AI $ |
|---|---|---|---|---|---|---|---|---|
| spring-petclinic | 3.5 → 4.0 | red | ✅ parity | 54/56 (54/56) | 1 | 0 | 1 | 0 |
| jwt-spring-security-demo | 2.1 → 3.5 | red | ✅ parity | 16/16 (16/16) | 0 | 2 | 2 | 0.52 |
| jhipster-sample-app | 3.5 → 4.0 | red | ✅ parity | 211/211 (211/211) | 2 | 5 | 9 | 1.90 |
| dddsample-core | 3.3 → 4.0 | red (20 tests) | ✅ parity | 128/131 (128/131) | 0 | 1 | 8 | 1.81 |
| kafdrop | 2.7 → 3.5 | red | ✅ parity | 1/5 (1/5; 4 need Docker) | 2 | 1 | 2 | 0.30 |
| mall-tiny | 2.7 → 3.5 | red | builds; **unverified** (no tests run) | 0/0 | 0 | 2 | 3 | 0.58 |
| spring-petclinic-rest | 2.6 → 3.5 | red | 🟡 needs a decision | 151/172 (172/172) | 1 | 1 | 3 | 0.66 |
| WebGoat | 2.7 → 3.5 | red | stuck | 267/274 (272/274) | 3 | 6 | 14 | 2.54 |
| spring-boot-blog-app | 2.7 → 3.5 | red | stuck | 49/53 (50/53) | 1 | 4 | 9 | 1.64 |
| spring-petclinic-reactjs | 3.2 → 4.0 | red | 🟡 needs a decision | 1/183 (183/183) | 1 | 3 | 2 | 0.52 |

**5/10 reach parity with no human edits, and 2 more stop at a decision only a person should make**: every test that passed before
the upgrade passes after it. OpenRewrite alone reached 0/10. One more builds
but runs no tests, and the report says so instead of calling it green.
Every non-parity run ends with a committed `upgrade-report.md` that gives,
for each remaining failure, the evidence, what was tried and why it was
rejected, and, for a decision, the options.

- **spring-petclinic-reactjs** also stops on purpose. The generator,
  Jakarta, Spring 7 and Jackson 3 breakages were all fixed, and it compiles.
  Then two `SecurityFilterChain`s both match every request, and Spring
  Security refuses to start. Which chain owns which paths is an
  authorisation decision; it is handed off with three options. 64 tests that
  fail only because Spring cached that context failure are reported as
  consequences, not separate problems.
- **spring-petclinic-rest** stops on purpose. 21 tests fail because Spring 6
  no longer matches a trailing slash, and keeping or dropping that is an API
  contract the agent will not choose. Its coverage gate is reported as
  *expected to clear* rather than as work.
- **WebGoat** ends with 5 baseline tests red against the gap map's 9. Its 39
  integration tests had silently stopped running under the upgrade; the
  agent noticed and got them running again. One HTTP-contract decision is
  handed off.
- **dddsample-core** stayed red under the gap map's time-boxed manual
  fixing. The agent fixed it, and its diff needs a careful review: it resets
  the static sample data's ids by reflection to fit Hibernate 7's merge
  semantics. The commit message explains why.

### What the benchmark changed in the agent

Every one of these was found by a run going wrong, fixed with a test written
from that run, and checked by re-running the repo:

| Found on | What went wrong | Fix |
|---|---|---|
| jwt-demo | The fixer billed a low-credit `ANTHROPIC_API_KEY` from the shell instead of the user's Claude login | The key is dropped unless `--ai-use-api-key`. A fixer that cannot run is reported once and not retried. |
| petclinic-rest, mall-tiny | A JDK 8 with no `release` file was invisible | `java -version` is read from stderr |
| kafdrop | `./mvnw` pinned Maven 3.6.1, too old for Boot 3.5's plugins; the AI could not edit `.mvn/` | Known fix: move the wrapper to Maven 3.9 |
| kafdrop | A failed `clean` left the previous build's test reports to be read as new | Report files are deleted before every build |
| WebGoat | The `-parameters` property never reached javac on a pinned compiler plugin | An explicit `<arg>-parameters</arg>`, as the AI found |
| WebGoat | 39 integration tests silently stopped running in a green build | A test that passed and no longer runs is a failure |
| WebGoat | Getting those tests running was rejected for "turning 5 red" | Newly red means passing in the *previous* build |
| blog-app, jhipster | Reports in `target/test-results/` were not found (baseline of 0) | Any `TEST-*.xml` under `target/` |
| blog-app, kafdrop, reactjs (×3) | Fixes that let the build get further were rejected for revealing errors that were always there | Progress is judged by stage, lifecycle goals reached, javac phase (options, parsing, imports), then counts |
| blog-app | The recipe's invalid `@Type(uuid-char.class)` was "uncategorised" | Compile errors are categorised by the source line they point at |
| petclinic-rest | A coverage gate after red tests was worked on as a task | Consequences wait for their causes and do not set the status |
| reactjs | 64 tests failing on Spring's cached context failure were "unrecognised" | A consequence of the context's first failure |
| mall-tiny | "Parity" with no tests looked green | Reported as unverified |

## Categories across all 10 repos

"Repos affected" counts distinct repos. "Minutes" is the sum of the per-item estimates.

| Category | Items | Repos affected | Mechanical / judgment | Minutes | Recipe-introduced | Typical fix |
|---|---|---|---|---|---|---|
| Spring Security DSL / config migration | 5 | 5 (50%) | 0 / 5 | 110 | 3 | Rewrite `WebSecurityConfigurerAdapter` and `GlobalMethodSecurityConfiguration` into `SecurityFilterChain` / handler `@Bean`s. The recipe converts to lambda DSL but leaves the adapter class, sometimes with a `/*~~(Migrate manually…)~~>*/` marker (WebGoat `container/WebSecurityConfig.java`) or an ill-typed `AuthorizationManagerRequestMatcherRegistry registry = http.authorizeHttpRequests(withDefaults())` (mall-tiny `SecurityConfig.java:47`). Two chains matching any request now fail at startup (reactjs). |
| Third-party lib without a drop-in compatible version | 7 | 5 (50%) | 1 / 6 | 100 | 2 | springfox → springdoc rewrite: kafdrop gets a `/* TODO … too complex */` Docket; mall-tiny gets a half-migrated, uncompilable class. jhipster-framework 9.0.0-beta.0 → 9.0.0. jackson-datatype-hibernate6 → 7. Flyway DB module split (`flyway-database-hsqldb`). Wiremock jetty9 (javax servlet): unresolved. HtmlUnit pin (dddsample). |
| Hibernate 6/7 behaviour and API | 6 | 4 (40%) | 1 / 5 | 110 | 1 | HQL using column names (`pet_id`). Auto-flush `TransientObjectException`. Per-entity sequence naming vs a Flyway `HIBERNATE_SEQUENCE` (WebGoat). Merge of detached static entities (dddsample): unresolved. Removed metadata iterators. The recipe turned `@Type(type="uuid-char")` into invalid Java `@Type(uuid-char.class)` (blog-app `ReceivedFile.java:20`). |
| Build plugin / compiler config | 6 | 5 (50%) | 4 / 2 | 54 | 1 | Recipe output fails formatting checks (spring-javaformat, spotless). The recipe-added `<release>` clashes with `--add-exports` (kafdrop). Old maven-compiler-plugin 3.8.0 drops `-parameters`, and Spring 6.1 needs them (WebGoat, 25 tests). Unmanaged `spring-boot-loader-tools` version. Stale `selenium.version` override. |
| Codegen (openapi-generator) | 2 | 2 (20%) | 1 / 1 | 35 | 1 | Not bumped on 2.x→3 (petclinic-rest; generated code stays javax). Bumped to 7.16 on 3→4 (reactjs), whose output does not compile for a spec example containing escaped quotes. |
| Web behaviour change (Spring 6/7) | 2 | 2 (20%) | 0 / 2 | 55 | 0 | Trailing-slash matching removed: 25 tests got 400 (petclinic-rest). This is an API-contract decision. WebGoat residual 403/404: unresolved. |
| Removed / relocated Boot API | 3 | 2 (20%) | 3 / 0 | 30 | 0 | `actuate.trace.http.HttpTrace` → `web.exchanges.HttpExchange`. Boot 4 package moves: H2 console, `ConfigurableServletWebServerFactory`, factory `getSettings()`. |
| javax → jakarta leftovers | 3 | 2 (20%) | 2 / 1 | 15 | 0 | Thymeleaf `springsecurity5` import. `"javax.."` in an ArchUnit rule string. jjwt 0.9.1 still needs `javax.xml.bind` at runtime. |
| Test framework | 2 | 2 (20%) | 0 / 2 | 25 | 0 | `@Captor` no longer initialised under Boot 4 (9 NPEs, jhipster). spock-spring 2.3 silently leaves `@Autowired` null (blog-app). |
| Jackson 3 | 2 | 2 (20%) | 1 / 1 | 20 | 1 | The recipe rewrote imports to Jackson 3 classes that do not exist (`ext.jdk8.Jdk8Module`, `ext.javatime.JavaTimeModule`). `JsonMapper.builder().visibility(...)` removed. |
| Spring Framework 7 core | 2 | 2 (20%) | 1 / 1 | 20 | 0 | `private @Bean` rejected (163 ITs, jhipster). `@Autowired EntityManager` no longer resolvable (dddsample). |
| H2 2.x | 1 | 1 (10%) | 0 / 1 | 15 | 0 | `USER` is now a reserved word, so DDL fails and appears as 401s (jwt-demo). |
| Recipe tooling | 1 | 1 (10%) | 1 / 0 | 10 | 0 | The Boot 4 recipe tried to download a Gradle distribution for a Maven repo that also has `build.gradle`, and aborted twice. |
| Other (internal API move) | 1 | 1 (10%) | 1 / 0 | 5 | 0 | Hibernate Validator internal `EmailValidator` hv → bv. |
| Removed Spring API | 1 | 1 (10%) | 1 / 0 | 2 | 0 | Import of deleted `org.springframework.orm.hibernate5`. |

**Not observed:**
- No Lombok breakages. The recipe adds `annotationProcessorPaths` itself.
- No JUnit 4 → 5 or Mockito API breakages beyond the two test-framework items above.
- No removed or renamed `application.properties` keys caused a failure. The recipe migrated them, for example `server.error.include-message` → `spring.web.error.include-message` in dddsample `src/test/resources/config/application.yml`.
- I did not boot-smoke-test the apps outside their own test suites, so production-only startup failures would not show up here.

## What this means for the Upgrade Agent MVP

1. **"Green with no human edits" is the wrong first metric.** OpenRewrite alone scored 0/10. 9 of the 10 repos had at least one judgment item; only spring-petclinic's breakages were all mechanical. A better headline for the pitch is minutes-to-baseline-parity plus the number of decisions that needed a human, with the recipe diff and every agent edit shown separately.
2. **The agent must repair the recipe's own output, not only what it left untouched.** 9/44 breakages were introduced by the recipe: invalid Java, ill-typed security DSL, non-existent Jackson 3 classes, harmful version pins or bumps. The fix loop therefore has to treat the recipe diff as suspect, which means validating the recipe diff, not only compiling the untouched code.
3. **Categories the agent must handle, in priority order:**
   1. Security config migration: 50% of repos, all judgment.
   2. Third-party replacements, above all springfox → springdoc: 50%.
   3. Build and compiler plugin fixes: 50%, mostly mechanical. The formatter step alone would have taken petclinic from red to green.
   4. Hibernate 6/7 runtime behaviour: 40%, needs the test-failure → cause diagnosis loop.
   5. The long tail of Boot 4 relocations: mechanical. A curated relocation table would cover them.
4. **Which path first.**
   - 2.x → 3.5 carried more total effort (6 repos, about 335 judgment minutes).
   - 3.x → 4.0 was cheaper per repo but less mature in the recipes: 4 repos, about 165 judgment minutes. The recipe output had compile-level mistakes (Jackson 3 imports, loader-tools version, generator bump), and one repo stayed red on a pure authorisation decision.
   - 2.7 → 3.5 is the path where the agent adds the most value per upgrade, and where fleets are furthest behind given Boot 2.7's end of OSS support.
   - 3.5 → 4.0 is where a curated mechanical-fix layer (relocations, Jackson 3, plugin versions) would convert the most repos to green cheaply.
   - Evidence favours starting with 2.7 → 3.5 for the demo, and keeping 3.5 → 4.0 as the cheaper second path.
5. **Verification needs baseline-aware test diffing.**
   - 3 of 10 repos have tests that cannot run offline: Docker, a real DB, or a browser.
   - Two silent regressions only showed as test failures, not compile errors: Spock's null injection and petclinic-rest's trailing slash.
   - The agent must compare per-test results against the baseline, not the build exit code.

## Files

- `corpus.yaml`: the 10 repos (url, SHA, from-version, recipe, JDKs, why chosen), plus the replaced repo and environment gaps. `corpus.tsv` is the same data in the form `run.sh` loops read.
- `run.sh NAME URL SHA BASE_JDK TARGET_JDK RECIPE [PHASES]` reproduces one run (clone, baseline, recipe, post build). Env `MVN_ARGS` carries per-repo flags. `summarize_tests.py` sums the surefire and failsafe XML reports.
- `fix.sh NAME N NOTE` runs one manual fix iteration (rebuild and record). The manual diffs themselves live in the scratch clones under `~/.cache/stratigraph/gapmap/_logs/<repo>/fixN.diff`.
- `results.json`: per repo, the baseline, recipe diff, post-recipe status, test counts at each stage, and every classified failure. `build_results.py` regenerates it from the raw logs plus the curated classification.
- `logs/<repo>.txt`: trimmed evidence for each repo, 27 to 170 lines each (`extract_log.py`).

## Caveats and what I could not do

- **Time box.** Each repo got roughly 25 to 60 minutes of fixing. For the 3 red repos, the listed "unresolved" items are diagnoses, not confirmed fixes.
- **Early masking.** A compile error hides later test failures, so items found late in a fix sequence might not be the only ones hiding behind the next layer.
- **Single run, single recipe version.** Results can move with rewrite-spring releases.
- **Estimates are one person's view.** The judgment/mechanical split and the minutes are my estimates.
- **No JDK 21.** Boot 4's recommended baseline is 17+, so this did not block anything, but repos requiring 21 were excluded (for example, the blog-app at 3.5.6).
- **Per-repo build flags.** jhipster's frontend build was skipped (`-Dskip.npm`). The blog-app's OWASP dependency-check and modernizer plugins were skipped because they fail on the plugin or NVD side at baseline.
- **Recipe exclusion.** spring-petclinic's recipe needed `-Drewrite.exclusions=gradle/wrapper/**,…` after two aborted runs. The post-recipe and fix builds ran without it.
