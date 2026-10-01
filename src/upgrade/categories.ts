/**
 * What kind of upgrade failure this is, and who should handle it — ADR-0047.
 *
 * Rules over the failure's own text. Each rule was written from a failure in
 * the gap map (`bench/upgrade-gap/`), and its test uses that failure's log
 * excerpt. A failure no rule matches is `uncategorised`, reported with its
 * excerpt rather than guessed at.
 *
 * The disposition decides the route:
 * - mechanical: a deterministic fix exists, or a better recipe could do it.
 * - judgment:   fixable by reading the code; the AI fixer may attempt it.
 * - decision:   any fix changes behaviour someone has to choose. Never
 *               attempted automatically; handed off with the options.
 */

import type { BuildFailure } from './build-log.js';
import type { TestResult } from './test-reports.js';

export type Disposition = 'mechanical' | 'judgment' | 'decision';

export interface Category {
  id: string;
  title: string;
  disposition: Disposition;
  /** What the fixer is told about this kind of failure. */
  guidance: string;
  /** For decisions: the choices, as a reviewer would weigh them. */
  options?: string[];
}

interface Rule extends Category {
  match: (text: string) => boolean;
}

const has = (pattern: RegExp) => (text: string) => pattern.test(text);

/** First match wins, so narrower rules come before broader ones. */
const RULES: Rule[] = [
  {
    id: 'tests-not-run',
    title: 'Tests that ran before the upgrade did not run after it',
    disposition: 'judgment',
    match: has(/^stratigraph: tests did not run/m),
    guidance:
      'The build succeeded but these tests never ran: a test plugin found nothing (e.g. an old Surefire/Failsafe ' +
      'with JUnit 5), an excluded or renamed test directory, or a process the tests need (the application ' +
      'started by the build for integration tests) that failed to start. Read the build log around the test ' +
      'plugin, find why they were not run, and restore it. Never mark them skipped.',
  },
  {
    id: 'security-filter-chain-conflict',
    title: 'Two security filter chains match the same requests',
    disposition: 'decision',
    match: has(/UnreachableFilterChainException|filter chain that matches any request/i),
    guidance:
      'Spring Security 6.2+ refuses to start when two SecurityFilterChain beans both match every request. ' +
      'Which chain should own which paths is an authorisation decision.',
    options: [
      "Scope the API chain with securityMatcher(\"/api/**\") so the other chain keeps everything else. This preserves the old behaviour if the chains' order made that the effective split.",
      'Merge the chains into one, with explicit authorizeHttpRequests rules per path. This makes every rule visible in one place, but it changes the order rules are evaluated in.',
      "Keep one chain and delete the other. Use this only if one was dead configuration; check that chain's rules are really unused first.",
    ],
  },
  {
    id: 'http-contract-change',
    title: 'An HTTP response changed (status or body)',
    disposition: 'decision',
    match: has(/Status expected:<\d+> but was:<\d+>|expected:<\d{3}> but was:<\d{3}>|NoHandlerFoundException/),
    guidance:
      'Spring 6 changed request matching. Trailing-slash matching is off by default, and path patterns are ' +
      'parsed by PathPatternParser. A test asserting the old status is asserting the API contract.',
    options: [
      'Keep the old contract. Restore it explicitly, e.g. trailing-slash matching (Spring 6.2 UrlHandlerFilter, or setUseTrailingSlashMatch on older 6.x), and say so in the PR.',
      'Adopt the new behaviour. Update the tests and tell API clients that URLs ending in a slash now return 404 or 400.',
    ],
  },
  {
    id: 'spring-security-config',
    title: 'Spring Security configuration needs migrating',
    disposition: 'judgment',
    match: has(
      /WebSecurityConfigurerAdapter|GlobalMethodSecurityConfiguration|EnableGlobalMethodSecurity|AuthorizationManagerRequestMatcherRegistry|Migrate manually|antMatchers|authorizeRequests\(\)/,
    ),
    guidance:
      'Rewrite WebSecurityConfigurerAdapter subclasses as @Bean SecurityFilterChain (and WebSecurityCustomizer for ' +
      'web.ignoring), using the lambda DSL. Replace GlobalMethodSecurityConfiguration with @EnableMethodSecurity and ' +
      'a @Bean for any custom expression handler. Keep every rule and its order exactly. Do not widen or narrow any ' +
      'permitAll/authenticated rule. Remove any /*~~(...)~~>*/ markers the recipe left.',
  },
  {
    id: 'springfox',
    title: 'springfox has no Spring Boot 3 release',
    disposition: 'judgment',
    match: has(/springfox/),
    guidance:
      'Replace springfox with springdoc-openapi (springdoc-openapi-starter-webmvc-ui). Rewrite each Docket as an ' +
      'OpenAPI bean plus GroupedOpenApi beans with the same package or path selection. Keep the documented paths ' +
      'and security schemes. Remove springfox dependencies and any /* TODO ... */ the recipe left.',
  },
  {
    id: 'openapi-generator-javax',
    title: 'Generated API code still uses javax',
    disposition: 'mechanical',
    match: (text) => /generated-sources\/openapi/.test(text) && /javax\./.test(text),
    guidance:
      'Upgrade openapi-generator-maven-plugin to a 6.3+ release and set configOptions useSpringBoot3=true ' +
      '(or useJakartaEe=true). The generated sources are output: fix the generator, never the generated files.',
  },
  {
    id: 'openapi-generator-output',
    title: 'Generated API code does not compile',
    disposition: 'judgment',
    match: (text) => /generated-sources\/openapi/.test(text),
    guidance:
      'The generator version changed and its output does not compile. Fix the generator version or its ' +
      'configOptions, or the spec content that triggers the bug (e.g. escaped quotes in examples). Never edit ' +
      'files under target/.',
  },
  {
    id: 'formatting-check',
    title: 'A formatting check rejects the recipe output',
    disposition: 'mechanical',
    match: has(/spring-javaformat[\s\S]*violations|spotless[\s\S]*(?:violations|check)|format violations/i),
    guidance: 'Run the formatter the build uses (spring-javaformat:apply or spotless:apply). Change nothing else.',
  },
  {
    id: 'compiler-release-conflict',
    title: 'The compiler --release setting conflicts with --add-exports',
    disposition: 'mechanical',
    match: has(/not allowed with --release/),
    guidance:
      'javac forbids --add-exports of system modules with --release. Remove the --add-exports argument when ' +
      'no source uses the exported package; otherwise use source/target instead of release.',
  },
  {
    id: 'compiler-parameters',
    title: 'Parameter names are not compiled in (Spring 6.1 needs -parameters)',
    disposition: 'mechanical',
    match: has(/Name for argument of type \[[^\]]+\] not specified|-parameters flag/),
    guidance:
      'Spring 6.1 no longer reads parameter names from debug info. Compile with -parameters ' +
      '(maven.compiler.parameters=true, maven-compiler-plugin 3.6.2+).',
  },
  {
    id: 'maven-too-old',
    title: 'The new plugins need a newer Maven',
    disposition: 'mechanical',
    match: has(/requires Maven version \d/),
    guidance:
      'The plugin versions the new Spring Boot manages need a newer Maven than the one that ran. With a Maven ' +
      'wrapper, point .mvn/wrapper/maven-wrapper.properties at a current Maven 3.9.x; without one, install it.',
  },
  {
    id: 'pom-missing-version',
    title: 'A dependency lost its managed version',
    disposition: 'mechanical',
    match: has(/'dependencies\.dependency\.version' for [\w.:-]+ is missing/),
    guidance: 'The new Spring Boot BOM no longer manages this artifact. Give it an explicit version.',
  },
  {
    id: 'unresolvable-bom',
    title: 'An imported BOM version does not exist',
    disposition: 'judgment',
    match: has(/Non-resolvable import POM/),
    guidance:
      'A version property overridden in this POM feeds an import that the new Boot parent adds. Usually ' +
      'the override is stale; remove it so the Boot-managed version applies.',
  },
  {
    id: 'flyway-database-module',
    title: 'Flyway needs its database module',
    disposition: 'mechanical',
    match: has(/FlywayException: Unsupported Database/),
    guidance: 'Flyway 10+ ships each database in its own module. Add org.flywaydb:flyway-database-<db>.',
  },
  {
    id: 'removed-boot-api',
    title: 'A Spring Boot class moved or was removed',
    disposition: 'mechanical',
    match: has(/package org\.springframework\.boot\.[\w.]+ does not exist|cannot find symbol[\s\S]*org\.springframework\.boot/),
    guidance:
      'Replace the import with the class\'s new location in this Boot version (e.g. actuate.trace.http.HttpTrace → ' +
      'actuate.web.exchanges.HttpExchange in Boot 3; H2 console → boot.h2console.autoconfigure in Boot 4). ' +
      'Add the new starter module if the class moved to one.',
  },
  {
    id: 'removed-spring-api',
    title: 'A Spring Framework API was removed',
    disposition: 'judgment',
    match: has(/package org\.springframework\.[\w.]+ does not exist|must not be private or final|NoSuchBeanDefinitionException/),
    guidance:
      'Spring Framework 6/7 removed or tightened this API. Replace it with the supported equivalent. @Bean methods ' +
      'must not be private or final. Inject EntityManager with @PersistenceContext.',
  },
  {
    id: 'jackson-3',
    title: 'Jackson 3 API change',
    disposition: 'judgment',
    match: has(/tools\.jackson|Jdk8Module|JavaTimeModule|JsonMapper/),
    guidance:
      'Boot 4 uses Jackson 3 (package tools.jackson). JavaTimeModule and Jdk8Module are built in: remove their ' +
      'registration. Builder methods changed names (e.g. visibility → changeDefaultVisibility).',
  },
  {
    id: 'hibernate-6',
    title: 'Hibernate 6/7 behaviour or API change',
    disposition: 'judgment',
    match: has(/org\.hibernate|SemanticException|StaleObjectStateException|TransientObjectException|@Type\(|getColumnIterator|getPropertyIterator|_seq\b|hibernate_sequence/i),
    guidance:
      'Hibernate 6/7 changed HQL (entity paths, not column names), identifier sequences (per-entity *_seq; ' +
      'hibernate.id.db_structure_naming_strategy=legacy keeps the old single sequence), @Type (use @JdbcTypeCode), ' +
      'auto-flush and merge semantics. Preserve the data behaviour the tests assert.',
  },
  {
    id: 'h2-reserved-word',
    title: 'H2 2.x rejects a reserved word used as a name',
    disposition: 'judgment',
    match: has(/Syntax error in SQL statement[\s\S]*\b(?:USER|VALUE|KEY|YEAR|MONTH|DAY|ORDER)\b|NON_KEYWORDS/i),
    guidance:
      'H2 2.x reserves words like USER and VALUE. For an H2-only test database, add ;NON_KEYWORDS=USER to the ' +
      'JDBC URL. Renaming the table is a schema change that needs a decision.',
  },
  {
    id: 'javax-leftover',
    title: 'A javax dependency or reference survived',
    disposition: 'judgment',
    match: has(/javax[./]|springsecurity5/),
    guidance:
      'Something still needs javax: a library without a Jakarta release (e.g. jjwt 0.9 needs javax.xml.bind), a ' +
      'renamed artifact (thymeleaf-extras-springsecurity5 → 6), or a string such as an ArchUnit rule. Prefer ' +
      'upgrading the library; add the javax API back only for a library that has no Jakarta release.',
  },
  {
    id: 'test-framework',
    title: 'Test framework integration changed',
    disposition: 'judgment',
    match: has(/@Captor|Captor is null|spock|MockitoTestExecutionListener|MockBean/i),
    guidance:
      'Boot 4 dropped MockitoTestExecutionListener, so @Captor/@Mock fields in Spring tests need MockitoExtension ' +
      'or ArgumentCaptor.forClass. Spock needs 2.4+ for Spring 6. Never weaken an assertion.',
  },
  {
    id: 'third-party-library',
    title: 'A library has no version compatible with the new stack',
    disposition: 'judgment',
    match: has(/NoClassDefFoundError|ClassNotFoundException|ServiceConfigurationError|cannot access/),
    guidance:
      'A dependency was built against the old stack. Find its release for the new one (often a renamed artifact, ' +
      'e.g. jackson-datatype-hibernate6 → hibernate7, htmlunit-driver → htmlunit3-driver). Remove version pins the ' +
      'recipe added that break managed versions.',
  },
];

const UNCATEGORISED: Category = {
  id: 'uncategorised',
  title: 'Not recognised',
  disposition: 'judgment',
  guidance: 'Read the failure and its cause, and make the smallest change that restores the baseline behaviour.',
};

export function categoriseText(text: string): Category {
  const rule = RULES.find((candidate) => candidate.match(text));
  if (!rule) return UNCATEGORISED;
  const { match: _match, ...category } = rule;
  return category;
}

export function categoriseBuildFailure(failure: BuildFailure): Category {
  return categoriseText([failure.message, failure.symbol ?? '', failure.file ?? '', ...failure.excerpt].join('\n'));
}

/** A test is categorised by its root cause when one is recognised, and by its symptom otherwise. */
export function categoriseTest(test: TestResult): Category {
  if (test.cause) {
    const byCause = categoriseText(test.cause);
    if (byCause.id !== 'uncategorised') return byCause;
  }
  return categoriseText(`${test.id}\n${test.message ?? ''}\n${test.cause ?? ''}`);
}

export const CATEGORY_IDS = [...RULES.map((rule) => rule.id), UNCATEGORISED.id];
