# ADR-0016: Angular without the Angular compiler

- Status: accepted
- Date: 2026-07-31
- Milestone: M5 (before the code — this determines what the extractor can know)

## Context

CLAUDE.md describes the TypeScript extractor as using "the TypeScript compiler
API plus `@angular/compiler-cli` to resolve DI, standalone components/NgModules,
routes, and template bindings". ADR-0001 repeats it.

`@angular/compiler-cli`'s entry point is `NgtscProgram`, and getting one means
handing it a `ts.CompilerOptions` derived from a real `tsconfig.json`, over a
project whose `node_modules` are installed, so that `@angular/core` resolves and
the decorators can be recognised as Angular's. Template type-checking needs the
program to type-check.

That is the highest-fidelity option, and it is unavailable on most of the
codebases this tool exists for — which is exactly the finding ADR-0006 recorded
for Java, arrived at again from the other side of the stack.

The Angular repositories that need archaeology routinely:

- have a lockfile that no longer resolves, or resolve from a private registry
  unreachable from wherever the analysis runs;
- are two or three major versions behind, so `npm ci` needs a Node old enough
  that the analysis tool will not run on it;
- do not type-check, which is often *why* someone is pointing an archaeology
  tool at them;
- are one Angular application inside an Nx or Lerna monorepo with fifteen
  `tsconfig.json` files and no single program that spans the interesting code;
- have no `tsconfig.json` reachable from the directory being analysed at all,
  because the build is assembled by a script.

And the quieter problem ADR-0006 raised applies unchanged: `npm install` on the
analysed repository executes that repository's `postinstall` scripts. Pointing a
read-only analysis tool at a codebase must not run that codebase.

## Decision

**The extractor parses the source set. It does not install, resolve, or
type-check the target project, and it does not use `@angular/compiler-cli`.**

Concretely:

1. **Discovery walks the filesystem** for `.ts`, `.tsx`, `.mts`, `.cts` and
   `.html`, honouring the config's `include`/`exclude`. Nothing keys off
   `src/app`, so an Angular 2-era layout, a `projects/*` workspace and an Nx
   monorepo are all found by the same walk. `.d.ts` files are skipped: they
   declare types without containing the code that would justify an edge.
2. **One `ts.Program` over every discovered file**, created with
   `ts.createProgram` from that file list — **not** from a `tsconfig.json`, and
   not one program per project. As with ADR-0006's shared `JavaTypeCache`, this
   is what makes types resolve across module and project boundaries: a component
   in `apps/web` injecting a service from `libs/data-access` attributes
   correctly even though nothing was built. Diagnostics from the program are not
   consulted; a project that does not compile still yields its structure.
3. **`tsconfig.json` supplies path aliases where it exists, and nothing else.**
   It is read as plain JSON — comments and trailing commas tolerated via
   `ts.parseConfigFileTextToJson` — for `compilerOptions.paths` and `baseUrl`,
   with `extends` chains followed only inside the repository. This is the exact
   analogue of ADR-0006 reading `pom.xml` as plain XML for module identity.
   Aliases matter more here than they look: in an Nx monorepo,
   `@myorg/data-access` is the *only* way most cross-project imports are
   written, and without `paths` every one of them is unresolvable.
   **A repository with no `tsconfig.json` is a normal case, not an error.**
4. **Angular's decorators are recognised syntactically, by name and by the
   module the name was imported from.** A class decorated `@Component` where
   `Component` was imported from `@angular/core` is a component. This is
   ADR-0005's rule, applied to a second framework: a recognised decorator
   produces a fact, an unrecognised one produces nothing. A team's custom
   `@Page()` wrapper around `@Component` is not a component to us, and we do not
   guess that it might be.
5. **Templates are parsed with `@angular/compiler`'s `parseTemplate`**, which is
   a standalone function over a string and needs no program, no options and no
   installed project. It is the same entry point `@angular-eslint`'s template
   parser uses. `@angular/compiler` is a single package whose only dependency is
   `tslib`; `@angular/compiler-cli` is not a dependency and is not installed.
6. **Unresolved is unresolved.** An import that resolves to nothing inside the
   parsed source set becomes an `is_stub` node (`node.is_stub`, carried since
   M0) or, for a DI token, no edge at all plus a diagnostic. A file that fails
   to parse produces an `error` diagnostic and the run continues.

