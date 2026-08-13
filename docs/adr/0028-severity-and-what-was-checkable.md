# ADR-0028: A finding is rated by how checkable it is, not only by how strong it looks

- Status: accepted
- Date: 2026-08-13
- Milestone: M8

## Context

ADR-0021 made severity load-bearing *across* rules: the ranked list interleaves
every rule, so a rule that sets severity carelessly now outranks other rules'
findings rather than only sorting oddly among its own. It also said, of the
rules themselves, that each one's severity choice "deserves the same scrutiny as
its detection logic". That scrutiny had not happened.

Run against spring-petclinic, the ranked list opened like this:

```
23 of 44 findings are high, and 20 of those 23 are:

  gradle/wrapper/gradle-wrapper.jar and gradlew.bat change together
  gradle/wrapper/gradle-wrapper.properties and gradlew change together
  ...
```

Meanwhile `intent-mismatch` — a package whose name and edges disagree, derived
from the graph and cited to a file and line — came out `medium`. The two most
architectural rules in the tool were being outranked by a build wrapper.

Two independent mistakes produced that.

**Coupling severity came from co-change strength alone.**
`gradle-wrapper.jar` and `gradlew.bat` change together in 11 of 11 commits.
That is a perfect strength score and it means one tool regenerates both. The
finding's own detail already said as much:

> *No extractor parses `mvnw` or `mvnw.cmd`, so no dependency could have been
> observed between them either way. This is co-change without a checkable
> explanation, not a demonstrated absence of coupling in the code.*

So the tool knew. It wrote the caveat into the detail and then rated the finding
as though the caveat did not exist.

**Hotspot severity came from rank position** — `index < 3 ? 'high' : ...`. That
is not a measurement of anything. Every repository has a top three, so a
pristine codebase mints exactly as many `high` hotspots as a rotten one, and
they compete in the ranked list with cycles that were derived and cited.

## Decision

**Severity reflects how well the finding's own evidence supports it.**

### Coupling

A pair is rated on strength only when a dependency between the two files
*could have been observed*: the run has a static graph, and both files are ones
an extractor parses. Otherwise the finding is `low`.

```ts
const checkable = staticGraph && pair.parsedA && pair.parsedB;
if (!checkable) return 'low';
return pair.strength >= 0.8 ? 'high' : pair.strength >= 0.5 ? 'medium' : 'low';
```

The condition is not new — it is the same one that already chooses the wording
in `staticNote`. The change is that severity now agrees with the sentence
underneath it. **A finding whose own evidence disclaims it must not be rated as
strongly as one that does not.**

Nothing is dropped. The pair is still reported, still cites the commits that
produced it, and still appears in the report; it no longer competes with a cited
structural defect for the reader's first thirty seconds.

### Hotspots

Capped at `medium`. A hotspot is an observation about where change concentrates,
not a demonstrated defect, and its rank is relative to one repository. A
relative position must not mint a severity that outranks an absolute finding.

## Alternatives considered

**Exclude non-code files from coupling entirely.** Rejected, and it was the
first idea. The README makes a promise this would break: complexity is total
indentation precisely so that the XML, SQL and properties files that turn up in
coupling pairs constantly are scored rather than skipped. A migration script
that always changes with a service *is* the finding worth having. The problem
was never that these pairs are reported — it is that they were reported as
loudly as the checkable ones.

**Classify files as code and non-code, and rate accordingly.** Rejected as a
worse version of the above with a bikeshed attached: is `.sql` code? `.xml`?
`.tf`? The tool already has an exact, boring answer to a better question —
*did an extractor parse this file* — and that is the one that decides whether
the claim was checkable.

**Weight severity by a composite score.** Rejected for the reason ADR-0021
rejected it for ranking: the constants would be invented here, and a reader
asking why one finding outranks another would get an equation rather than a
reason. `checkable` is a fact about the run, not a tuning parameter.

**Leave hotspots at `high` and fix only coupling.** Rejected. It leaves the
smaller version of the same bug: three guaranteed `high` findings per run, from
a rank rather than a measurement, sitting above cited cycles.

## Consequences

- On spring-petclinic, `high` drops from 23 findings to 7, and all seven are
  Java test files co-changing with no dependency between them — a checkable
  claim about code. The gradle wrapper pairs are still reported, at `low`.
- On nestjs/nest, the `high` band becomes *entirely* package cycles. That is
  what a reader should meet first, and previously three rank-position hotspots
  sat among them.
- `--fail-on high` becomes a usable gate rather than one that fires on every
  repository with a gradle wrapper in it. This lands the same week as the gate
  (ADR-0027) and is most of what makes it worth turning on.
- A history-only run — no `extract`, so no static graph — now rates its whole
  coupling list `low` rather than `high`. Correct: nothing was checked, and the
  report already says so in every one of those findings.
- Severities change for existing stores. A `diff` across the upgrade will show
  no findings added or resolved, because identity is `(rule, title)` and neither
  moved (ADR-0027) — but the severity counts either side will differ, and a
  `--fail-on` threshold tuned before this will be looser after it.
