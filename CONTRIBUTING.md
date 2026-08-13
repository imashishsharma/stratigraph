# Contributing to stratigraph

Thanks for looking. Issues, questions and pull requests are all welcome — and
so is telling me the tool was wrong about your codebase, which is the most
useful bug report this project can get.

Read [the one rule](#the-one-rule) before anything else. It is unusual, it is
the reason the tool exists, and a change that breaks it will not be merged
however good it otherwise is.

## Getting it running

```sh
npm install
npm test                 # vitest — needs no JDK
npm run typecheck
npm run build
npm run stratigraph -- doctor    # the CLI, from source

cd extractors/java && ./mvnw verify   # the JVM extractor and its golden tests
```

The extractor needs a **JDK 17+ to run in**. If your default `java` is older,
point at a newer one for that command only:

```sh
JAVA_HOME=/path/to/jdk17 ./mvnw verify
```

`stratigraph doctor` is the fastest way to find out what your machine can and
cannot do, and its output is what an issue should usually start with.

## The one rule

**Static analysis produces facts. A model produces interpretation. The model
never invents a fact.**

Concretely, and these are the ones that come up in review:

- Every node and edge comes from a parser, from `git log`, or from a build
  file. Never from an inference.
- Every claim in any output carries provenance: a file and line, a commit sha,
  or a fact-table row.
- **An absence is reported as an absence.** If something could not be resolved,
  the answer is a diagnostic and no edge — never a plausible guess. "No
  evidence found" is a correct output; a confidently wrong dependency map is
  worse than no map.
- Anything a model wrote is marked as inference in the data model *and* in
  every place it is shown.

Most of the review comments on a first PR are some version of this rule. If a
change would make the tool state something it cannot cite, it is the change
that has to move.

## Conventions

**Test-first in the fact layer. A parser change without a fixture test does not
get merged.** Fixtures live in `fixtures/`, are tiny and hand-written, and
assert *exact* output — not "contains". Facts appearing that should not (a
guessed edge) matter as much as facts going missing, and a subset assertion
catches only half of that.

Goldens can be regenerated:

```sh
cd extractors/java && ./mvnw verify -Dstratigraph.updateGoldens=true
```

A regenerated golden is only worth having if a human reads the diff. Read it.

**Every non-obvious decision gets an ADR** in `docs/adr/`, in the format the
existing ones use: context, decision, alternatives considered *with why each
was rejected*, and consequences including the costs. The project dogfoods the
practice it exists to support. Add a row to `docs/adr/README.md`.

**No speculative abstraction.** Two concrete implementations before extracting
an interface.

**Small commits, conventional commit messages.** Please do **not** add
`Co-Authored-By` or agent-session trailers — they list the assistant as a
GitHub contributor, which misrepresents authorship of the project.

## What is most useful right now

The tool is young and the most valuable contributions are not code:

- **Run it on a repository I have never seen and tell me what it got wrong.**
  A wrong edge, a missed endpoint, a finding that is noise — with the output
  and, if you can share it, the shape of the code that produced it.
- **Toolchain reports.** A JDK layout, a build system or an OS where `doctor`
  says the wrong thing.
- **A language you need.** Java, Kotlin and TypeScript/Angular are what exist.

If you are opening a bug, `stratigraph doctor --format json` is worth pasting —
most surprises turn out to be a toolchain difference rather than a parser one.

## Licence of contributions

The project is Apache-2.0 and contributions are accepted under it — by opening
a pull request you agree your contribution is licensed the same way.

If that ever needs to change, it will be raised in the open before any code is
merged under different terms.

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).
