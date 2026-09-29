#!/usr/bin/env python3
"""Assemble results.json from raw run logs ($GAPMAP/_logs) plus the curated failure list below.

Counts (tests, diff stats, exit codes) are read from the logs; failures, categories, fixes,
judgment/mechanical and minute estimates are the hand-classified part of the gap map."""
import json, os, re

G = os.path.expanduser(os.environ.get("GAPMAP", "~/.cache/stratigraph/gapmap"))
HERE = os.path.dirname(os.path.abspath(__file__))

def rd(n, f, d=None):
    try: return open(os.path.join(G, "_logs", n, f)).read().strip()
    except OSError: return d

def tests(n, label):
    t = rd(n, f"{label}-tests.json")
    if not t: return None
    d = json.loads(t)
    return {k: d[k] for k in ("tests", "passed", "failures", "errors", "skipped")}

def last_fix(n):
    fx = sorted((int(m.group(1)) for f in os.listdir(os.path.join(G, "_logs", n))
                 if (m := re.match(r"fix(\d+)\.exit$", f))))
    return fx[-1] if fx else None

def F(cat, where, msg, fix, kind, minutes, status="fixed", fix_step=None, recipe_introduced=False):
    return {"category": cat, "where": where, "message": msg, "fix": fix, "kind": kind,
            "minutes": minutes, "status": status, "fix_step": fix_step,
            "recipe_introduced": recipe_introduced}

