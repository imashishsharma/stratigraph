# ADR-0013: The grounding contract, enforced in code

- Status: accepted
- Date: 2026-07-29
- Milestone: M3 (before the code)

## Context

M3 is the first time a model writes into this database. CLAUDE.md's inviolable
rule says the model never produces a fact, and that every claim carries a
provenance reference. PLAN.md is more specific still: *enforce this in code —
reject model output that fails the citation check rather than trusting the
prompt.*

Trusting the prompt is the default failure. A prompt saying "cite your evidence"
produces output that cites evidence nearly always, and the residue is the
problem: a description that names `com.example.billing.TaxCalculator` when no
such class was ever mentioned, cited to a real edge id that says something else.
It reads exactly like the correct output. That is the confidently-wrong map this
project exists to avoid, and no amount of prompt wording removes it, because the
prompt is a request and not a constraint.

Two things have to be settled: what the model is allowed to refer to, and what
happens when it refers to something else.

## Decision

**The model is shown an evidence pack of opaquely-identified items, and may
refer only to what is in it. A validator in code checks that, and output failing
the check is never stored.**

### The evidence pack

Per cluster, an assembled set of items, each with an opaque id and a rendered
line of text:

| Prefix | Kind | Resolves to |
| --- | --- | --- |
| `n…` | node | a `node` row — a package or a type |
| `e…` | edge | an `edge` row, with file and line |
| `f…` | file | a `source_file` row |
| `c…` | commit | a `git_commit` sha |

The ids are opaque and pack-local — `e12`, not the database's edge id 88431.
That is deliberate. A model asked to emit database primary keys can emit a
plausible one for a row it was never shown, and the citation would resolve to a
real row saying something unrelated. A pack-local id cannot: `e99` in a pack of
twelve items resolves to nothing, and the output is rejected. **Guessing has to
fail closed, and the indirection is what makes it fail closed.**

The pack carries structural metadata only. Source bodies go only when
`--send-source` is set, which is off by default and logged at warning level when
on, per CLAUDE.md.

### What counts as a claim

The schema distinguishes the two, because the rules differ:

| Field | Kind | Must cite |
| --- | --- | --- |
| `name` | label | no |
| `responsibility[].text` | claim | yes |
| `mismatch.text` | claim | yes |
| `adrCandidates[].decision.text` | claim | yes |
| `adrCandidates[].evidence.text` | claim | yes |
| `adrCandidates[].title` | label | no |
| `adrCandidates[].question` | question | no |

A name is a label, not an assertion about a particular edge, so requiring it to
cite one would be theatre. A question for the team is a question — "should the
reporting package depend on admin?" asserts nothing. Both are still subject to
the vocabulary rule below: a label may not name a class nobody showed it.

### The four rejection rules

1. **Unknown citation.** A `cites` entry that is not an id in the pack.
2. **Uncited claim.** A claim field with an empty `cites` array.
3. **Invented identifier.** Any dotted identifier, path-like token or commit-sha
   -shaped token appearing in any text that is not in the pack's vocabulary.
   This is the rule that catches the dangerous case — a real citation attached to
   a sentence about a class that does not exist. Rules 1 and 2 check that a
   pointer exists; rule 3 checks that the prose stayed inside what the pointer
   was attached to.
4. **Unresolvable ADR evidence.** An ADR candidate whose evidence does not
   resolve to pack ids. An ADR candidate is a proposal a team will act on, and
   one that cannot be traced back is worse than none.

The vocabulary for rule 3 is every identifier and path appearing anywhere in the
pack, **plus every dotted prefix of every member package**. The prefixes matter:
a cluster of `com.example.shop.web` and `com.example.shop.repo` should be
describable as "the `com.example.shop` packages", and a prefix of a real package
is not an invented fact. A short stop-list (`e.g`, `i.e`, `etc`, `vs`) keeps
ordinary English from tripping the token pattern.

Rule 3 will occasionally reject a true sentence. That trade is taken
deliberately: the cost of a false rejection is a cluster that goes undescribed
and says so, and the cost of a false acceptance is a fabricated claim carrying a
real citation. Those are not comparable, and this project's whole premise is
that the second is worse than having nothing.

**What that cost out to in practice.** The first live runs rejected 4 of 13
dubbo descriptions and 1 of 1 on petclinic. Every rejected name turned out to be
real — not one fabrication among them. Three distinct causes, all of them the
rule misreading the *form* of a true statement:

| The model wrote | Rule 3 saw | Actually |
| --- | --- | --- |
| `dubbo-config/.../org/apache/dubbo/config` | an invented path | a directory above a file it was shown |
| `adaptive.impl` | an invented package | an abbreviation of `org.apache.dubbo.common.extension.adaptive.impl` |
| `interface/implementation`, `owner/pet/visit` | an invented path | English, using a slash to mean "and" |

So the vocabulary now admits directory prefixes of shown paths and dot-suffixes
of shown names, and only *file* paths — a final segment carrying an extension —
are treated as paths at all. None of that loosens what the rule is for: a suffix
can smuggle nothing in (`repo.Qux` is the tail of nothing when only
`repo.OrderRepo` was shown), and a fabricated file path is still caught, which
is the shape that looks like evidence someone could open.