### What this costs, stated plainly

Without `node_modules` and without `NgtscProgram` the extractor cannot see:

- **anything declared in a library.** `MatDialog`, `Store`, `TranslateService`
  and every other injectable from a package are `is_stub` nodes. The `injects`
  edge into them is real and is recorded; what is missing is the far side.
- **template type-checking.** A binding to a member that does not exist is
  Angular's error to report, not ours. We record which component a template
  instantiates, not whether every expression in it is well-typed.
- **DI through anything computed.** `provide: TOKEN, useFactory: …` resolves an
  injection at runtime. A `useClass` naming a class we parsed is a fact; a
  factory is not, and produces no edge.
- **decorator metadata Angular itself synthesises**, and anything a build step
  generates — GraphQL codegen output, `ngx-translate` extraction, generated API
  clients — because none of it is in the source tree.

Each of these produces *absence*, never a wrong edge. That is the same trade
ADR-0006 made, for the same stated reason: CLAUDE.md's "a confidently wrong
dependency map is worse than no map".

### The higher-fidelity path is not closed

Nothing in the design assumes `node_modules` is absent — only that it may be. If
a repository *is* installed, the same `ts.Program` resolves more imports and more
stubs become real nodes, with no code change: `ts.createProgram` will follow a
`node_modules` path if one exists on disk. What this ADR forecloses is
*requiring* it, and running the target's install to get it.

## Alternatives considered

**`@angular/compiler-cli` / `NgtscProgram`, as CLAUDE.md specifies.** Rejected.
It is genuinely higher fidelity — real template type-checking, DI resolved
through Angular's own semantics, meta-decorators followed. It also requires the
target repository to install and largely compile, which excludes the majority of
the intended targets, and pulls a much heavier dependency tree (`@babel/core`,
`chokidar`, `yargs`) into a tool whose install weight is already a stated
concern in ADR-0004. Revisit as an *optional* high-fidelity mode for
repositories that do install, in the same way ADR-0006 left the classpath path
open for Java.

**tree-sitter, or a hand-rolled TypeScript parser.** Rejected for the reason
ADR-0001 already rejected it for Java: no symbol resolution, so
`this.orders.find()` cannot be tied to a declaration, and the output is
name-matching dressed up as a dependency graph.

**Resolve `typescript` and `@angular/compiler` from the analysed repository's
own `node_modules` instead of bundling them**, so each repository is parsed by
its own compiler version. Rejected: it makes extraction depend on the repository
being installed, which is the thing this ADR exists to avoid. The fidelity
argument is also weaker than it looks — the TypeScript parser is backward
compatible, and `parseTemplate` handles older template syntax fine, because new
control-flow syntax was additive.

**One `ts.Program` per `tsconfig.json` found in the repository.** Rejected, and
it is the obvious reading of "monorepo". It is ADR-0006's "parse each module
separately" in a different costume: every cross-project edge is lost, and on an
Nx workspace the cross-project edges are the entire point.

**Require the repository to type-check, and refuse otherwise.** Rejected. It
would make the tool useless on precisely the codebases it targets.

## Consequences

- The extractor runs on any TypeScript repository on disk, including one that
  has never been installed, does not compile, or has no `tsconfig.json`.
- Extraction stays hermetic: no network, no `npm install`, no execution of the
  analysed repository.
- `typescript` and `@angular/compiler` become runtime dependencies of the npm
  package, adding roughly 27 MB to an install that previously paid nothing for
  a stack it might not use. Accepted deliberately, against ADR-0004's
  concern about install weight: unlike the Java extractor jar, these are needed
  by a Node process we already ship, and a fetch-on-first-use mechanism for them
  would be new machinery for a smaller saving.
- The graph is sparser than an `NgtscProgram`-resolved one, and the gap is
  concentrated in library-mediated edges. Reports must distinguish "no
  injections found" from "injections could not be resolved" — the diagnostic
  counts are how they do it, exactly as for Java.
- Memory is the scaling limit again: one program holds every first-party source
  file. Measured during M5 acceptance rather than guessed at here.

## The acceptance run

<!-- Filled in when M5's acceptance criteria are checked. -->
