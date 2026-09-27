# ADR-0036: The data model as JPA maps it — naming strategies, inheritance and table access

- Status: accepted; amends ADR-0022
- Date: 2026-09-28
- Milestone: M12 (before the code)

## Context

v1 recorded a table only for an `@Entity` with an explicit `@Table(name = ...)`,
on the grounds that a default table name comes from a naming strategy we cannot
see. Most modern Spring code relies on the default, so the ER diagram of a
typical repository was empty or nearly so. The columns were wrong too: fields
were copied from *every* superclass (not only `@MappedSuperclass` ones), static
fields and loggers became columns, embedded values were opaque, bidirectional
associations were drawn twice, and `schema=` was ignored. And nothing recorded
which code reads or writes which table.

The naming strategy is not invisible. Spring Boot documents its default —
`CamelCaseToUnderscoresNamingStrategy` — and a module overrides it only through
`spring.jpa.hibernate.naming.physical-strategy` in its application
configuration. Both are files a parser can read and cite.

## Decision

**The Java extractor resolves the persistence model once every file is read**
(`Persistence.java`), because which table an entity lives in is not a fact of
its own file:

- **Table name.** Logical name = `@Table(name)`, else `@Entity(name)`, else the
  simple class name. Physical name = the module's naming strategy applied to
  it: `spring-boot-snake-case` when the module's `application*.properties|yml`
  says so or, failing an override, when its build (or a parent build) names
  Spring Boot; `as-written` for plain JPA or `PhysicalNamingStrategyStandardImpl`;
  a quoted identifier is used exactly. `schema=` prefixes the table. Every
  `maps_to` edge carries `naming` (explicit / entity-name / class-name),
  `strategy` and `strategySource` — the file and line the rule came from. An
  unknown custom strategy records no table for default-named entities, with a
  diagnostic.
- **Inheritance.** JPA's default `SINGLE_TABLE` puts an entity subclass in its
  root's table (`inheritance`, `root` on the edge); `JOINED` and
  `TABLE_PER_CLASS` give it its own.
- **Table access.** A Spring Data repository (`extends JpaRepository<E, ID>` and
  the other `org.springframework.data` repository types) reads and writes its
  entity's table. `@Query` strings name tables — JPQL through entity names,
  native SQL directly — and a literal SQL string passed to a JDBC method name
  (`query`, `update`, `queryForList`, …) does the same. Each edge says `via`
  which. The SQL reading is deliberately small: `FROM`/`JOIN`/`INTO`/`UPDATE`/
  `DELETE FROM`; association navigation (`join o.pets`) and functions are skipped.
  A missed table is a stated limit; a guessed one is not written.

**The ER builder (`src/present/erd.ts`) follows JPA:** one entity per table
(single-table subclasses listed under their root); columns from the class and
its `@MappedSuperclass` ancestors only, top-down; static, `transient` and
`@Transient` fields skipped; `@Embedded`/`@EmbeddedId` and `@Embeddable`-typed
fields expanded; a `JOINED` child keyed by its parent's primary key; the inverse
(`mappedBy`) side of an association not drawn; column names put through the
same strategy the edge names.

## Alternatives considered

**Keep refusing default names.** Rejected: the refusal was honest about a rule
it had not tried to read. The rule is documented and its override is in a file;
applying it with a citation is a derivation from facts, the same as lifting an
edge to a package.

**Leave naming to the core.** The core has no access to the build files and
configuration, which is where the evidence is, and the edge would then carry a
table the extractor never stated.

**Parse SQL properly.** A real SQL grammar per dialect for a table list is out of
proportion; the scorecard's table recall will say whether the small reader is
enough.

## Consequences

- ER diagrams of default-named Spring Boot repositories are no longer empty.
- A `physical-strategy` set only through Java configuration (a `@Bean` of a
  naming strategy) is invisible; the edge cites the rule it did apply, so a
  reader can see which.
- `ErEntity` gains `classes`; consumers that read `className` get the root.
