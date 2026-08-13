/**
 * The static HTML report.
 *
 * One file, inline CSS, no script, no external reference of any kind — it opens
 * from a file share, survives being emailed, and renders with JavaScript
 * disabled (ADR-0020). Nothing in it is fetched when the reader opens it,
 * which matters for a tool whose pitch is that it never touches the network.
 *
 * The page is tabbed — a summary a decision-maker reads in two minutes, then
 * one tab per subject — and the tabs are CSS only: hidden radio inputs and
 * label siblings, so every guarantee above survives (ADR-0024). Without CSS
 * the panels render in order as one document, and that is also what printing
 * produces.
 *
 * Two rules govern the content. Every claim shows the row it came from, and
 * every piece of inference is visually distinct from every observation — in the
 * diagrams, in the prose, and in the legend that explains the difference.
 */

import type { RunSummary } from '../mcp/queries.js';
import { paletteFrom, type DiagramPalette, type ResolvedBrand } from './brand.js';
import type { C4Diagram, C4Model } from './c4.js';
import { classLayoutInput, type ClassDiagram } from './classes.js';
import { CARDINALITY_LABEL, erLayoutInput, type ErModel } from './erd.js';
import type { RankedFindings } from './findings.js';
import { layout, layoutGraph } from './layout.js';
import { toClassMermaid, toErMermaid, toMermaid } from './mermaid.js';
import { escapeAttr, escapeText, toSvg } from './svg.js';
import type { DependencyMatrix, HotspotChart, HttpSurface } from './surface.js';

export interface ReportContext {
  run: RunSummary;
  /** White-label branding, already resolved and contrast-checked (ADR-0025). */
  brand: ResolvedBrand | null;
  /** Extractor complaints, grouped. Part of "what this report did not see". */
  diagnostics: Array<{ level: string; extractor: string | null; count: number }>;
  /** Model output discarded by the citation check (ADR-0013). */
  rejectedByCitationCheck: number;
}

/** Everything the page renders. Assembled by the command; nothing derived here. */
export interface ReportData {
  model: C4Model;
  classes: ClassDiagram[];
  /** Package diagrams past the cap, counted rather than dropped. */
  classDiagramsSkipped: number;
  er: ErModel;
  surface: HttpSurface;
  matrix: DependencyMatrix;
  hotspots: HotspotChart;
  ranked: RankedFindings;
}

interface Panel {
  id: string;
  /** The word on the tab. */
  label: string;
  /** The heading at the top of the panel, kept for printing and no-CSS readers. */
  title: string;
  html: string;
}

export function toHtml(data: ReportData, context: ReportContext): string {
  const { run } = context;
  const repoName = run.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'repository';
  const title = `${repoName} — structure`;
  const palette = context.brand?.accent ? paletteFrom(context.brand.accent.light) : undefined;

  // Built as a list so the tab bar and the page cannot disagree about what is
  // on it. A panel whose section has nothing to say is omitted along with its
  // tab, rather than shipping an empty page.
  const panels: Panel[] = [
    panel('summary', 'Summary', 'Summary', summarySection(data, context)),
    panel(
      'findings',
      'Findings',
      'Findings, ranked',
      findingsSection(data.ranked, context.run.coverage.analysis),
    ),
    panel('architecture', 'Architecture', 'Architecture — C4 levels 1 to 3', architecturePanel(data, palette)),
    panel('code', 'Code', 'Code — one class diagram per package', codePanel(data, palette)),
    panel('data', 'Data model', 'Data model', erSection(data.er, palette)),
    panel('api', 'HTTP API', 'HTTP surface', apiSection(data.surface)),
    panel('coupling', 'Coupling', 'Dependency matrix and hotspots', couplingPanel(data)),
    panel('limits', 'Limits', 'What this report did not see', limitsSection(context, data)),
  ].filter((entry) => entry.html !== '');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(title)}</title>`,
    `<style>${STYLE}\n${themeStyle()}\n${themeSwitchStyle()}\n${tabStyle(panels)}${accentStyle(context.brand)}</style>`,
    '</head>',
    '<body>',
    // The scheme toggle: `:root:has()` reads these from anywhere, and a
    // browser without `:has()` keeps following the OS setting (ADR-0025).
    '<input type="radio" name="theme" class="tab-input" id="theme-auto" checked>',
    '<input type="radio" name="theme" class="tab-input" id="theme-light">',
    '<input type="radio" name="theme" class="tab-input" id="theme-dark">',
    // The tab machinery: one radio per panel, checked = visible. They sit
    // before everything else so a sibling selector can reach both the tab bar
    // and the panels. No script (ADR-0020, ADR-0024).
    ...panels.map(
      (entry, n) =>
        `<input type="radio" name="panel" class="tab-input" id="tab-${escapeAttr(entry.id)}"${
          n === 0 ? ' checked' : ''
        }>`,
    ),
    '<div class="page">',
    header(context),
    tabBar(panels),
    '<main>',
    cover(data, context),
    ...panels.map(
      (entry) =>
        `<section class="panel" id="panel-${escapeAttr(entry.id)}">\n` +
        `<h2 class="panel-title">${escapeText(entry.title)}</h2>\n${entry.html}\n</section>`,
    ),
    footer(run),
    '</main>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The scheme tokens, one map for both so light and dark cannot drift
 * (ADR-0025). Everything scheme-independent stays in the static stylesheet.
 */
const TOKENS: { light: Record<string, string>; dark: Record<string, string> } = {
  light: {
    '--bg': '#f9f9f7',
    '--panel': '#fcfcfb',
    '--line': '#e1e0d9',
    '--text': '#0b0b0b',
    '--muted': '#52514e',
    '--accent': '#2a78d6',
    '--inferred': '#9a6700',
  },
  dark: {
    '--bg': '#0d0d0d',
    '--panel': '#1a1a19',
    '--line': '#2c2c2a',
    '--text': '#ffffff',
    '--muted': '#c3c2b7',
    '--accent': '#3987e5',
    '--inferred': '#e3b341',
  },
};

function decls(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
}

/**
 * The three blocks that make a declaration pair follow the toggle:
 * light is the default; the OS may choose dark unless light is forced; dark
 * can be forced outright. A browser without `:has()` drops the forcing rules
 * and keeps the OS behaviour, which is what it has today (ADR-0025).
 */
function schemeCss(light: string, dark: string): string {
  return [
    `:root { ${light} }`,
    `@media (prefers-color-scheme: dark) { :root { ${dark} } ` +
      `:root:has(#theme-light:checked) { ${light} } }`,
    `:root:has(#theme-dark:checked) { ${dark} }`,
    // Paper is light. Printing the dark scheme wastes toner to say the same thing.
    `@media print { :root { ${light} } }`,
  ].join('\n');
}