REPOS = {
 "spring-petclinic-rest": dict(baseline_note="green (172 tests)", failures=[
   F("codegen (openapi-generator)", "pom.xml openapi-generator-maven-plugin 6.0.1; target/generated-sources/openapi/.../OwnersApi.java:31",
     "package javax.validation does not exist (generated code still javax)",
     "openapi-generator 6.0.1 -> 6.3.0 and configOptions useSpringBoot3=true (same change upstream made in b3c928e)", "mechanical", 10, fix_step=1),
   F("web-behaviour-change", "OwnerRestControllerTests#testGetAllOwnersSuccess (+24 tests)",
     "Status expected:<200> but was:<400>; NoHandlerFoundException for '/api/owners/' (Spring 6 dropped trailing-slash match)",
     "decide API contract: re-enable trailing-slash match (WebMvcConfigurer + standalone MockMvc setUseTrailingSlashPatternMatch) or change clients/tests", "judgment", 25, fix_step="2,3"),
   F("hibernate-6", "JpaPetRepositoryImpl.java:77, JpaPetTypeRepositoryImpl.java:73 (+SpringData variants)",
     "SemanticException: Could not interpret path expression 'pet_id' (HQL used column names)",
     "rewrite HQL to entity paths visit.pet.id / pet.type.id", "judgment", 10, fix_step=4),
   F("hibernate-6", "JpaPetTypeRepositoryImpl.delete; ClinicServiceJpaTests#shouldDeletePetType",
     "TransientObjectException on auto-flush, then deleted PetType still returned from persistence context",
     "drop early em.remove(), flush()+clear() after bulk deletes", "judgment", 20, fix_step="5,6"),
 ]),
 "jwt-spring-security-demo": dict(baseline_note="green (16 tests)", failures=[
   F("spring-security-dsl", "src/main/java/org/zerhusen/config/WebSecurityConfig.java:26",
     "cannot find symbol WebSecurityConfigurerAdapter (recipe converted to lambda DSL but kept the adapter)",
     "rewrite as SecurityFilterChain + WebSecurityCustomizer @Beans", "judgment", 20, fix_step=1),
   F("database/h2-2.x", "AuthenticationRestControllerTest#successfulAuthenticationWithUser (+6)",
     "401 / 'No content to map'; root: DDL 'drop table if exists user' syntax error - USER is reserved in H2 2.x",
     "datasource URL ;NON_KEYWORDS=USER (or rename table)", "judgment", 15, fix_step=2),
 ]),
 "mall-tiny": dict(baseline_note="compiles; pom sets <skipTests>true</skipTests> (1 test needs MySQL) - compile-only signal", failures=[
   F("third-party-lib (springfox)", "src/main/java/com/macro/mall/tiny/common/config/BaseSwaggerConfig.java:11,51",
     "package springfox.documentation.builders does not exist; recipe half-migrated the class (springdoc + springfox types mixed, undefined 'getApiBasePackage')",
     "rewrite BaseSwaggerConfig/SwaggerConfig to springdoc OpenAPI + GroupedOpenApi, drop springfox BeanPostProcessor", "judgment", 25, fix_step=1, recipe_introduced=True),
   F("spring-security-dsl", "src/main/java/com/macro/mall/tiny/security/config/SecurityConfig.java:13,48",
     "dangling WebSecurityConfigurerAdapter import; 'AuthorizationManagerRequestMatcherRegistry registry = http.authorizeHttpRequests(withDefaults())' is ill-typed",
     "single authorizeHttpRequests(registry -> ...) lambda chain", "judgment", 15, fix_step="1,2", recipe_introduced=True),
 ]),
 "kafdrop": dict(baseline_note="compiles; 4/5 tests need Docker (Testcontainers) and fail identically before and after", failures=[
   F("build-plugin", "pom.xml maven-compiler-plugin",
     "error: exporting a package from system module jdk.management.agent is not allowed with --release (recipe added <release>)",
     "drop the unused --add-exports compilerArg (or keep source/target)", "mechanical", 10, fix_step="1,2", recipe_introduced=True),
   F("third-party-lib (springfox)", "src/main/java/kafdrop/config/SwaggerConfiguration.java:30,47",
     "package springfox.documentation does not exist; recipe left '/* TODO: transformation of Docket ... too complex */'",
     "rewrite as springdoc OpenAPI + GroupedOpenApi (JSON-only, exclude /actuator)", "judgment", 20, fix_step=3),
 ]),
 "WebGoat": dict(baseline_note="green (235 unit + 39 IT)", failures=[
   F("removed-boot-api", "src/main/java/org/owasp/webgoat/webwolf/requests/WebWolfTraceRepository.java:29 (+WebWolf.java:26, Requests.java:35)",
     "package org.springframework.boot.actuate.trace.http does not exist",
     "HttpTrace/HttpTraceRepository -> HttpExchange/HttpExchangeRepository", "mechanical", 10, fix_step=1),
   F("javax-jakarta-leftover", "src/main/java/org/owasp/webgoat/container/MvcConfiguration.java:59",
     "package org.thymeleaf.extras.springsecurity5.dialect does not exist (dependency renamed, import not)",
     "import ...springsecurity6.dialect", "mechanical", 2, fix_step=1),
   F("spring-security-dsl", "src/main/java/org/owasp/webgoat/container/WebSecurityConfig.java:42,51 and webwolf/WebSecurityConfig.java:34,43",
     "WebSecurityConfigurerAdapter left with '/*~~(Migrate manually ...)~~>*/' marker; ill-typed registry variable",
     "two SecurityFilterChain beans + AuthenticationManager from AuthenticationConfiguration", "judgment", 30, fix_step=1, recipe_introduced=True),
   F("build-plugin", "pom.xml spotless-maven-plugin:check",
     "The following files had format violations (recipe output)", "spotless:apply", "mechanical", 2, status="not fixed (masked by test failures)"),
   F("third-party-lib (flyway)", "DatabaseConfiguration flyWayContainer",
     "FlywayException: Unsupported Database: HSQL Database Engine 2.7", "add flyway-database-hsqldb", "mechanical", 5, fix_step=2),
   F("javax-jakarta-leftover", "TokenTest.java:52 via io.jsonwebtoken.impl.Base64Codec",
     "ClassNotFoundException javax.xml.bind.DatatypeConverter (jjwt 0.9.1 needs javax JAXB; recipe swapped jaxb-api for jakarta)",
     "keep javax.xml.bind:jaxb-api for jjwt 0.9.1 (lessons depend on the old lib on purpose) or upgrade jjwt", "judgment", 10, fix_step=2),
   F("build-plugin", "pom.xml maven-compiler-plugin.version 3.8.0; Assignment1Test#success (+24)",
     "Name for argument of type [String] not specified ... use -parameters (Spring 6.1); compiler 3.8.0 with <release> silently drops <parameters>",
     "maven-compiler-plugin 3.14.1 + <parameters>true", "judgment", 25, fix_step="2,3"),
   F("hibernate-6", "UserTrackerRepositoryTest#saveUserTracker (+~100 tests)",
     "object not found: USER_TRACKER_SEQ (Hibernate 6 per-entity sequences vs Flyway schema's HIBERNATE_SEQUENCE)",
     "hibernate.id.db_structure_naming_strategy=legacy (upstream instead migrated columns to IDENTITY, V3__id.sql)", "judgment", 20, fix_step=4),
   F("third-party-lib (wiremock)", "BlindSendFileAssignmentTest (5 tests)",
     "NoClassDefFoundError javax/servlet/DispatcherType in wiremock jetty9", "upgrade to wiremock 3.x (jakarta)", "judgment", 20, status="unresolved (time-box)"),
   F("web-behaviour-change", "JWTVotesEndpointTest#unknownUserShouldSeeGuestView, MailboxControllerTest#sendingMailShouldStoreIt, ShopEndpointTest, SimpleXXETest",
     "404 / 403 / JSON path mismatches after upgrade", "not diagnosed", "judgment", 30, status="unresolved (time-box)"),
 ]),
 "spring-boot-blog-app": dict(baseline_note="compiles; 3 browser tests (SampleTest, WebAppIT x2) fail at baseline: no Firefox; OWASP dependency-check and modernizer plugins skipped (plugin/NVD failures unrelated to code); surefire writes reports to a custom dir, so counts come from the console: 46 unit (1 error) + 7 IT (2 errors) at baseline and identical after fixes (logs/spring-boot-blog-app.txt)", failures=[
   F("build-plugin", "pom.xml <selenium.version>4.3.0",
     "Non-resolvable import POM selenium-bom:4.3.0 (Boot 3 imports selenium-bom via the property the app overrode)",
     "drop stale selenium.version override", "judgment", 10, fix_step=1),
   F("hibernate-6", "src/main/java/gt/app/domain/ReceivedFile.java:20",
     "recipe emitted invalid Java '@Type(uuid-char.class)' from @Type(type=\"uuid-char\")",
     "@JdbcTypeCode(SqlTypes.CHAR) to keep char(36) storage", "judgment", 10, fix_step=2, recipe_introduced=True),
   F("hibernate-6", "src/test/java/gt/app/config/DBMetadataReader.java:27,43,50,54",
     "getColumnIterator()/getPropertyIterator() removed", "getColumns()/getProperties()/getSelectables()", "mechanical", 5, fix_step=3),
   F("spring-security-dsl", "src/main/java/gt/app/config/security/MethodSecurityConfig.java; ApplicationTest#contextLoads",
     "startup: 'EnableGlobalMethodSecurity is required' - recipe swapped annotation to @EnableMethodSecurity but kept 'extends GlobalMethodSecurityConfiguration'",
     "@Bean MethodSecurityExpressionHandler, drop the superclass", "judgment", 15, fix_step=4, recipe_introduced=True),
   F("javax-jakarta-leftover", "src/test/java/gt/app/arch/SpringCodingRulesTest.java:79",
     "ArchUnit rule whitelists \"javax..\" as a string; entities now depend on jakarta", "add \"jakarta..\"", "mechanical", 3, fix_step=4),
   F("test-framework", "src/test/groovy/gt/app/SpringContextSpec.groovy:19",
     "Spock 2.3 spock-spring leaves @Autowired field null under Spring 6 (silent)", "Spock 2.3 -> 2.4", "judgment", 15, fix_step=5),
 ]),
 "spring-petclinic": dict(baseline_note="green (56 tests, 2 skipped)", failures=[
   F("recipe-tooling", "recipe run (twice)",
     "rewrite run aborted: Failed to download https://downloads.gradle.org/distributions/gradle-8.14.5-bin.zip to artifact cache (repo has both pom.xml and build.gradle; UpdateGradleWrapper step)",
     "-Drewrite.exclusions=gradle/wrapper/**,gradlew,gradlew.bat", "mechanical", 10, fix_step="recipe"),
   F("build-plugin", "src/test/java/.../system/CrashControllerIntegrationTests.java",
     "spring-javaformat:validate: Formatting violations (recipe output)", "spring-javaformat:apply", "mechanical", 2, fix_step=1),
 ]),
 "jhipster-sample-app": dict(baseline_note="green (48 unit + 163 IT on H2); frontend build skipped (-Dskip.npm)", failures=[
   F("build-plugin", "pom.xml:94", "'dependencies.dependency.version' for spring-boot-loader-tools is missing (Boot 4 BOM no longer manages it)",
     "explicit ${spring-boot.version}", "mechanical", 5, fix_step=1),
   F("removed-boot-api", "JhipsterSampleApplicationApp.java:16, DatabaseConfiguration.java:7, WebConfigurer.java:13",
     "package org.springframework.boot.autoconfigure.h2 / boot.web.servlet.server does not exist (Boot 4 modularisation)",
     "boot.h2console.autoconfigure (+spring-boot-h2console dep), boot.web.server.servlet", "mechanical", 15, fix_step=2),
   F("jackson-3", "src/main/java/io/github/jhipster/sample/config/JacksonConfiguration.java:5,6",
     "tools.jackson.databind.ext.jdk8.Jdk8Module / javatime.JavaTimeModule not found (recipe rewrote packages to classes that do not exist in Jackson 3)",
     "delete the beans (built into Jackson 3)", "judgment", 10, fix_step=2, recipe_introduced=True),
   F("other (internal API)", "src/main/java/io/github/jhipster/sample/security/DomainUserDetailsService.java:7",
     "hibernate-validator internal EmailValidator moved hv -> bv", "import ...constraintvalidators.bv.EmailValidator", "mechanical", 5, fix_step=2),
   F("third-party-lib (jhipster-framework)", "src/main/java/io/github/jhipster/sample/config/LiquibaseConfiguration.java:43,54",
     "cannot access org.springframework.boot.autoconfigure.liquibase.LiquibaseProperties (tech.jhipster 9.0.0-beta.0 built against Boot 3 packages)",
     "jhipster-framework 9.0.0", "judgment", 10, fix_step=3),
   F("removed-boot-api", "src/test/java/io/github/jhipster/sample/config/WebConfigurerTest.java:54-58",
     "getMimeMappings()/getDocumentRoot() not found on TomcatServletWebServerFactory", "getSettings().getMimeMappings()/getDocumentRoot()", "mechanical", 5, fix_step=4),
   F("spring-framework-7", "src/test/java/io/github/jhipster/sample/security/jwt/JwtAuthenticationTestUtils.java:32 (163 ITs)",
     "@Bean method 'mvcHandlerMappingIntrospector' must not be private or final", "make @Bean methods non-private", "mechanical", 5, fix_step=5),
   F("third-party-lib (jackson-datatype-hibernate)", "pom.xml jackson-datatype-hibernate6 3.1.7; JacksonConfiguration",
     "ServiceConfigurationError Hibernate6Module; NoClassDefFoundError org/hibernate/engine/spi/Mapping (Hibernate 7)",
     "jackson-datatype-hibernate7 3.2.3 / Hibernate7Module", "judgment", 10, fix_step=5),
   F("test-framework", "src/test/java/io/github/jhipster/sample/service/MailServiceIT.java:54 (9 tests)",
     "NPE: messageCaptor is null - @Captor no longer initialised (Boot 4 removed MockitoTestExecutionListener)", "ArgumentCaptor.forClass(...) or @ExtendWith(MockitoExtension)", "judgment", 10, fix_step=6),
 ]),
 "spring-petclinic-reactjs": dict(baseline_note="green (183 tests)", failures=[
   F("codegen (openapi-generator)", "target/generated-sources/openapi/.../OopsApi.java:83 (all *Api.java)",
     "';' expected / illegal character '\\' - recipe bumped openapi-generator 6.3.0 -> 7.16.0 which mis-escapes quoted strings in spec examples (7.25.0 too)",
     "rewrite the example in src/main/resources/openapi.yml:1891 (or skip default interface bodies)", "judgment", 25, fix_step="1-4", recipe_introduced=True),
   F("removed-spring-api", "src/main/java/.../repository/jpa/JpaOwnerRepositoryImpl.java:26",
     "package org.springframework.orm.hibernate5.support does not exist (javadoc-only import)", "drop import", "mechanical", 2, fix_step=2),
   F("jackson-3", "src/main/java/.../rest/controller/BindingErrorsResponse.java:83",
     "JsonMapper.Builder has no visibility(PropertyAccessor, Visibility)", "changeDefaultVisibility(vc -> vc.withFieldVisibility(ANY))", "mechanical", 10, fix_step=4),
   F("spring-security-dsl", "security/WebSecurityConfig.java:22 + BasicAuthenticationConfig.java:28 (182 tests)",
     "UnreachableFilterChainException: two SecurityFilterChains both match any request (tolerated by Security 6.2, rejected now)",
     "decide which chain owns which paths (securityMatcher/@Order) - an authorisation decision", "judgment", 30, status="unresolved (time-box)"),
 ]),
 "dddsample-core": dict(baseline_note="green (131 tests, 3 skipped)", failures=[
   F("spring-framework-7", "src/main/java/se/citerus/dddsample/interfaces/InterfacesApplicationContext.java:44 (+2 test classes)",
     "NoSuchBeanDefinitionException: No qualifying bean of type 'jakarta.persistence.EntityManager' (@Autowired EntityManager)",
     "@PersistenceContext", "judgment", 15, fix_step=1),
   F("third-party-lib (htmlunit)", "pom.xml dependencyManagement (added by recipe); AdminAcceptanceTest",
     "ClassNotFoundException org.htmlunit.WebConnection - recipe pinned htmlunit-driver 4.13.0 while Spring 7 needs HtmlUnit 3+",
     "use Boot-managed htmlunit3-driver, drop the pin", "judgment", 10, fix_step=2, recipe_introduced=True),
   F("hibernate-6", "SampleDataGenerator.java (@PostConstruct) - 19 tests",
     "StaleObjectStateException: Row was already updated or deleted ... Location with id '1' (Hibernate 7 merge of detached static sample entities with generated ids)",
     "reset/clone static sample entities per context or persist instead of merge", "judgment", 45, status="unresolved (time-box)"),
 ]),
}

