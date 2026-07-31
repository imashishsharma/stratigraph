/**
 * The static HTML report.
 *
 * One file, inline CSS, no script, no external reference of any kind — it opens
 * from a file share, survives being emailed, and renders with JavaScript
 * disabled (ADR-0020). Nothing in it is fetched when the reader opens it,
 * which matters for a tool whose pitch is that it never touches the network.
 *
 * Two rules govern the content. Every claim shows the row it came from, and
 * every piece of inference is visually distinct from every observation — in the
 * diagrams, in the prose, and in the legend that explains the difference.
 */

import type { RunSummary } from '../mcp/queries.js';
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

interface Section {
  id: string;
  title: string;
  html: string;
}

export function toHtml(data: ReportData, context: ReportContext): string {
  const { run } = context;
  const title = `${run.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'repository'} — structure`;

  // Built as a list so the contents and the page cannot disagree about what is
  // on it — a table of contents maintained separately is a table of contents
  // that goes stale.
  const sections: Section[] = [
    section('findings', 'Findings, ranked', findingsSection(data.ranked)),
    section(
      'context',
      'Level 1 — system context',
      diagramSection(data.model.context, 'context'),
    ),
    section('container', 'Level 2 — containers', diagramSection(data.model.container, 'container')),
    ...data.model.components.map((diagram, n) =>
      section(
        `component-${n}`,
        `Level 3 — components of ${diagram.scope ?? ''}`,
        diagramSection(diagram, `component-${n}`),
      ),
    ),
    ...data.classes.map((diagram, n) =>
      section(
        `code-${n}`,
        `Level 4 — code in ${diagram.packageFqn}`,
        classSection(diagram, `code-${n}`),
      ),
    ),
    section('er', 'Data model', erSection(data.er)),
    section('api', 'HTTP surface', apiSection(data.surface)),
    section('matrix', 'Dependency matrix', matrixSection(data.matrix)),
    section('hotspots', 'Hotspots', hotspotSection(data.hotspots)),
    section('limits', 'What this report did not see', limitsSection(context, data)),
  ].filter((entry) => entry.html !== '');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    header(context, data),
    contents(sections),
    legend(),
    ...sections.map(
      (entry) =>
        `<section id="${escapeAttr(entry.id)}">\n<h2>${escapeText(entry.title)}</h2>\n${entry.html}\n</section>`,
    ),
    footer(run),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function section(id: string, title: string, html: string): Section {
  return { id, title, html };
}

function contents(sections: Section[]): string {
  return [
    '<nav class="contents">',
    '<h2>Contents</h2>',
    '<ol>',
    ...sections.map(
      (entry) => `<li><a href="#${escapeAttr(entry.id)}">${escapeText(entry.title)}</a></li>`,
    ),
    '</ol>',
    '</nav>',
  ].join('\n');
}

function header(context: ReportContext, data: ReportData): string {
  const { run } = context;
  const counts = run.counts;
  const publishable = data.ranked.total - data.ranked.uncited;
  const high = data.ranked.bySeverity.find((row) => row.severity === 'high')?.count ?? 0;

  return [
    '<header>',
    `<h1>${escapeText(run.repoPath)}</h1>`,
    '<dl class="meta">',
    row('Commit', run.repoHead ?? 'not recorded'),
    row('Run', `${run.runId}, started ${run.startedAt}`),
    row('Tool', `stratigraph ${run.toolVersion}`),
    row('Extractors', run.extractors.join(', ') || 'none'),
    row('Languages', run.languages.join(', ') || 'none'),
    '</dl>',
    // The numbers a reader wants before they decide whether to read the rest.
    '<ul class="tiles">',
    tile(counts.packages, 'packages'),
    tile(counts.types, 'types'),
    tile(counts.endpoints, 'endpoints'),
    tile(counts.tables, 'tables'),
    tile(counts.commits, 'commits'),
    tile(publishable, 'findings', high > 0 ? `${high} high` : null),
    '</ul>',
    '<p class="lead">Everything below was read from the source at the commit above, ' +
      'or from that commit&rsquo;s history. Anything a model wrote is marked.</p>',
    '</header>',
  ].join('\n');
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
    '<h2>How to read this</h2>',
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

function diagramSection(diagram: C4Diagram, id: string): string {
  const placed = layout(diagram);
  const parts = [`<p class="caption">${escapeText(diagram.title)}</p>`];

  if (placed.boxes.length === 0) {
    parts.push('<p class="empty">Nothing to draw at this level for this run.</p>');
  } else {
    parts.push('<figure>', toSvg(placed, id), '</figure>');
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

function classSection(diagram: ClassDiagram, id: string): string {
  const { nodes, links } = classLayoutInput(diagram);
  const placed = layoutGraph(nodes, links);
  const parts = [
    `<p class="caption">${escapeText(
      `${diagram.classes.length} type(s) declared in ${diagram.packageFqn}, with their members ` +
        `as the source declares them.`,
    )}</p>`,
    '<figure>',
    toSvg(placed, id),
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

function erSection(model: ErModel): string {
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
    toSvg(placed, 'er'),
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

function findingsSection(ranked: RankedFindings): string {
  const parts: string[] = [];

  if (ranked.total === 0) {
    return (
      '<p class="empty">No findings for this run. That means every rule that ran found ' +
      'nothing &mdash; not that nothing was looked at; the limits below say which ' +
      'rules could run.</p>'
    );
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
 * Dark by default with a light-scheme override, because the diagrams' colours
 * are chosen against a dark background and a report that inverts badly is worse
 * than one that commits. The monospace stack matches the metrics the layout
 * assumed, so the text inside a box is the width the box was sized for.
 */
const STYLE = `
:root {
  --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3;
  --muted: #9198a1; --accent: #58a6ff; --inferred: #e3b341; --warn: #f85149;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 24px; margin: 0 0 16px; word-break: break-all; }
h2 { font-size: 19px; margin: 40px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 15px; margin: 0 0 8px; word-break: break-word; }
p { margin: 8px 0; }
code, pre { font-family: var(--mono); font-size: 12.5px; }
a { color: var(--accent); }

.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 16px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; word-break: break-word; }
.lead { color: var(--muted); }

/* The numbers a reader wants before deciding whether to read the rest. */
.tiles { list-style: none; display: flex; flex-wrap: wrap; gap: 10px; padding: 0; margin: 20px 0; }
.tiles li { flex: 1 1 110px; background: var(--panel); border: 1px solid var(--line);
            border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; }
.tile-value { font-size: 22px; font-weight: 650; line-height: 1.2; }
.tile-label { color: var(--muted); font-size: 12.5px; }
.tile-detail { color: var(--warn); font-size: 12px; margin-top: 2px; }

.contents { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
            padding: 4px 20px 16px; margin: 20px 0; }
.contents ol { columns: 2; column-gap: 32px; padding-left: 20px; margin: 0; }
.contents li { margin: 4px 0; break-inside: avoid; }

.legend { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 4px 20px 16px; }
.legend ul { list-style: none; padding: 0; }
.legend li { margin: 10px 0; }
.swatch { display: inline-block; width: 26px; height: 0; border-top: 2px solid var(--muted); vertical-align: middle; margin-right: 10px; }
.swatch.inferred { border-top: 2px dashed var(--inferred); }
.swatch.routed { border-top: 2px dotted var(--muted); }

figure { margin: 16px 0; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
svg.diagram { display: block; max-width: 100%; height: auto; }

.caption { color: var(--muted); font-size: 13.5px; }
.empty { color: var(--muted); font-style: italic; }
.warn { color: var(--warn); }

.notes { color: var(--muted); font-size: 13.5px; padding-left: 20px; }
.notes li { margin: 6px 0; }

table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
caption { text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line);
         overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; }
/* A numeric column is narrow, and left to itself the browser breaks "Commits"
   across two lines rather than widening it by six pixels. */
td.num, th.num { text-align: right; }
th.num { white-space: nowrap; }
tr.inferred td { background: rgba(227, 179, 65, 0.07); }

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
       border-radius: 999px; font-size: 12px; color: var(--muted); }
.tag.sev { text-transform: uppercase; letter-spacing: 0.04em; }
.inferred-tag { color: var(--inferred); border-color: var(--inferred); font-style: italic; }

.findings { list-style: none; padding: 0; counter-reset: finding; }
.finding { counter-increment: finding; position: relative; background: var(--panel);
           border: 1px solid var(--line); border-left-width: 4px; border-radius: 8px;
           padding: 16px 20px; margin: 12px 0; }
.finding h3::before { content: counter(finding) ". "; color: var(--muted); }
.finding.sev-high { border-left-color: var(--warn); }
.finding.sev-medium { border-left-color: var(--inferred); }
.finding.sev-low { border-left-color: var(--accent); }
.finding.sev-info { border-left-color: var(--line); }
.finding.model h3 { font-style: italic; color: var(--inferred); }
.detail { white-space: pre-wrap; color: var(--muted); margin: 8px 0; overflow-x: auto; }

/* The API surface, the matrix and the hotspots each want their own column
   proportions, so they opt out of the six-column grid the relationship tables
   are sized for. */
.verb { display: inline-block; min-width: 52px; text-align: center; padding: 1px 6px;
        border-radius: 4px; font-family: var(--mono); font-size: 11.5px; font-weight: 600;
        background: #30363d; color: var(--text); }
.verb-get { background: #1f6feb; }
.verb-post { background: #238636; }
.verb-put, .verb-patch { background: #9e6a03; }
.verb-delete { background: #b62324; }

.scroller { overflow-x: auto; }
table.matrix { font-size: 12px; width: auto; }
table.matrix th.rowhead { font-family: var(--mono); font-weight: 500; white-space: nowrap;
                          text-align: left; color: var(--text); }
table.matrix td { text-align: right; padding: 4px 8px; }
table.matrix td.zero { color: #484f58; }
table.matrix td.diagonal { background: var(--line); }
/* A cell shaded on both sides of the diagonal is a cycle, findable by eye. */
table.matrix td.mutual { background: rgba(248, 81, 73, 0.22); font-weight: 650; }

td.bar-cell { min-width: 220px; white-space: nowrap; }
.bar { display: inline-block; height: 10px; background: var(--accent); border-radius: 2px;
       vertical-align: middle; margin-right: 8px; min-width: 2px; max-width: 60%; }
.bar-value { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }

details { margin: 12px 0; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
details pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
              padding: 12px; overflow-x: auto; }

footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line);
         color: var(--muted); font-size: 13px; }

@media (prefers-color-scheme: light) {
  :root { --bg: #ffffff; --panel: #f6f8fa; --line: #d0d7de; --text: #1f2328;
          --muted: #59636e; --accent: #0969da; --inferred: #9a6700; --warn: #cf222e; }
  figure { background: #22272e; }
}
`.trim();