function themeStyle(): string {
  return schemeCss(decls(TOKENS.light), decls(TOKENS.dark));
}

/** Which switch segment reads active — sibling selectors, no \`:has()\` needed. */
function themeSwitchStyle(): string {
  return ['auto', 'light', 'dark']
    .map(
      (scheme) =>
        `#theme-${scheme}:checked ~ .page .theme-switch label[for="theme-${scheme}"] ` +
        '{ background: var(--accent); color: #ffffff; }',
    )
    .join('\n');
}

/** The brand accent, applied as a token override so every use follows it. */
function accentStyle(brand: ResolvedBrand | null): string {
  if (brand === null || brand.accent === null) return '';
  return `\n${schemeCss(`--accent: ${brand.accent.light};`, `--accent: ${brand.accent.dark};`)}`;
}

/**
 * The stratigraph mark: three strata, reading top-down the way the tool reads
 * a codebase. Inline SVG so it costs no request and no bytes beyond these,
 * and drawn from `--accent` so a branded report's mark keeps to the brand.
 */
const STRATA_MARK =
  '<svg class="strata-mark" viewBox="0 0 24 24" width="22" height="22" ' +
  'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="4" y="4" width="16" height="4.5" rx="1.5" fill="var(--accent)"/>' +
  '<rect x="2" y="10" width="20" height="4.5" rx="1.5" fill="var(--accent)" opacity="0.62"/>' +
  '<rect x="6" y="16" width="12" height="4.5" rx="1.5" fill="var(--accent)" opacity="0.34"/>' +
  '</svg>';

/** Auto / light / dark, forced by CSS alone (ADR-0025). */
function themeSwitch(): string {
  return (
    '<span class="theme-switch" aria-label="Colour scheme">' +
    '<label for="theme-auto">Auto</label>' +
    '<label for="theme-light">Light</label>' +
    '<label for="theme-dark">Dark</label>' +
    '</span>'
  );
}

function panel(id: string, label: string, title: string, html: string): Panel {
  return { id, label, title, html };
}

function tabBar(panels: Panel[]): string {
  return [
    '<nav class="tabs" aria-label="Report sections">',
    ...panels.map(
      (entry) => `<label for="tab-${escapeAttr(entry.id)}">${escapeText(entry.label)}</label>`,
    ),
    '</nav>',
  ].join('\n');
}

/**
 * The `:checked` wiring, generated from the same list as the markup so the two
 * cannot drift. Static text in, static text out — determinism is untouched.
 */
function tabStyle(panels: Panel[]): string {
  return panels
    .map(
      (entry) =>
        `#tab-${entry.id}:checked ~ .page #panel-${entry.id} { display: block; }\n` +
        `#tab-${entry.id}:checked ~ .page .tabs label[for="tab-${entry.id}"] { ` +
        'color: var(--text); border-bottom-color: var(--accent); }',
    )
    .join('\n');
}

function header(context: ReportContext): string {
  const { run } = context;
  // The name, not the path: /home/ci/builds/acme-monolith is where the clone
  // happened to sit, and it dominates the page if the h1 carries it. The full
  // path stays on the summary, where provenance belongs — as does the full
  // commit sha, which the header shows the first twelve characters of.
  const repoName = run.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? run.repoPath;
  const head = run.repoHead;
  const brand = context.brand;
  const brandMark =
    brand === null || (brand.logo === null && brand.name === null)
      ? ''
      : '<span class="brand-co">' +
        (brand.logo === null
          ? ''
          : `<img class="brand-logo" src="${escapeAttr(brand.logo)}" alt="${escapeAttr(
              brand.name ?? 'logo',
            )}">`) +
        (brand.name === null ? '' : `<span>${escapeText(brand.name)}</span>`) +
        '</span>';
  return [
    '<header>',
    `<div class="brand-row"><p class="brand">${STRATA_MARK}<span>stratigraph</span></p>` +
      `${brandMark}${themeSwitch()}</div>`,
    `<h1>${escapeText(repoName)}</h1>`,
    '<p class="subtitle">Architecture &amp; structure report</p>',
    '<p class="run-line">' +
      (head === null
        ? '<span class="meta-item">commit not recorded</span>'
        : `<span class="meta-item">commit <code title="${escapeAttr(head)}">` +
          `${escapeText(head.slice(0, 12))}</code></span>`) +
      `<span class="meta-item">${escapeText(run.startedAt)}</span>` +
      `<span class="meta-item">run ${run.runId}</span>` +
      `<span class="meta-item">stratigraph v${escapeText(run.toolVersion)}</span>` +
      '</p>',
    '</header>',
  ].join('\n');
}

// ----------------------------------------------------------------- summary

/**
 * The page a reader who will not read the rest still gets value from.
 *
 * Everything here is a projection of what the other panels already show —
 * the first rows of lists other panels carry in full. Nothing is derived,
 * nothing is exclusive to this panel, and every number agrees with the panel
 * it points at because it is computed from the same object.
 */
/** The count tiles — the summary's and the print cover's, from one function. */
function tilesHtml(data: ReportData, context: ReportContext): string {
  const counts = context.run.counts;
  const publishable = data.ranked.total - data.ranked.uncited;
  const high = data.ranked.bySeverity.find((row) => row.severity === 'high')?.count ?? 0;
  return [
    // The numbers a reader wants before they decide whether to read the rest.
    '<ul class="tiles">',
    tile(counts.packages, 'packages'),
    tile(counts.types, 'types'),
    tile(counts.endpoints, 'endpoints'),
    tile(counts.tables, 'tables'),
    tile(counts.commits, 'commits'),
    tile(publishable, 'findings', high > 0 ? `${high} high` : null),
    '</ul>',
  ].join('\n');
}

