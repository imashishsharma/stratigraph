# ADR-0022: The code level and the data model, and what an erased type costs

- Status: accepted
- Date: 2026-07-31
- Milestone: M6 (after the code)

## Context

The first M6 report drew ten boxes from a store holding 343 nodes and 1,286
edges. Level 1 was two boxes, level 2 was two boxes, and six entity-to-table
mappings — the most legible facts in the whole database — were collapsed into a
single grey rectangle labelled "Database".

Everything a reader would actually want was already extracted and simply not
asked for:

| In the store, on `spring-petclinic` | Used by the first report |
| --- | --- |
| 77 fields with declared types, modifiers and `@Id` flags | nothing |
| 6 `maps_to` edges, class to table | one box |
| 17 endpoints with method, path and handler | nothing |
| 11 `extends`, 6 `implements` | nothing |
| 214 classes, 297 methods | nothing |

C4 has a fourth level — code — and this project had skipped it while claiming
to implement C4. So the question is not whether to draw class and ER diagrams;
it is what they are allowed to say.

## Decision

**Level 4 is one class diagram per package, and the data model is one ER
diagram over the declared O/R mappings. Both are drawn only from declarations a
parser read, and both refuse in the same way everything else here refuses.**

### Level 4 — code

One diagram per **package**, not per repository and not per cluster.

Per repository is unreadable at any real size. Per cluster was the tempting
alternative, because it would line up with the level 3 boundaries — and it was
rejected for the same reason ADR-0019 rejected clusters as containers: a
package is something the source states, a cluster is something an algorithm
decided, and the level where a reader is closest to the code is the wrong place
to introduce a grouping that is not in the code.

A box carries the type's name, a stereotype when a framework annotation gives
it one, its fields as `visibility name: Type`, and its methods as
`visibility name(): Return`. Members past a cap are counted on the box. Three
edge kinds, drawn as UML draws them: generalisation with a hollow triangle,
realisation dashed, and association from a field whose declared type is another
type in the same package.

An association to a type outside the package is **listed in the table and not
drawn**, because a box for it would either be a stub with no members or a
second diagram's worth of context.

### The data model

The entity is the **table**, not the class — that is what an ER diagram is
about, and the table name is what the `@Table` annotation stated.

Columns are the mapped class's fields **plus the fields it inherits**, walked up
the `extends` chain. This is not a convenience: JPA maps a mapped-superclass
chain into the subclass's table, so an ER diagram that omitted them would show
`owners` with no primary key. On petclinic every one of the six tables gets its
`id` this way, from `BaseEntity` two or three hops up.

A relationship needs a cardinality and a target:

- **Cardinality** comes from the JPA annotation — `@ManyToOne`, `@OneToMany`,
  `@OneToOne`, `@ManyToMany`. Nothing else is guessed from a field's plurality
  or its name.
- **Target** comes from the field's own type, or from the recorded type
  arguments when the field is a collection.

An association whose target cannot be read is **counted, described, and given
its own table on the page** — never drawn to a plausible table. The reason is
printed per row, because "we could not read this" and "there is no such
relationship" have to look different.

Column *types* are the declared Java types. The SQL type is chosen by the
provider at runtime and stated nowhere in the source, so it is absent rather
than approximated.

## What the erasure cost, measured

This ADR exists partly to record a number.

`Fqn.erase` reduces `List<Pet>` to `java.util.List`, and it has to: an fqn
appears in a method signature, so two overloads differing only by type argument
must produce one node rather than two (ADR-0007). That erasure also destroys the
only thing that says what a collection holds.

Measured on petclinic before the extractor recorded type arguments:

| Association | Cardinality read | Target read |
| --- | --- | --- |
| `Pet.type` → `PetType` | yes | yes |
| `Owner.pets` → `List<Pet>` | yes | **no** |
| `Pet.visits` → `Set<Visit>` | yes | **no** |
| `Vet.specialties` → `Set<Specialty>` | yes | **no** |

**One relationship out of four.** An ER diagram of six tables with one line on
it is worse than no ER diagram, because it looks like a schema rather than like
a failure to read one.

So the Java extractor now records `typeArguments` **beside** the erased type
rather than folding it into it. No fqn changes; nothing about node identity
moves. An argument that was never attributed is omitted rather than padded, so
a half-readable `Map<String, Missing>` reports the half it read. With that in
place petclinic yields all four relationships, and the `unreadable` table is
empty — which is the outcome that makes the empty table meaningful.

## Alternatives considered

**Infer the collection's element type from the field name.** `pets` is a
collection of `Pet` roughly always. Rejected outright — this is the
name-matching-dressed-up-as-a-dependency-graph that ADR-0001 rejected for Java
and ADR-0018 rejected for URLs, and it would be right often enough to be
trusted and wrong often enough to be dangerous.

**Read the schema from migrations or `schema.sql` instead.** Rejected for now,
and it is the strongest extension available: a migration tool's DDL is the
actual schema, where the ORM mapping is only the part the application models.
It needs a SQL parser and a new extractor, which is a milestone rather than a
section. The diagram says what it is drawn from, so the gap is visible.

**Draw one class diagram of the whole repository with a zoom.** Rejected. It
needs JavaScript, which ADR-0020 spent its whole argument avoiding.

**Put every class in the diagram regardless of package.** Rejected: 214 boxes
is a texture. The cap keeps the types declaring the most members and states
what it dropped.

**Infer cardinality from the field's type being a collection.** Rejected, and
it is subtle: `List<Pet>` really is to-many. But `@OneToMany` versus
`@ManyToMany` is a schema decision with a join table behind it, and the
annotation is right there. Where the annotation is absent, the field is a
column, not a relationship.

## Consequences

- The report is much longer, and most of the new length is tables of citations.
  That is the correct trade for this project — a diagram without its evidence
  underneath it is the thing CLAUDE.md forbids.
- Level 4 exists, so "C4" is now an accurate description of the output rather
  than an aspiration with three quarters of it built.
- The ER model is only as complete as the ORM mapping. A schema half-defined in
  migrations produces a half diagram, and the notes say so on the page.
- The extractor now emits slightly more per field. Measured on petclinic the
  fact stream grew by well under a percent, because only parameterised fields
  carry the attribute at all.
- One real gap remains and is stated rather than hidden: a `@ManyToMany` join
  table is not an entity, so it never appears as a box. The relationship line
  is drawn between the two tables it joins, which is how an ER diagram normally
  renders it, but a reader looking for `vet_specialties` will not find it.
