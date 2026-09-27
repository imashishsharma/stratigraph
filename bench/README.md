# The benchmark corpus

`stratigraph bench` (ADR-0035) runs the whole pipeline over the public repositories
listed in `corpus.yaml`, each pinned to a commit, and scores the output against
hand-labelled ground truth in `truth/<name>.yaml`.

Ground truth is labelled **without stratigraph**: by reading the repository's source,
build files, migrations and git history directly. A truth file derived from
stratigraph's own output would measure nothing.

Only public repositories. Nothing employer-derived, ever (CLAUDE.md, "Data handling").

## `corpus.yaml`

```yaml
repos:
  - name: spring-petclinic                # file-safe, unique
    url: https://github.com/spring-projects/spring-petclinic.git
    sha: 0123456789abcdef0123456789abcdef01234567   # full 40-char commit
    why: small sanity baseline             # what this repo tests
    stacks: [java]                          # java | kotlin | angular | typescript
    config: {}                              # optional stratigraph.config.json overrides
```

## `truth/<name>.yaml`

Every section is optional; a missing section is not scored. Paths are
repo-relative with forward slashes. Every entry is something a reader can verify
at the pinned commit.

```yaml
name: spring-petclinic
sha: <same as corpus.yaml>
labelledBy: how the labels were produced, in one or two sentences
roles:              # a sample of files and their role, in ADR-0030's vocabulary
                    # exactly as defined below
  - { path: pom.xml, role: manifest }
  - { path: src/test/java/.../OwnerControllerTests.java, role: test }
containers:         # deployables only: a Spring Boot app (main class / boot plugin),
                    # a WAR, an angular.json / Nx application. Never an aggregator or BOM pom.
  - { name: petclinic, kind: spring-boot, path: . }
entities:           # every JPA @Entity: class fqn and the physical table name the
                    # app actually uses (default naming → Spring's snake_case)
  - { class: org.springframework.samples.petclinic.owner.Owner, table: owners }
tables:             # every table the database has, from migrations/schema.sql if
                    # present, else from the entities
  - owners
endpoints:          # every HTTP endpoint as "METHOD /path", path variables as {name}
  - GET /owners/{ownerId}
injections:         # a sample (≥5 where the repo has them) of dependency-injection edges
                    # from the class that receives the dependency to the declared
                    # type of what it receives; include Lombok constructor injection.
                    # Java/Kotlin types by fqn; TypeScript classes as
                    # `<repo-relative path>#<ClassName>`
  - { from: org.x.OwnerController, to: org.x.OwnerRepository, via: constructor }
riskyFiles:         # up to 10 source files a senior engineer would call riskiest:
                    # most commits in the 12 months before the pinned commit
                    # (ignore >50-file sweeps), weighted by fix commits and size
  - src/main/java/.../OwnerController.java
```

## Role vocabulary (ADR-0030)

Labels must follow these definitions — a label that contradicts them is a
labelling error, not a disagreement about taste.

| role | meaning |
| --- | --- |
| `source` | hand-written program text: code, **templates (HTML, Thymeleaf, JSP), styles (CSS/SCSS/LESS) and SQL scripts** outside migration directories (e.g. `data.sql`) |
| `test` | anything under a test root (`src/test/`, `test/`, `__tests__/`, …) or named as a test (`*Test.java`, `*.spec.ts`) |
| `generated` | produced by a tool: marked in `.gitattributes`, under a `generated/` path, or carrying a generated-code header |
| `vendored` | third-party code checked in, including minified bundles (`*.min.js`) and `vendor/` trees |
| `lockfile` | a resolved dependency lock (`package-lock.json`, `yarn.lock`, …) |
| `manifest` | build and dependency declarations **and build wrappers** (`mvnw`, `gradlew`, `.mvn/wrapper/*`, `gradle/wrapper/*` including the wrapper jar), `tsconfig*.json`, `angular.json` |
| `migration` | schema migrations: Liquibase/Flyway files under `db/changelog/`, `db/migration(s)/`, `liquibase/`, `flyway/`, and standalone DDL (`schema*.sql`, `ddl.sql`, `*.ddl`) |
| `config` | JSON, YAML, XML, properties **and dotfiles** (`.gitignore`, `.editorconfig`) not covered above — i18n/locale JSON included |
| `docs` | prose (`*.md`, `*.adoc`, `README`, `LICENSE`) |
| `asset` | images, **fonts**, archives, media |
| `other` | none of the above |