/**
 * The printed document's first page. Hidden on screen — there the summary is
 * the cover — and assembled from the same objects, deriving nothing.
 */
function cover(data: ReportData, context: ReportContext): string {
  const { run } = context;
  const repoName = run.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? run.repoPath;
  const brand = context.brand;
  return [
    '<section class="cover">',
    `<p class="brand">${STRATA_MARK}<span>stratigraph</span></p>`,
    brand?.name ? `<p class="cover-for">Prepared for ${escapeText(brand.name)}</p>` : '',
    `<h1>${escapeText(repoName)}</h1>`,
    '<p class="subtitle">Architecture &amp; structure report</p>',
    '<dl class="meta">',
    row('Commit', run.repoHead ?? 'not recorded'),
    row('Generated', run.startedAt),
    row('Tool', `stratigraph ${run.toolVersion}`),
    '</dl>',
    tilesHtml(data, context),
    '</section>',
  ].filter((line) => line !== '').join('\n');
}

function summarySection(data: ReportData, context: ReportContext): string {
  const { run } = context;
  const publishable = data.ranked.total - data.ranked.uncited;

  const parts: string[] = [
    '<p class="lead">Everything in this report was read from the source at the commit ' +
      'above, or from that commit&rsquo;s history. Anything a model wrote is marked as ' +
      'inference. Every claim carries the file and line, commit or fact row it came from.</p>',
    '<dl class="meta">',
    row('Repository', run.repoPath),
    row('Commit', run.repoHead ?? 'not recorded'),
    row('Extractors', run.extractors.join(', ') || 'none'),
    row('Languages', run.languages.join(', ') || 'none'),
    '</dl>',
    tilesHtml(data, context),
  ];

  if (data.ranked.findings.length > 0) {
    parts.push(
      '<h3>Leading findings</h3>',
      `<p class="caption">The first ${Math.min(5, data.ranked.findings.length)} of ` +
        `${publishable} — the Findings tab has all of them, each with its evidence.</p>`,
      '<ol class="summary-findings">',
      ...data.ranked.findings.slice(0, 5).map((finding) => {
        const model = finding.authoredBy === 'model';
        return (
          `<li class="sev-${escapeAttr(finding.severity)}">` +
          `<span class="tag sev">${escapeText(finding.severity)}</span>` +
          `<span class="summary-finding-title${model ? ' model-text' : ''}">` +
          `${escapeText(finding.title)}</span>` +
          '</li>'
        );
      }),
      '</ol>',
    );
  }

  if (data.hotspots.bars.length > 0) {
    parts.push(
      '<h3>Hottest files</h3>',
      `<p class="caption">Churn &times; complexity, the first ` +
        `${Math.min(5, data.hotspots.bars.length)} of ${data.hotspots.total} with ` +
        'history — the Coupling tab has the full table.</p>',
      '<table class="hotspots">',
      '<tbody>',
      ...data.hotspots.bars.slice(0, 5).map((bar) =>
        [
          '<tr>',
          `<td><code>${escapeText(bar.path)}</code></td>`,
          `<td class="bar-cell"><span class="bar" style="width:${(bar.relative * 100).toFixed(1)}%">` +
            `</span><span class="bar-value">${Math.round(bar.score).toLocaleString('en-US')}</span></td>`,
          '</tr>',
        ].join(''),
      ),
      '</tbody>',
      '</table>',
    );
  }

  parts.push(legend());
  return parts.join('\n');
}

// ---------------------------------------------------- panels that aggregate

function architecturePanel(data: ReportData, palette: DiagramPalette | undefined): string {
  return [
    subheading('Level 1 — system context'),
    diagramSection(data.model.context, 'context', palette),
    subheading('Level 2 — containers'),
    diagramSection(data.model.container, 'container', palette),
    ...data.model.components.flatMap((diagram, n) => [
      subheading(`Level 3 — components of ${diagram.scope ?? ''}`),
      diagramSection(diagram, `component-${n}`, palette),
    ]),
  ].join('\n');
}

function codePanel(data: ReportData, palette: DiagramPalette | undefined): string {
  if (data.classes.length === 0) return '';
  return data.classes
    .flatMap((diagram, n) => [
      subheading(`Level 4 — code in ${diagram.packageFqn}`),
      classSection(diagram, `code-${n}`, palette),
    ])
    .join('\n');
}

function couplingPanel(data: ReportData): string {
  const matrix = matrixSection(data.matrix);
  const hotspots = hotspotSection(data.hotspots);
  if (matrix === '' && hotspots === '') return '';
  const parts: string[] = [];
  if (matrix !== '') parts.push(subheading('Dependency matrix'), matrix);
  if (hotspots !== '') parts.push(subheading('Hotspots'), hotspots);
  return parts.join('\n');
}

function subheading(title: string): string {
  return `<h3 class="subheading">${escapeText(title)}</h3>`;
}

function tile(value: number, label: string, detail: string | null = null): string {
  return (
    `<li><span class="tile-value">${value}</span>` +
    `<span class="tile-label">${escapeText(label)}</span>` +
    (detail === null ? '' : `<span class="tile-detail">${escapeText(detail)}</span>`) +
    '</li>'
  );
}

function row(label: string, value: string): string {
  return `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`;
}

function legend(): string {
  return [
    '<section class="legend">',
    '<h3>How to read this</h3>',
    '<ul>',
    '<li><span class="swatch observed"></span><strong>Solid line, solid border</strong> — ' +
      'observed. A parser read it out of the source, and the evidence names the file and line.</li>',
    '<li><span class="swatch inferred"></span><strong>Dashed and amber</strong> — ' +
      'inferred. Derived by matching strings, not by reading a declaration ' +
      '(ADR&#8209;0018). Open the cited line before relying on one.</li>',
    '<li><span class="swatch routed"></span><strong>Dotted, routed under the diagram</strong> — ' +
      'a dependency that runs backwards or sideways. Every one of these is a cycle ' +
      'or a sibling dependency.</li>',
    '<li><strong>Italic amber text</strong> — written by a language model over the ' +
      'structure, and checked against the evidence it was shown (ADR&#8209;0013). ' +
      'It is a description, never a fact.</li>',
    '</ul>',
    '<p>No box on any diagram was invented to make it look like a C4 diagram. Where ' +
      'the facts supply nothing, the diagram says so instead of drawing something ' +
      'plausible (ADR&#8209;0019).</p>',
    '</section>',
  ].join('\n');
}

