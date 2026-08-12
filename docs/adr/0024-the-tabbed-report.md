# ADR-0024: The tabbed report

- Status: accepted
- Date: 2026-08-13

## Context

The M6 report is one page in one long scroll: findings, four levels of C4,
the data model, the API surface, the matrix, hotspots and limits, in order.
On a real repository that is thousands of rows, and the readers it is for —
the people deciding whether to fund the refactor, not only the people doing
it — do not scroll past the second screen. The report also carried a
developer-tool dark theme by default, and it is read in meetings, attached
to emails and printed, which are light-surface contexts.

ADR-0020's guarantees are not negotiable: one file, no script, no network,
no CDN, renders with JavaScript disabled, byte-identical for the same run.
Any restructuring has to keep all of them.

## Decision

**Tabs, implemented in CSS alone.** One hidden radio input per panel and a
label bar; `:checked` sibling selectors show the selected panel. The wiring
is generated from the same list as the markup, so the tab bar and the page
cannot disagree. There is still no script: the report remains one file that
opens from a file share. A reader without CSS — a mail client, a text
browser — gets every panel in order as one document, which is exactly the
M6 page. Printing does the same: a print rule expands every panel and hides
the tab chrome, so paper carries the whole report, not the selected tab.

**A summary panel first.** The two-minute page: the run's provenance, the
count tiles, the first five findings, the five hottest files, and the
how-to-read-this legend. Everything on it is a projection of what another
panel carries in full — the first rows of the same ranked list, computed
from the same objects — so no number on the summary can disagree with the
panel it points at, and the presenter still derives nothing.

**Light by default, dark under `prefers-color-scheme`.** The colours are a
palette validated as a set for colour-vision-deficiency separation and
contrast in both modes; severity is never carried by colour alone (the word
sits beside every severity mark). Diagrams are the exception: their SVG
colours were chosen against a dark surface (ADR-0020), so figures keep that
dark surface in both schemes rather than inverting badly.

**The h1 is the repository's name, not its path.** Where the clone happened
to sit is provenance, and it stays on the summary with the commit; it is not
a title.

## Alternatives considered

**A JavaScript tab component.** Rejected without much argument: ADR-0020's
"renders with scripting disabled" is the pitch, and the radio-input pattern
delivers the same interaction for free.

**Multiple HTML files, one per subject.** Rejected. "One file that survives
being emailed" is a property people rely on; a directory of pages is not an
attachment.

**`:target`-based tabs (fragment links).** Rejected: the back button fights
the tabs, a fragment can only select one thing per page load, and printing
shows one panel. Radios have none of these problems.

## Consequences

- Deep links into a specific tab do not exist — a fragment cannot check a
  radio without script. Within-panel anchors still work once the panel is
  shown. Accepted: the audiences that need a specific table get the whole
  file anyway.
- The tab state resets on reload, to the summary. That is the right default
  for the reader the summary exists for.
- Keyboard access rides on the radio group (arrow keys switch panels once
  focused); the inputs are parked off-viewport rather than `display: none`
  so they stay focusable.
- The byte-determinism test (ADR-0020) is unaffected: the tab wiring is a
  pure function of the panel list.
