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

## `tiny-angular`

Angular read without Angular ([ADR-0016](../docs/adr/0016-angular-without-the-angular-compiler.md)):
a standalone component with an external template, an `@NgModule`, a service
injected two ways, a nested route table with a lazy boundary, and a `tsconfig`
path alias that the DI graph depends on resolving.

Expected facts:

| File | Expected |
| --- | --- |
| `orders/order-list.component.ts` | `@Component` with `selector`, `standalone`, `templateUrl`; **constructor** injection of `OrderService` resolved through the `@app/*` alias; `ngOnInit` carrying an unguarded, unretained `rxjsSubscribes` site at line 21 |
| `orders/order-list.component.html` | an `imports` edge to `OrderRowComponent`, matched by element selector, cited at the template's own file and line |
| `orders/order-row.component.ts` | `@Component` with an inline template; `@Input` field |
| `orders/orders.module.ts` | `@NgModule`, with `imports` edges carrying `ngModule: "imports"` |
| `core/order.service.ts` | `@Injectable` with `providedIn`; **`inject()`** injection of `HttpClient`; `findOne` carrying `httpCalls: [{GET, "/api/orders/{}"}]`, and **a diagnostic and no call for `findBy`'s computed URL** |
| `app.routes.ts` | routes `/`, `/orders`, `/orders/:id`; `declares_route` from the table, `handles` from each component, `lazy: true` on the `loadComponent` boundary |
| `core/tokens.ts` | **an `info` diagnostic and no `injects` edge** — `inject(API_BASE)` names an `InjectionToken`, and what it provides is decided at runtime |
| `legacy/legacy-page.component.ts` | **a decorated class and nothing more** — `@Page({ selector: 'app-legacy' })` is not Angular's, so no `selector` and no `angular` attribute are read out of it |

The last two rows are this fixture's version of `tiny-spring`'s wildcard import.
It is easy to write an extractor that scores well by matching decorator names
and pulling a `selector` out of whatever object follows; the fixture asserts
that this one checks where the name was imported from first.

One deliberate fragility worth knowing about: `@angular/core`, `@angular/router`
and `rxjs` are **not** installed in this repository, so those imports resolve
through the import statement rather than through the checker, and the golden
records `"resolution": "import"` for them. Installing any of those as a
dependency of `stratigraph` would change the golden. That is a failure worth
having — it is the difference between the two resolution paths, and it should be
noticed rather than absorbed.