function diagramSection(diagram: C4Diagram, id: string, palette?: DiagramPalette): string {
  const placed = layout(diagram);
  const parts = [`<p class="caption">${escapeText(diagram.title)}</p>`];

  if (placed.boxes.length === 0) {
    parts.push('<p class="empty">Nothing to draw at this level for this run.</p>');
  } else {
    parts.push('<figure>', toSvg(placed, id, palette), '</figure>');
  }

  parts.push(notes([...diagram.notes, ...placed.notes]));

  if (diagram.relationships.length > 0) {
    parts.push(relationshipTable(diagram));
  }

  parts.push(mermaidDetails(toMermaid(diagram)));
  return parts.join('\n');
}

function notes(lines: string[]): string {
  if (lines.length === 0) return '';
  return [
    '<ul class="notes">',
    ...lines.map((note) => `<li>${escapeText(note)}</li>`),
    '</ul>',
  ].join('\n');
}

function mermaidDetails(source: string): string {
  return [
    '<details>',
    '<summary>Mermaid source</summary>',
    `<pre><code>${escapeText(source)}</code></pre>`,
    '</details>',
  ].join('\n');
}

// ------------------------------------------------------------ level 4: code

function classSection(diagram: ClassDiagram, id: string, palette?: DiagramPalette): string {
  const { nodes, links } = classLayoutInput(diagram);
  const placed = layoutGraph(nodes, links);
  const parts = [
    `<p class="caption">${escapeText(
      `${diagram.classes.length} type(s) declared in ${diagram.packageFqn}, with their members ` +
        `as the source declares them.`,
    )}</p>`,
    '<figure>',
    toSvg(placed, id, palette),
    '</figure>',
    notes([...diagram.notes, ...placed.notes]),
  ];

  if (diagram.links.length > 0) {
    const names = new Map(diagram.classes.map((box) => [box.id, box.name]));
    parts.push(
      '<table>',
      '<caption>Every relationship between these types, and where it was declared.</caption>',
      '<thead><tr><th>Type</th><th>Relationship</th><th>Target</th><th>Via</th>' +
        '<th>Declared at</th></tr></thead>',
      '<tbody>',
      ...diagram.links.map((link) =>
        [
          '<tr>',
          `<td>${escapeText(names.get(link.from) ?? link.from)}</td>`,
          `<td>${escapeText(link.kind)}</td>`,
          `<td>${escapeText(names.get(link.to) ?? link.toFqn)}` +
            `${link.external ? ' <span class="tag">outside this package</span>' : ''}</td>`,
          `<td>${escapeText(link.via ?? '—')}</td>`,
          `<td>${location(link.path, link.line)}</td>`,
          '</tr>',
        ].join(''),
      ),
      '</tbody>',
      '</table>',
    );
  }

  parts.push(mermaidDetails(toClassMermaid(diagram)));
  return parts.join('\n');
}

// ------------------------------------------------------------- data model

function erSection(model: ErModel, palette?: DiagramPalette): string {
  if (model.entities.length === 0) {
    return `<p class="empty">No O/R mapping was read in this run.</p>\n${notes(model.notes)}`;
  }

  const { nodes, links } = erLayoutInput(model);
  const placed = layoutGraph(nodes, links);
  const parts = [
    `<p class="caption">${escapeText(
      `${model.entities.length} table(s) declared by an O/R mapping, and the ` +
        `${model.relationships.length} relationship(s) between them that could be read.`,
    )}</p>`,
    '<figure>',
    toSvg(placed, 'er', palette),
    '</figure>',
    notes([...model.notes, ...placed.notes]),
  ];

  parts.push(
    '<table>',
    '<caption>Every column, and the field it was read from.</caption>',
    '<thead><tr><th>Table</th><th>Column</th><th>Type</th><th>Key</th><th>From</th>' +
      '<th>Declared at</th></tr></thead>',
    '<tbody>',
    ...model.entities.flatMap((entity) =>
      entity.columns.map((column) =>
        [
          '<tr>',
          `<td>${escapeText(entity.table)}</td>`,
          `<td>${escapeText(column.name)}</td>`,
          `<td>${escapeText(column.type)}</td>`,
          `<td>${column.primaryKey ? '<span class="tag">PK</span>' : ''}</td>`,
          `<td>${escapeText(column.field)}` +
            `${column.inherited ? ' <span class="tag">inherited</span>' : ''}</td>`,
          `<td>${location(column.path, column.line)}</td>`,
          '</tr>',
        ].join(''),
      ),
    ),
    '</tbody>',
    '</table>',
  );

  if (model.relationships.length > 0) {
    parts.push(
      '<table>',
      '<caption>Relationships, with the field that declares each one.</caption>',
      '<thead><tr><th>From</th><th>To</th><th>Cardinality</th><th>Via</th>' +
        '<th>Declared at</th></tr></thead>',
      '<tbody>',
      ...model.relationships.map((relationship) =>
        [
          '<tr>',
          `<td>${escapeText(relationship.fromTable)}</td>`,
          `<td>${escapeText(relationship.toTable)}</td>`,
          `<td>${escapeText(CARDINALITY_LABEL[relationship.cardinality])}</td>`,
          `<td>${escapeText(relationship.via)}</td>`,
          `<td>${location(relationship.path, relationship.line)}</td>`,
          '</tr>',
        ].join(''),
      ),
      '</tbody>',
      '</table>',
    );
  }

  if (model.unreadable.length > 0) {
    // The refusal, on the page rather than in a footnote: an ER diagram missing
    // three of its four lines has to say so, or it reads as a schema that has
    // three fewer relationships than it does.
    parts.push(
      '<table>',
      '<caption>Associations that were declared but could not be drawn. Each one is a ' +
        'real relationship in the schema whose target this run could not read.</caption>',
      '<thead><tr><th>From</th><th>Via</th><th>Cardinality</th><th>Why not drawn</th>' +
        '<th>Declared at</th></tr></thead>',
      '<tbody>',
      ...model.unreadable.map((association) =>
        [
          '<tr class="inferred">',
          `<td>${escapeText(association.fromTable)}</td>`,
          `<td>${escapeText(association.via)}</td>`,
          `<td>${escapeText(CARDINALITY_LABEL[association.cardinality])}</td>`,
          `<td>${escapeText(association.reason)}</td>`,
          `<td>${location(association.path, association.line)}</td>`,
          '</tr>',
        ].join(''),
      ),
      '</tbody>',
      '</table>',
    );
  }

  parts.push(mermaidDetails(toErMermaid(model)));
  return parts.join('\n');
}

