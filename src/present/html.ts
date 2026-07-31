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
import type { RankedFindings } from './findings.js';
import { layout } from './layout.js';
import { toMermaid } from './mermaid.js';
import { escapeAttr, escapeText, toSvg } from './svg.js';

export interface ReportContext {
  run: RunSummary;
  /** Extractor complaints, grouped. Part of "what this report did not see". */
  diagnostics: Array<{ level: string; extractor: string | null; count: number }>;
  /** Model output discarded by the citation check (ADR-0013). */
  rejectedByCitationCheck: number;
}

export function toHtml(
  model: C4Model,
  ranked: RankedFindings,
  context: ReportContext,
): string {
  const { run } = context;
  const title = `${run.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'repository'} — structure`;

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
    header(context),
    legend(),
    diagramSection(model.context, 'context', 'Level 1 — system context'),
    diagramSection(model.container, 'container', 'Level 2 — containers'),
    ...model.components.map((diagram, n) =>
      diagramSection(diagram, `component-${n}`, `Level 3 — components of ${diagram.scope ?? ''}`),
    ),
    findingsSection(ranked),
    limitsSection(context),
    footer(run),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function header(context: ReportContext): string {
  const { run } = context;
  const counts = run.counts;
  return [
    '<header>',
    `<h1>${escapeText(run.repoPath)}</h1>`,
    '<dl class="meta">',
    row('Commit', run.repoHead ?? 'not recorded'),
    row('Run', `${run.runId}, started ${run.startedAt}`),
    row('Tool', `stratigraph ${run.toolVersion}`),
    row('Extractors', run.extractors.join(', ') || 'none'),
    row('Languages', run.languages.join(', ') || 'none'),
    row(
      'Facts',
      `${counts.files} files, ${counts.nodes} nodes, ${counts.edges} edges, ` +
        `${counts.packages} packages, ${counts.endpoints} endpoints, ${counts.tables} tables`,
    ),
    row('History', counts.commits === 0 ? 'not mined' : `${counts.commits} commits`),
    '</dl>',
    '<p class="lead">Everything below was read from the source at the commit above, ' +
      'or from that commit&rsquo;s history. Anything a model wrote is marked.</p>',
    '</header>',
  ].join('\n');
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

function diagramSection(diagram: C4Diagram, id: string, heading: string): string {
  const placed = layout(diagram);
  const parts = [
    `<section id="${escapeAttr(id)}">`,
    `<h2>${escapeText(heading)}</h2>`,
    `<p class="caption">${escapeText(diagram.title)}</p>`,
  ];

  if (placed.boxes.length === 0) {
    parts.push('<p class="empty">Nothing to draw at this level for this run.</p>');
  } else {
    parts.push('<figure>', toSvg(placed, id), '</figure>');
  }

  const notes = [...diagram.notes, ...placed.notes];
  if (notes.length > 0) {
    parts.push('<ul class="notes">');
    for (const note of notes) parts.push(`<li>${escapeText(note)}</li>`);
    parts.push('</ul>');
  }

  if (diagram.relationships.length > 0) {
    parts.push(relationshipTable(diagram));
  }

  parts.push(
    '<details>',
    '<summary>Mermaid source</summary>',
    `<pre><code>${escapeText(toMermaid(diagram))}</code></pre>`,
    '</details>',
    '</section>',
  );
  return parts.join('\n');
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
    '<table>',
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
  const parts = ['<section id="findings">', '<h2>Findings, ranked</h2>'];

  if (ranked.total === 0) {
    parts.push(
      '<p class="empty">No findings for this run. That means every rule that ran found ' +
        'nothing &mdash; not that nothing was looked at; the limits below say which ' +
        'rules could run.</p>',
      '</section>',
    );
    return parts.join('\n');
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

  parts.push('</section>');
  return parts.join('\n');
}

/**
 * What this report did not look at.
 *
 * On the page, not in a footnote. A report a reader is expected to act on has
 * to state its own blind spots, or its silences read as absences.
 */
function limitsSection(context: ReportContext): string {
  const parts = [
    '<section id="limits">',
    '<h2>What this report did not see</h2>',
    '<ul class="notes">',
  ];

  for (const gap of context.run.gaps) parts.push(`<li>${escapeText(gap)}</li>`);

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
    '</section>',
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
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
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

table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; display: block; overflow-x: auto; }
caption { text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; }
tr.inferred td { background: rgba(227, 179, 65, 0.07); }

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