META = {}
for line in open(os.path.join(HERE, "corpus.tsv")):
    if line.startswith("#") or not line.strip(): continue
    f = line.rstrip("\n").split("\t")
    META[f[0]] = dict(url=f[1], sha=f[2], base_jdk=f[3], target_jdk=f[4], recipe=f[5], mvn_args=f[6] if len(f) > 6 else "")

out = {"generated_by": "build_results.py", "rewrite_maven_plugin": "6.46.1", "rewrite_spring": "6.37.1", "repos": []}
for n, r in REPOS.items():
    m = META[n]; lf = last_fix(n)
    fails = r["failures"]
    out["repos"].append({
        "name": n, **m,
        "baseline": {"exit": int(rd(n, "baseline.exit")), "note": r["baseline_note"], "tests": tests(n, "baseline")},
        "recipe": {"exit": int(rd(n, "recipe.exit")), "diff": rd(n, "shortstat.txt")},
        "post_recipe": {"exit": int(rd(n, "post.exit")), "tests": tests(n, "post"),
                        "green_without_edits": False},
        "after_manual_fixes": {"fix_iterations": lf, "exit": int(rd(n, f"fix{lf}.exit")) if lf else None,
                               "tests": tests(n, f"fix{lf}") if lf else None,
                               "baseline_parity": all(not x["status"].startswith("unresolved") for x in fails)},
        "failures": fails,
        "judgment_minutes": sum(x["minutes"] for x in fails if x["kind"] == "judgment"),
        "mechanical_minutes": sum(x["minutes"] for x in fails if x["kind"] == "mechanical"),
    })