// ------------------------------------------------------------ HTTP surface

function apiSection(surface: HttpSurface): string {
  if (surface.endpoints.length === 0) {
    return `<p class="empty">No HTTP endpoint was read in this run.</p>\n${notes(surface.notes)}`;
  }

  return [
    `<p class="caption">${escapeText(
      `${surface.endpoints.length} endpoint(s), each with the method recorded as serving it.`,
    )}</p>`,
    '<table class="api">',
    '<thead><tr><th>Method</th><th>Path</th><th>Handled by</th><th>Declared at</th></tr></thead>',
    '<tbody>',
    ...surface.endpoints.map((endpoint) =>
      [
        '<tr>',
        `<td><span class="verb verb-${escapeAttr(endpoint.method.toLowerCase())}">` +
          `${escapeText(endpoint.method)}</span></td>`,
        `<td><code>${escapeText(endpoint.path)}</code></td>`,
        `<td>${
          endpoint.handler === null
            ? '<span class="empty">nothing recorded</span>'
            : escapeText(endpoint.handler)
        }</td>`,
        `<td>${location(endpoint.file, endpoint.line)}</td>`,
        '</tr>',
      ].join(''),
    ),
    '</tbody>',
    '</table>',
    notes(surface.notes),
  ].join('\n');
}

// ------------------------------------------------------- dependency matrix

function matrixSection(matrix: DependencyMatrix): string {
  if (matrix.packages.length < 2) return '';

  const header = matrix.packages
    .map(
      (_, n) => `<th class="num" title="${escapeAttr(matrix.packages[n] as string)}">${n + 1}</th>`,
    )
    .join('');

  const rows = matrix.packages.map((name, row) => {
    const cells = (matrix.cells[row] as number[])
      .map((value, column) => {
        if (row === column) return '<td class="diagonal"></td>';
        if (value === 0) return '<td class="num zero">·</td>';
        const mutual = (matrix.cells[column] as number[])[row] !== 0;
        return `<td class="num${mutual ? ' mutual' : ''}">${value}</td>`;
      })
      .join('');
    return `<tr><th class="rowhead">${row + 1} ${escapeText(name)}</th>${cells}</tr>`;
  });

  return [
    '<div class="scroller">',
    '<table class="matrix">',
    '<caption>Rows depend on columns. A cell shaded on both sides of the diagonal is a cycle.</caption>',
    `<thead><tr><th></th>${header}</tr></thead>`,
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
    '</div>',
    notes(matrix.notes),
  ].join('\n');
}

// ---------------------------------------------------------------- hotspots

function hotspotSection(chart: HotspotChart): string {
  if (chart.bars.length === 0) return '';

  return [
    `<p class="caption">${escapeText(
      `The ${chart.bars.length} files with the highest churn x complexity, of ${chart.total} with history.`,
    )}</p>`,
    '<table class="hotspots">',
    '<thead><tr><th>File</th><th class="num">Commits</th><th class="num">Churn</th>' +
      '<th>Score</th><th class="num">Authors</th><th class="num">Top author</th></tr></thead>',
    '<tbody>',
    ...chart.bars.map((bar) =>
      [
        '<tr>',
        `<td><code>${escapeText(bar.path)}</code></td>`,
        `<td class="num">${bar.commits}</td>`,
        `<td class="num">${bar.churn}</td>`,
        // A bar rather than a number: the ratio between the first row and the
        // tenth is the thing a list of integers hides.
        `<td class="bar-cell"><span class="bar" style="width:${(bar.relative * 100).toFixed(1)}%">` +
          `</span><span class="bar-value">${Math.round(bar.score).toLocaleString('en-US')}</span></td>`,
        `<td class="num">${bar.authors}</td>`,
        `<td class="num">${Math.round(bar.topAuthorShare * 100)}%</td>`,
        '</tr>',
      ].join(''),
    ),
    '</tbody>',
    '</table>',
    notes(chart.notes),
  ].join('\n');
}

/** `path:line` as a code span, or an honest dash. */
function location(path: string | null, line: number | null): string {
  if (path === null) return '<span class="empty">—</span>';
  return `<code>${escapeText(path)}${line === null ? '' : `:${line}`}</code>`;
}

/** Every line on the diagram, with the rows behind it. This is the citation half. */
function relationshipTable(diagram: C4Diagram): string {
  const names = new Map(diagram.elements.map((element) => [element.id, element.name]));
  const rows = diagram.relationships.map((relationship) => {
    const inferred = relationship.confidence === 'inferred';
    return [
      `<tr${inferred ? ' class="inferred"' : ''}>`,
      `<td>${escapeText(names.get(relationship.from) ?? relationship.from)}</td>`,
      `<td>${escapeText(names.get(relationship.to) ?? relationship.to)}</td>`,
      `<td>${escapeText(relationship.label)}</td>`,
      `<td class="num">${relationship.count}</td>`,
      `<td>${inferred ? '<span class="tag inferred-tag">inferred</span>' : 'observed'}</td>`,
      `<td>${evidenceList(relationship.evidence)}</td>`,
      '</tr>',
    ].join('');
  });

  return [
    '<table class="wide">',
    '<caption>Every relationship on this diagram, and the rows it came from.</caption>',
    '<thead><tr><th>From</th><th>To</th><th>Via</th><th class="num">Refs</th>' +
      '<th>Confidence</th><th>Evidence</th></tr></thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
  ].join('\n');
}

