# ADR-0037: The schema as the migrations define it, overlaid with the mapping

- Status: accepted
- Date: 2026-09-28
- Milestone: M12 (before the code)

## Context

The ER diagram came only from JPA annotations. A Liquibase- or Flyway-driven
application defines its database in migrations — the tables, the columns, the
types and the foreign keys the application actually runs against — and the
tool read none of it. On such a repository the diagram was empty or partial,
and nothing said the schema lived elsewhere.

## Decision

**A third extractor reads migrations** (`extractors/typescript/src/migrations/`,
a separate process like the others, ADR-0001). It reads:

- Liquibase changelogs in XML, YAML, JSON and formatted SQL, following `include`
  and `includeAll` (relative to the changelog or to the resources root) from the
  changelogs no other changelog includes, in changelog order;
- Flyway `V<version>__*.sql` in version order (V10 after V2), then `R__` scripts;
- standalone DDL: any `.sql` whose name contains `schema` (`schema.sql`, `mysql-schema.sql`), `ddl*.sql`, `*.ddl`.

Files under test roots are not the application's schema and are skipped. It
applies `createTable`/`CREATE TABLE`, add/drop/rename column, rename/drop table,
primary and foreign keys to a schema state and emits **only the final state**:
`table` and `column` nodes cited at the change that created them, and
`references` edges for foreign keys. Preconditions, contexts and `dbms` filters
are not evaluated — the schema is the union of every changeset. Statements it
cannot read are skipped, never half-applied. The directory rule is shared with
`src/files/roles.ts` and `src/toolchain/languages.ts`, and a test keeps the
three equal.

**It runs first**, so a table both sides name is declared with its migration
file and line; the store keeps a node's first declaration and the JPA
`maps_to` edge attaches to it.

**The ER model overlays the two.** Each table says whether the mapping, the
migrations or both declare it. Where both do, its columns are the migration's —
the database as built — and mapped columns no migration creates are listed as
`unbacked`. Foreign keys are drawn unless the mapping already draws a line
between the same two tables.

**Disagreements are findings** (`schema-drift`), asked only when both sides
were read: a mapped column no migration creates and a mapped table no migration
creates (medium), a migrated table no class maps (low, and not for a join
table — at least two foreign keys and at most one other column). Each cites
the mapping and the migration it compares.

**Coverage** counts the migrations extractor against migration-role files, and
the data-model view's ratio covers Java/Kotlin sources and migrations together.

## Alternatives considered

**Run Liquibase/Flyway against an in-memory database.** Exact, and needs a
JVM, the application's driver and dialect, and often its classpath — a runtime
dependency CLAUDE.md asks us not to add, for a result a reader can already
verify from the changelog.

**Put migration parsing in the Java extractor.** It would tie the data model to
a JDK being present; migrations are text, and a repository with no JDK should
still get its schema.

**Emit every intermediate state.** The question the diagram answers is what
the database is now; history of the schema belongs to git.

## Consequences

- A Liquibase/Flyway repository has an ER diagram even without a JDK.
- Dialect-specific DDL beyond the common statements (partitions, table
  inheritance, vendor `ALTER` forms) is skipped; a table it creates is missing
  and table recall in the benchmark will show it.
- Hibernate `*.hbm.xml` mappings are still unread; their tables appear from the
  migrations with no class.