The check for this is empirical and repeatable rather than argued: every one of
dubbo's 38 evidence packs is run through the validator with grounded output and
with five kinds of deliberately mutated identifier. It has stayed at 38/38
grounded accepted and zero fabrications missed across every change above. **A
change to rule 3 that cannot hold that line is not a tuning, it is a hole.**

### What is not checked, and must not be claimed to be

The validator checks that a sentence points at real evidence and stays inside
the vocabulary it was given. **It cannot check that the evidence supports the
sentence.** A model can cite seven genuine imports and draw the wrong conclusion
from all of them, and every rule above passes.

This is why ADR-0014 keeps the intent-mismatch *claim* algorithmic and lets the
model write only the prose around it: the check then only ever has to guard
language about something already true. Anywhere the model does assert something
new — a cluster's responsibility, an ADR candidate — the output is marked
`authored_by = 'model'` and carries the model id, and the report says so. It is
interpretation, labelled as interpretation.

### Retry once, then leave it empty

A rejected response is retried once, with the specific violations appended. On a
second failure the layer gives up: `cluster.name` and `description` stay NULL, a
`diagnostic` row records what was rejected, and the report says the cluster was
not described.

Once, because the first retry corrects the ordinary case — a mis-typed id, a
sentence that drifted — and further attempts on the same input mostly resample
the same failure at proportional cost. Giving up silently is not an option: an
undescribed cluster and a cluster nobody tried to describe must not read the
same, which is the same principle the coupling report already applies to the
difference between "looked and found nothing" and "could not look".

**Rejected output is never written, not even to a scratch column.** A rejected
description in the database is a rejected description someone will eventually
read.

### The model recorded is the model that answered

`finding.model` and `cluster.model` record the model id from the API response,
not the one from the config. If those ever differ — a server-side fallback, a
provider alias resolving elsewhere — the row must name what actually wrote it.

## Alternatives considered

**Put the rules in the prompt and trust it.** Rejected: this is the thing
PLAN.md names explicitly. Prompt instructions raise compliance, and the residue
is precisely the output that looks correct and is not.

**Let the model cite real database ids.** Rejected: a guessed id resolves to a
real row, so guessing fails *open*. The whole value of the opaque pack-local id
is that a guess cannot land on anything.

**Free-text citations ("see OrderController.java:42") parsed afterwards.**
Rejected: parsing prose back into rows re-introduces the guessing at the parser
instead of the model, and a near-miss ("OrderControllers.java") would resolve to
nothing with no way to tell a typo from a fabrication.

**Structured output alone, with no validator.** The `output_config.format`
JSON schema guarantees the response has a `cites` array of strings. It cannot
guarantee those strings are ids from this pack, and it says nothing at all about
the prose. Schema enforcement is necessary and is used; it is not sufficient.

**Retry until it passes.** Rejected: unbounded cost, and a rule that "eventually
passes" is not a rule. A cluster with no description is an acceptable outcome;
an unbounded bill is not.

**Store rejected output with a `valid = 0` flag.** Rejected on ADR-0002's
reasoning: the value of being able to answer "who wrote this?" by looking at the
table comes from not having to also check a flag someone might forget.

## Consequences

- The citation machinery gets its adversarial test. It was exercised by
  algorithms through M1 and M2 — things that cannot hallucinate — before being
  trusted with something that can, which is the order that makes the guarantee
  worth anything.
- The validator is a pure function over a pack and a response, so the rules are
  unit-tested exhaustively with no network involved, and CI never calls an API.
- A cluster can end up with a `cluster-responsibility` finding *and* a name on
  the `cluster` row saying the same thing. The duplication is forced:
  `citation` joins to `finding` only, so a described cluster needs a finding to
  hang its evidence from.
- The model's reading of an intent mismatch is a **separate** finding from the
  algorithmic one, rather than extra prose appended to it. Mixing the two would
  give one row two authors.
- Rule 3 is the rule most likely to need tuning as real reports are read. It is
  a single function with a single stop-list, tuned by adding to the vocabulary
  rather than by loosening the check.
- **The vocabulary and rule 3 share one tokeniser.** They began as two copies of
  the same regex list, which is two ways for them to disagree — and either
  direction is a defect: a hole, or a rejection of a name the pack really did
  contain. `identifiersIn` is exported from `contract.ts` and used by both.
- Running the validator over 38 real evidence packs from dubbo — mean 68
  identifiers each — found the hole that synthetic fixtures could not. The Java
  extractor names the unnamed package `<default>`, angle brackets are not word
  characters, and `\b` will not start a match on one, so `<default>s` and
  `<default>.AbstractRegistryFactory` matched no pattern and went entirely
  unchecked. Fabrications built on any *named* package were caught; only that
  one shape escaped. The lesson is about the exercise, not the pattern: rule 3
  can only be trusted against a vocabulary as messy as a real repository's.