/**
 * Both evidence shapes render the same way, so this takes the part they share
 * rather than the union — a C4 element cites a run, a finding cites a commit,
 * and neither distinction changes a single character of the output.
 */
function evidenceList(
  evidence: ReadonlyArray<{ label: string; path: string | null; line: number | null }>,
): string {
  if (evidence.length === 0) return '<span class="empty">none recorded</span>';
  return [
    '<ul class="evidence">',
    ...evidence.map((item) => {
      const where =
        item.path === null
          ? ''
          : ` <code>${escapeText(item.path)}${item.line === null ? '' : `:${item.line}`}</code>`;
      return `<li>${escapeText(item.label)}${where}</li>`;
    }),
    '</ul>',
  ].join('');
}

function findingsSection(ranked: RankedFindings, analysisStored: boolean): string {
  const parts: string[] = [];

  if (ranked.total === 0) {
    // Two different kinds of empty, and the difference is the whole point: one
    // says the rules found nothing, the other says no rule ran (ADR-0021).
    return analysisStored
      ? '<p class="empty">No findings for this run. That means every rule that ran found ' +
          'nothing &mdash; not that nothing was looked at; the limits below say which ' +
          'rules could run.</p>'
      : '<p class="empty"><strong>No rule has been evaluated against this run.</strong> ' +
          'No analysis output is stored for it &mdash; no cluster, no finding, no coupled ' +
          'pair &mdash; so this is an absence of analysis, not a clean result. Run ' +
          '<code>stratigraph analyze</code> and generate the report again.</p>';
  }

  const publishable = ranked.total - ranked.uncited;
  parts.push(
    '<p class="caption">' +
      escapeText(
        `${publishable} finding(s): ${ranked.bySeverity
          .map((row) => `${row.count} ${row.severity}`)
          .join(', ')}. Ranked by severity, then observation before inference, ` +
          `then how much evidence there is (ADR-0021).`,
      ) +
      '</p>',
  );

  if (ranked.uncited > 0) {
    parts.push(
      `<p class="warn">${ranked.uncited} finding(s) carry no citation and are not ` +
        'listed. A finding that cannot point at the row it came from is not ' +
        'publishable.</p>',
    );
  }

  parts.push('<ol class="findings">');
  for (const finding of ranked.findings) {
    const model = finding.authoredBy === 'model';
    parts.push(
      `<li class="finding sev-${escapeAttr(finding.severity)}${model ? ' model' : ''}">`,
      `<h3>${escapeText(finding.title)}</h3>`,
      '<p class="tags">',
      `<span class="tag sev">${escapeText(finding.severity)}</span>`,
      `<span class="tag">${escapeText(finding.ruleTitle)}</span>`,
      model
        ? `<span class="tag inferred-tag">written by ${escapeText(
            finding.model ?? 'a model',
          )} &mdash; inference</span>`
        : '<span class="tag">derived from parsed facts</span>',
      '</p>',
    );
    if (finding.detail !== null && finding.detail.trim() !== '') {
      parts.push(`<pre class="detail">${escapeText(finding.detail)}</pre>`);
    }
    if (finding.evidence.length > 0) {
      parts.push('<p class="evidence-label">Evidence</p>', evidenceList(finding.evidence));
    }
    parts.push('</li>');
  }
  parts.push('</ol>');

  if (ranked.findings.length < publishable) {
    parts.push(
      `<p class="caption">Showing ${ranked.findings.length} of ${publishable} ` +
        '&mdash; raise <code>--top</code> for more.</p>',
    );
  }

  return parts.join('\n');
}

/**
 * What this report did not look at.
 *
 * On the page, not in a footnote. A report a reader is expected to act on has
 * to state its own blind spots, or its silences read as absences.
 */
function limitsSection(context: ReportContext, data: ReportData): string {
  const parts = ['<ul class="notes">'];

  for (const gap of context.run.gaps) parts.push(`<li>${escapeText(gap)}</li>`);
  for (const note of context.brand?.notes ?? []) parts.push(`<li>${escapeText(note)}</li>`);

  if (data.classDiagramsSkipped > 0) {
    parts.push(
      `<li>${data.classDiagramsSkipped} package(s) have no class diagram here — the ` +
        'ones declaring the fewest types. Raise <code>--top</code> to include them.</li>',
    );
  }
  if (data.er.unreadable.length > 0) {
    parts.push(
      `<li>${data.er.unreadable.length} declared entity association(s) have a target ` +
        'this run could not read, and are listed in the data model rather than drawn.</li>',
    );
  }
  if (data.surface.unhandled > 0) {
    parts.push(
      `<li>${data.surface.unhandled} endpoint(s) have no handler recorded — the route was ` +
        'readable, the method serving it was not.</li>',
    );
  }

  for (const diagnostic of context.diagnostics) {
    parts.push(
      `<li>${diagnostic.count} <code>${escapeText(diagnostic.level)}</code> diagnostic(s) ` +
        `from the ${escapeText(diagnostic.extractor ?? 'unknown')} extractor &mdash; ` +
        'source it could not read, or a type it refused to guess at.</li>',
    );
  }

  if (context.rejectedByCitationCheck > 0) {
    parts.push(
      `<li>${context.rejectedByCitationCheck} piece(s) of model output failed the ` +
        'citation check and were discarded rather than shown (ADR&#8209;0013).</li>',
    );
  }

  if (!context.run.coverage.interpretation) {
    parts.push(
      '<li>No model ran for this run, so nothing here is named or described by one. ' +
        'Everything above is structural.</li>',
    );
  }

  parts.push(
    '<li>Nothing outside this source tree was examined. Configuration, ' +
      'infrastructure, runtime wiring and anything resolved by reflection are ' +
      'invisible to a parser and absent from every diagram above.</li>',
    '</ul>',
  );
  return parts.join('\n');
}

function footer(run: RunSummary): string {
  return [
    '<footer>',
    `<p>Generated by stratigraph ${escapeText(run.toolVersion)} from run ${run.runId}. ` +
      'Regenerating from the same run produces the same bytes.</p>',
    '</footer>',
  ].join('\n');
}

