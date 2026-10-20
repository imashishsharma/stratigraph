# Upstream issue candidates: status (2026-10-20)

Tested with the latest on Maven Central: rewrite-maven-plugin 6.46.1 (rewrite 8.89.0), rewrite-spring 6.37.1,
rewrite-migrate-java 3.42.1, rewrite-hibernate 2.25.0, rewrite-jackson 1.29.0, JDK 17.0.13, Maven 3.9.12.
Newer releases (rewrite-spring 6.41.0, rewrite-hibernate 2.27.0, rewrite-jackson 1.31.0, plugin 6.50.0) are only on the
Code Genome Project and were not run; for each candidate the recipe source at the newest tag and `main` was checked instead.
Nothing has been filed.

| # | Candidate | Status | Target repo | Folder |
|---|-----------|--------|-------------|--------|
| 1 | `@Type(type = "uuid-char")` -> `@Type(uuid-char.class)` (also `uuid-binary`, `text`) | **confirmed**, draft ready. Closely related open issue rewrite-hibernate#31 (FQN `UUIDCharType`); `alt-comment-on-31.md` is an alternative to a new issue | openrewrite/rewrite-hibernate | `01-hibernate-type-alias/` |
| 2 | Lambda DSL rewrites an assigned `authorizeRequests()` registry into ill-typed code | **fixed upstream, unreleased**: rewrite-spring#1184 (merged 2026-10-15, after v6.41.0) | openrewrite/rewrite-spring | `02-lambda-dsl-assigned-registry/` |
| 2b | `ChangeType` drops the outer type's type arguments (`OldOuter<String>.Registry` -> raw `Registry2`); hits `AuthorizeHttpRequests` | **confirmed**, draft ready (related: rewrite#8398) | openrewrite/rewrite (or rewrite-spring) | `02b-changetype-outer-type-args/` |
| 3 | `@EnableGlobalMethodSecurity` -> `@EnableMethodSecurity` while the class still `extends GlobalMethodSecurityConfiguration` -> context fails | **confirmed**, draft ready. No duplicate (rewrite-spring#203/#255 are the original feature requests) | openrewrite/rewrite-spring | `03-method-security-keeps-superclass/` |
| 4 | `<release>` added while `compilerArgs` has `--add-exports` for a system module -> javac error | **confirmed**, draft ready. No duplicate (rewrite-migrate-java#279/#680 are about something else) | openrewrite/rewrite (`rewrite-maven`) | `04-release-vs-add-exports/` |
| 5 | Jackson 3 migration retargets `Jdk8Module`/`JavaTimeModule` beans to `tools.jackson` classes that don't exist | **fixed upstream**: rewrite-jackson#172, released in rewrite-jackson v1.31.0 (Code Genome only) | openrewrite/rewrite-jackson | `05-jackson3-builtin-modules/` |
| 6 | `htmlunit-driver` not migrated to `htmlunit3-driver`; parent upgrade pins 4.13.0 (HtmlUnit 2) -> `NoClassDefFoundError: org/htmlunit/WebConnection` | **confirmed**, draft ready. Starts at `UpgradeSpringBoot_3_4`, not only Boot 4. Related: rewrite-spring#627 (closed, item left unchecked) | openrewrite/rewrite-spring | `06-htmlunit-driver-pin/` |
| 7 | Maven project with a Gradle wrapper: `UpdateGradleWrapper` download aborts the run | **not reproduced reliably**: 2 of 9 runs failed (same error), 7 succeeded; looks like transient network trouble. No draft. Possible improvement (the cause is swallowed; 1 s connect timeout) described in `not-filed.txt` | (openrewrite/rewrite, if anything) | `07-gradle-wrapper-download/` |
| 8 | openapi-generator emits `"[\\"string\\"]"` in `exampleString` -> uncompilable | **fixed upstream, unreleased**: OpenAPITools/openapi-generator#25108 (merged 2026-10-06, after v7.26.0), fixes #9976. Reproduced on 7.16.0 and 7.26.0; verified fixed on 7.27.0-SNAPSHOT. Not an OpenRewrite bug | OpenAPITools/openapi-generator | `08-openapi-generator-example-escaping/` |

Drafts to review and file: 01 (or comment on #31), 02b, 03, 04, 06.

## Filed (2026-10-20)

- 01 → https://github.com/openrewrite/rewrite-hibernate/issues/107
- 02b → https://github.com/openrewrite/rewrite/issues/9291
- 03 → https://github.com/openrewrite/rewrite-spring/issues/1194
- 04 → https://github.com/openrewrite/rewrite/issues/9292
- 06 → https://github.com/openrewrite/rewrite-spring/issues/1195

Not filed: 02 and 05 are fixed upstream, 08 is fixed in openapi-generator, and 07 did not reproduce reliably. Build logs (`*.log`) are not committed, because they contain local machine paths.
