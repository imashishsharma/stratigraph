# ADR-0030: Every file has a role, and the role cites its rule

- Status: accepted
- Date: 2026-09-27
- Milestone: M9 (before the code)

## Context

v1.6.1 was run against a real enterprise Spring Boot + Angular repository and
ranked `package-lock.json` as its riskiest file, with `package.json` close
behind. Every number behind that ranking was true — the lockfile really was
rewritten thousands of lines at a time, by a single author, hundreds of times.
The ranking was still nonsense, because nothing in the store knew that a
lockfile is not code anybody reasons about.

History covers every tracked file on purpose (ADR-0011, `complexity.ts`): the
files that turn up in coupling are often the ones no extractor parses. That
remains right for coupling. It is wrong for any view that answers "where is the
risk in this code?", and the store had no way to tell the two apart.

## Decision

A new fact table, `file_role`, holds one row per tracked file per run:

| role        | meaning                                                         |
|-------------|-----------------------------------------------------------------|
| `source`    | hand-written program text: code, templates, styles, SQL         |
| `test`      | anything under a test root or named as a test                   |
| `generated` | produced by a tool; marked in `.gitattributes`, a path, or a header |
| `vendored`  | third-party code checked in, including minified bundles         |
| `lockfile`  | a resolved dependency lock                                      |
| `manifest`  | build and dependency declarations, build wrappers               |
| `migration` | schema migrations (Liquibase, Flyway, `migrations/`)            |
| `config`    | JSON, YAML, XML, properties and dotfiles not covered above      |
| `docs`      | prose                                                           |
| `asset`     | images, fonts, archives, media                                  |
| `other`     | none of the above                                               |

Every row carries `rule` — the identifier of the rule that assigned it, such as
`name:package-lock.json`, `gitattributes:linguist-generated`,
`path:src/test/` or `header:@generated` — and, for header rules, the `line` the
marker sits on. A role is therefore checkable the same way an edge is: the
citation says exactly what was looked at.

Rules are applied in a fixed order and the first match wins:

1. `.gitattributes` — `linguist-generated` and `linguist-vendored`, asked of
   `git check-attr` so that git's own pattern semantics apply. The repository
   stating a file's nature outranks any guess of ours.
2. Lockfiles, by exact name.
3. Vendored and generated paths (`vendor/`, `third_party/`, `generated/`,
   `generated-sources/`, `*.min.js`).
4. Build manifests and wrappers, by exact name or directory.
5. Migrations, by directory.
6. Tests, by directory or name convention.
7. Source, by extension — then a header check: a source file whose first 1 KB
   carries a generated-code marker is `generated`, citing the line.
8. Docs, config, assets by extension or name; `other` otherwise.

Tests come before source because `FooTest.java` is both, and the question every
consumer asks is "is this production code?". Manifests come before tests so a
test module's `pom.xml` is a manifest.

The table is populated from `git ls-files`, so it describes the same file set
history does, and it is recomputed idempotently wherever it is needed.

## What reads it

- Hotspots and bus factor rank `source` only (ADR-0031).
- Coupling is unchanged: it still spans every file, because a migration that
  always changes with an entity is exactly the kind of pairing it exists to find.
- M10 uses `test` to separate test code from the architecture.

## Consequences

- A user can override a misclassification the way the repository already
  would: with `linguist-generated` / `linguist-vendored` in `.gitattributes`.
  No stratigraph-specific knob is added until someone needs one.
- The rule list is a judgement, and it will be wrong somewhere. That is why each
  row names its rule: a wrong role is visible and has an obvious fix, instead of
  being a silent input to a ranking.
- Name conventions are not facts about intent. `rule` makes it explicit that a
  role came from a convention, and nothing downstream presents a role as more
  than that.