/**
 * The stylesheet.
 *
 * Light by default — this page is read in meetings, attached to emails and
 * printed, and those are light-surface contexts — with a dark override under
 * `prefers-color-scheme`. The diagrams are the one exception: their colours
 * are chosen against a dark surface (ADR-0020), so a figure keeps that
 * surface in both schemes rather than inverting badly.
 *
 * The colour values are a validated palette: the categorical, status and ink
 * steps pass a colour-vision-deficiency and contrast check as a set, in both
 * modes, and severity is never carried by colour alone — every severity mark
 * sits next to the word.
 */
const STYLE = `
/* Scheme-independent tokens. The light/dark pairs are generated beside this
   sheet from one map, so the two schemes cannot drift (ADR-0025). */
:root {
  --faint: #898781; --warn: #d03b3b; --serious: #ec835a; --caution: #fab219;
  --diagram-bg: #ffffff;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 64px; }
h1 { font-size: 26px; font-weight: 650; margin: 2px 0 10px; word-break: break-all; letter-spacing: -0.01em; }
h2.panel-title { font-size: 21px; font-weight: 650; margin: 4px 0 16px; letter-spacing: -0.01em; }
h3 { font-size: 16px; font-weight: 650; margin: 28px 0 8px; word-break: break-word; }
h3.subheading { font-size: 17px; margin: 36px 0 8px; padding-bottom: 6px;
                border-bottom: 1px solid var(--line); }
p { margin: 8px 0; }
code, pre { font-family: var(--mono); font-size: 12.5px; }
a { color: var(--accent); }

/* ------------------------------------------------------------ header */
header { padding: 18px 0 4px; }
.brand-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
header .brand { display: inline-flex; align-items: center; gap: 8px; }
.strata-mark { display: block; }
.brand-co { display: flex; align-items: center; gap: 10px; color: var(--muted);
            font-size: 13.5px; font-weight: 600; margin-left: auto; }
.brand-logo { height: 28px; max-width: 180px; object-fit: contain; display: block; }
.theme-switch { display: inline-flex; border: 1px solid var(--line); border-radius: 999px;
                overflow: hidden; background: var(--panel); }
.theme-switch label { padding: 3px 12px; font-size: 12px; font-weight: 600;
                      color: var(--muted); cursor: pointer; }
.theme-switch label:hover { color: var(--text); }
header .brand { margin: 0 0 14px; font-size: 12px; font-weight: 650; letter-spacing: 0.16em;
                text-transform: uppercase; color: var(--accent);
                border-top: 3px solid var(--accent); display: inline-block; padding-top: 8px; }
header .subtitle { margin: -6px 0 10px; font-size: 15px; color: var(--muted); }
.run-line { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.meta-item { display: inline-block; margin: 2px 22px 2px 0; }
.meta-item code { font-size: 12px; }

/* -------------------------------------------------------------- tabs */
/* Radio-input tabs: no script, printable, and without CSS the panels
   simply render in order as one document (ADR-0024). The inputs stay
   focusable so the keyboard can drive the tabs (arrow keys within the
   radio group), parked off-viewport rather than display:none. */
.tab-input { position: fixed; top: -100px; left: -100px; opacity: 0; pointer-events: none; }
.tabs { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap;
        gap: 2px; margin: 14px 0 22px; background: var(--bg);
        border-bottom: 1px solid var(--line); }
.tabs label { padding: 9px 14px 7px; cursor: pointer; color: var(--muted);
              font-size: 13.5px; font-weight: 600; border-bottom: 2px solid transparent;
              margin-bottom: -1px; white-space: nowrap; }
.tabs label:hover { color: var(--text); }
.panel { display: none; }

.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 16px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; word-break: break-word; }
.lead { color: var(--muted); max-width: 72ch; }

/* The numbers a reader wants before deciding whether to read the rest. */
.tiles { list-style: none; display: flex; flex-wrap: wrap; gap: 12px; padding: 0; margin: 20px 0 28px; }
.tiles li { flex: 1 1 120px; background: var(--panel); border: 1px solid var(--line);
            border-top: 3px solid var(--accent); border-radius: 10px; padding: 14px 16px;
            display: flex; flex-direction: column;
            box-shadow: 0 1px 2px rgba(11, 11, 11, 0.04); }
.tile-value { font-size: 28px; font-weight: 650; line-height: 1.25; }
.tile-label { color: var(--muted); font-size: 12.5px; }
.tile-detail { color: var(--warn); font-size: 12px; font-weight: 600; margin-top: 2px; }

/* ------------------------------------------------------------ summary */
.summary-findings { list-style: none; padding: 0; margin: 8px 0; }
.summary-findings li { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px;
                       border: 1px solid var(--line); border-left-width: 4px;
                       border-radius: 8px; margin: 6px 0; background: var(--panel); }
.summary-findings li.sev-high { border-left-color: var(--warn); }
.summary-findings li.sev-medium { border-left-color: var(--serious); }
.summary-findings li.sev-low { border-left-color: var(--caution); }
.summary-findings li.sev-info { border-left-color: var(--line); }
.summary-finding-title { overflow-wrap: anywhere; }
.model-text { font-style: italic; color: var(--inferred); }

.legend { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 4px 20px 16px; margin-top: 28px; }
.legend h3 { margin-top: 14px; }
.legend ul { list-style: none; padding: 0; }
.legend li { margin: 10px 0; }
.swatch { display: inline-block; width: 26px; height: 0; border-top: 2px solid var(--faint); vertical-align: middle; margin-right: 10px; }
.swatch.inferred { border-top: 2px dashed var(--inferred); }
.swatch.routed { border-top: 2px dotted var(--faint); }

/* Diagram colours are tuned for a light surface (ADR-0024), so the figure
   card stays white in both schemes — and an SVG copied out of the page into
   a wiki or an email lands on the surface it was drawn for. */
figure { margin: 16px 0; padding: 14px; background: var(--diagram-bg);
         border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
svg.diagram { display: block; max-width: 100%; height: auto; margin: 0 auto; }

.caption { color: var(--muted); font-size: 13.5px; }
.empty { color: var(--faint); font-style: italic; }
.warn { color: var(--warn); }

.notes { color: var(--muted); font-size: 13.5px; padding-left: 20px; }
.notes li { margin: 6px 0; }

table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
caption { text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line);
         overflow-wrap: anywhere; }
/* Headers are single words; breaking "Confidence" into "Confidenc e" to save
   a wrap is worse than letting the word wrap whole. */
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase;
     letter-spacing: 0.03em; overflow-wrap: normal; }
/* A numeric column is narrow, and left to itself the browser breaks "Commits"
   across two lines rather than widening it by six pixels. */
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
th.num { white-space: nowrap; }
tbody tr:hover td { background: rgba(42, 120, 214, 0.05); }
tr.inferred td { background: rgba(154, 103, 0, 0.06); }

/* The relationship tables only. Left to the browser, its column sizing gives
   the three fqn columns everything and crushes the evidence into a
   two-word-wide ribbon — and the evidence is the half of that table that
   justifies the other half. Every other table is better off with auto. */
table.wide { table-layout: fixed; }
table.wide th:nth-child(1), table.wide td:nth-child(1) { width: 16%; }
table.wide th:nth-child(2), table.wide td:nth-child(2) { width: 16%; }
table.wide th:nth-child(3), table.wide td:nth-child(3) { width: 9%; }
table.wide th:nth-child(4), table.wide td:nth-child(4) { width: 5%; }
table.wide th:nth-child(5), table.wide td:nth-child(5) { width: 9%; }
table.wide th:nth-child(6), table.wide td:nth-child(6) { width: 45%; }
/* A path is one long token; let it wrap rather than widen its column. */
td code { overflow-wrap: anywhere; }

.evidence { list-style: none; margin: 0; padding: 0; }
.evidence li { margin: 2px 0; color: var(--muted); word-break: break-word; }
.evidence code { color: var(--accent); }
.evidence-label { color: var(--muted); font-size: 13px; margin: 12px 0 4px; }

.tag { display: inline-block; padding: 1px 8px; margin-right: 6px; border: 1px solid var(--line);
       border-radius: 999px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.tag.sev { text-transform: uppercase; letter-spacing: 0.04em; font-weight: 650; font-size: 11px; }
/* Severity is a word in a tinted badge — the colour never carries it alone. */
.sev-high .tag.sev { background: rgba(208, 59, 59, 0.12); border-color: transparent; color: #b32d2d; }
.sev-medium .tag.sev { background: rgba(236, 131, 90, 0.16); border-color: transparent; color: #a2511f; }
.sev-low .tag.sev { background: rgba(250, 178, 25, 0.18); border-color: transparent; color: #7a5800; }
.sev-info .tag.sev { background: var(--line); border-color: transparent; }
@media (prefers-color-scheme: dark) {
  .sev-high .tag.sev { color: #ef8f8f; }
  .sev-medium .tag.sev { color: #f0a175; }
  .sev-low .tag.sev { color: #fab219; }
}
.inferred-tag { color: var(--inferred); border-color: var(--inferred); font-style: italic; }

.findings { list-style: none; padding: 0; counter-reset: finding; }
.finding { counter-increment: finding; position: relative; background: var(--panel);
           border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px;
           padding: 16px 20px; margin: 12px 0; box-shadow: 0 1px 2px rgba(11, 11, 11, 0.04); }
.finding h3 { margin-top: 0; }
.finding h3::before { content: counter(finding) ". "; color: var(--faint); }
.finding.sev-high { border-left-color: var(--warn); }
.finding.sev-medium { border-left-color: var(--serious); }
.finding.sev-low { border-left-color: var(--caution); }
.finding.sev-info { border-left-color: var(--line); }
.finding.model h3 { font-style: italic; color: var(--inferred); }
.detail { white-space: pre-wrap; color: var(--muted); margin: 8px 0; overflow-x: auto; }

/* The API surface, the matrix and the hotspots each want their own column
   proportions, so they opt out of the six-column grid the relationship tables
   are sized for. */
.verb { display: inline-block; min-width: 56px; text-align: center; padding: 1px 6px;
        border-radius: 4px; font-family: var(--mono); font-size: 11.5px; font-weight: 600;
        background: var(--faint); color: #ffffff; white-space: nowrap; overflow-wrap: normal; }
.verb-get { background: #2a78d6; }
.verb-post { background: #008300; }
.verb-put, .verb-patch { background: #9a6700; }
.verb-delete { background: #d03b3b; }

.scroller { overflow-x: auto; }
table.matrix { font-size: 12px; width: auto; }
table.matrix th.rowhead { font-family: var(--mono); font-weight: 500; white-space: nowrap;
                          text-align: left; color: var(--text); text-transform: none;
                          letter-spacing: 0; font-size: 12px; }
table.matrix td { text-align: right; padding: 4px 8px; font-variant-numeric: tabular-nums; }
table.matrix td.zero { color: var(--line); }
table.matrix td.diagonal { background: var(--line); }
/* A cell shaded on both sides of the diagonal is a cycle, findable by eye. */
table.matrix td.mutual { background: rgba(208, 59, 59, 0.18); font-weight: 650; }

td.bar-cell { min-width: 220px; white-space: nowrap; }
.bar { display: inline-block; height: 10px; background: var(--accent); border-radius: 2px;
       vertical-align: middle; margin-right: 8px; min-width: 2px; max-width: 60%; }
.bar-value { font-family: var(--mono); font-size: 11.5px; color: var(--muted);
             font-variant-numeric: tabular-nums; }

details { margin: 12px 0; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
details pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
              padding: 12px; overflow-x: auto; }

footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line);
         color: var(--faint); font-size: 13px; }

/* The printed document's first page; on screen the summary is the cover. */
.cover { display: none; }
.cover-for { color: var(--muted); font-size: 15px; margin: 18px 0 2px; }

/* Print is the whole document: a cover, then every panel, no tab chrome. */
@media print {
  .tabs, .tab-input, .theme-switch { display: none; }
  .cover { display: block; break-after: page; padding-top: 15vh; }
  header { display: none; }
  .panel { display: block !important; break-before: page; }
  body { background: #ffffff; }
  .page { max-width: none; padding: 0; }
  figure { break-inside: avoid; }
  tr, .finding, .tiles li { break-inside: avoid; }
  h3.subheading { break-after: avoid; }
}
`.trim();