json.dump(out, open(os.path.join(HERE, "results.json"), "w"), indent=1)

# aggregate
agg = {}
for r in out["repos"]:
    for x in r["failures"]:
        a = agg.setdefault(x["category"].split(" (")[0], {"count": 0, "repos": set(), "judgment": 0, "mechanical": 0, "minutes": 0, "recipe_introduced": 0})
        a["count"] += 1; a["repos"].add(r["name"]); a[x["kind"]] += 1; a["minutes"] += x["minutes"]; a["recipe_introduced"] += x["recipe_introduced"]
for k, a in sorted(agg.items(), key=lambda kv: -len(kv[1]["repos"])):
    print(f"| {k} | {a['count']} | {len(a['repos'])} ({len(a['repos'])*10}%) | {a['mechanical']}/{a['judgment']} | {a['minutes']} | {a['recipe_introduced']} |")
tot = sum(len(r["failures"]) for r in out["repos"])
print("total failures", tot, "recipe-introduced", sum(x["recipe_introduced"] for r in out["repos"] for x in r["failures"]),
      "judgment", sum(1 for r in out["repos"] for x in r["failures"] if x["kind"] == "judgment"))
for r in out["repos"]:
    print(r["name"], r["recipe"]["diff"], "| post exit", r["post_recipe"]["exit"], r["post_recipe"]["tests"], "| fixes", r["after_manual_fixes"]["fix_iterations"], r["after_manual_fixes"]["tests"], "parity", r["after_manual_fixes"]["baseline_parity"], "| min J/M", r["judgment_minutes"], r["mechanical_minutes"])
