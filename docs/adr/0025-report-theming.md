# ADR-0025: Report theming

- Status: accepted
- Date: 2026-08-13
- Milestone: M8 (decided before the code)

## Context

The report is handed to companies, and a company hands documents onward with
its own name on them. That needs branding (name, logo, accent), an in-page
scheme choice, and a printable document — without moving anything ADR-0020
and ADR-0024 promised: one file, no script, no network, byte-identical per
run, panels that degrade to one document without CSS.

## Decision

**Brand is config data, validated at load.** `report.brand` carries `name`,
`logo` (a path, resolved against the config file like `apiKeyFile`) and
`accent` (a hex colour). A malformed colour or an unreadable logo is a
`ConfigError` — a report silently missing the customer's logo is the kind of
quiet failure this project refuses elsewhere, and it is refused here too.

**The logo embeds as a data URI.** Self-containment is non-negotiable; a
`file:` or `https:` reference would break it. SVG and PNG (and JPEG/WebP) are
accepted by extension; anything else is an error. A logo past 512 KB is a
warning — the page is meant to be emailed.

**The accent is checked, and corrected deterministically.** The accent drives
tab underline, tiles, links, bars, and the diagram tint ramp. An accent that
cannot reach 3:1 contrast against the surface it sits on is stepped darker
(light scheme) or lighter (dark scheme) in fixed-size lightness increments
until it can — a pure function, so determinism holds — and the report's
limits panel says the adjustment happened and from what to what. Silent
correction would repaint the customer's colour without telling anyone;
refusing outright would fail the report over a stylesheet.

**Diagrams take the brand through a derived ramp, not raw.** The SVG palette
becomes a parameter of `toSvg` with today's values as the default. From one
accent: box fills are fixed-ratio mixes toward white, strokes fixed-ratio
mixes toward black — the same arithmetic every run, so the same accent always
yields the same bytes. Inference amber is not themeable: it means one thing
everywhere (ADR-0013), and a brand whose accent is amber does not get to make
inference look observed.

**The toggle is `:has()` over radios.** Three states — auto, light, dark —
where auto keeps `prefers-color-scheme`. Token blocks are generated from one
map so the schemes cannot drift. No script; browsers without `:has()` simply
keep the auto behaviour, which is what they have today. Print forces light
and hides the toggle.

**The cover page is print-only.** On screen the summary is the cover. On
paper the first page carries brand, repository, commit, date and the tiles —
assembled from the same objects as the summary, deriving nothing.

## Alternatives considered

**A free-form CSS override hook.** Rejected. It delegates the contrast and
CVD guarantees to whoever writes the override, and the first unreadable
customer report is this tool's reputation, not theirs.

**Theming the full categorical palette, not just the accent.** Rejected for
M8. Severity and inference colours carry meaning the reader learns once;
letting a brand repaint them trades legibility for decoration. One accent is
the 90% case.

**A JavaScript theme switcher.** Rejected without argument — ADR-0020.

## Consequences

- `toSvg` gains a palette parameter; the byte-exact SVG fixture keeps
  asserting the default.
- Two reports of one run with two brand configs differ — determinism is per
  (run, config), which the footer already implies by naming the version.
- The `:has()` toggle is progressive enhancement; the guarantee is only that
  no browser is worse off than before it existed.
