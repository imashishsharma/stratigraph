# Fixtures

Tiny, hand-written repositories that extractor tests assert **exact** fact output
against. They are not built and not run; they exist to be parsed.

Rules:

- Small enough that a human can list every fact they should produce.
- **No external dependencies**, so tests stay offline, deterministic and
  version-independent. See [ADR-0005](../docs/adr/0005-framework-annotations-without-a-classpath.md)
  for how framework annotations are resolved without a classpath.
- Nothing derived from any real codebase.

## `tiny-java`

Plain Java, no frameworks. Five classes across three packages, with the shapes a
dependency graph needs: an interface and its implementation, constructor
injection, a cross-package call chain (`web` → `domain` → `repo`), and a class
with no outgoing edges.

This is the structural fixture — inheritance, calls, containment — kept free of
framework noise so those assertions stay readable.

## `tiny-spring`

Spring and JPA annotations, still with no dependencies. Exercises the
source-only annotation resolution path from ADR-0005.

Expected facts:

| File | Expected |
| --- | --- |
| `web/OrderController.java` | stereotype `RestController`; endpoints `GET /api/orders/{id}` and `POST /api/orders`; constructor injection of `OrderService` |
| `service/OrderService.java` | stereotype `Service`; constructor injection of `OrderRepository`; calls into `repo` |
| `repo/OrderRepository.java` | stereotype `Repository` |
| `domain/Order.java` | entity → table `orders`; field `customerRef` → column `customer_ref` |
| `web/LegacyReportController.java` | **no stereotype and no endpoint facts, plus a diagnostic** — the wildcard import makes the annotation's FQN ambiguous, and guessing is the failure mode this project exists to prevent |

That last row is the important one. It is easy to write an extractor that scores
well by guessing; the fixture asserts that this one refuses to.

## `legacy-java`

The pre-Boot world, which is most of what this tool will actually be pointed at.
**No build file at all**, sources under `src/` rather than `src/main/java`,
`javax.*` rather than `jakarta.*`, and Spring MVC rather than Spring Boot.

Expected facts:

| File | Expected |
| --- | --- |
| `web/ReportController.java` | stereotype `Controller`; `@Resource` **field** injection of `ReportService`; endpoints `GET /reports/daily` and `POST /reports/daily` from one `@RequestMapping(method = {GET, POST})`, plus `ANY /reports/index` where no method element is given |
| `service/ReportService.java` | stereotype `Service`; `@Autowired` field injection of `ReportDao` |
| `service/ReportDao.java` | a plain class — **no stereotype and no injection facts**, because it is declared in XML |
| `domain/Report.java` | entity → table `report_run`; field `title` → column `report_title`, all via `javax.persistence` |
| `WEB-INF/applicationContext.xml` | **a diagnostic and nothing else** — the beans and the `<property ref>` wiring in here are absent from the graph, and the report must be able to say so |

The module is named `legacy-java` after its directory, because there is no
`pom.xml` to name it. That is a supported case, not a degraded one.

The XML row is this fixture's version of `tiny-spring`'s wildcard import. A
legacy Spring MVC application can define most of its wiring in
`applicationContext.xml`, and a graph that omits it while looking complete is
the confidently-wrong map CLAUDE.md forbids. Parsing that XML is a later
milestone; admitting we did not costs nothing now.
