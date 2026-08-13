/**
 * `findings.md` — the ranked findings as a file you can paste into an issue.
 *
 * Same data as the HTML, same order, and the same rule about evidence: every
 * finding prints the rows it was derived from, because a claim the reader
 * cannot check without opening the database is the unfalsifiable kind this
 * project is written against.
 */

import type { FindingEvidence, RankedFindings } from './findings.js';

export interface MarkdownContext {
  repoName: string;
  repoHead: string | null;
  runId: number;
  toolVersion: string;
  startedAt: string;
  /**
   * Whether `analyze` left any output on this run — see `Coverage.analysis`.
   *
   * This file is the one that leaves the machine: it gets pasted into an issue
   * with none of the report's limits section around it. So it has to carry the
   * distinction itself, or an unanalysed run reads as a clean one.
   */
  analysisStored: boolean;
  /** What this run could not answer, and the command that would fix it. */
  gaps?: string[] | undefined;
}

export function toMarkdown(ranked: RankedFindings, context: MarkdownContext): string {
  const lines: string[] = [
    `# Findings — ${context.repoName}`,
    '',
    `Run ${context.runId}, stratigraph ${context.toolVersion}, started ${context.startedAt}.`,
    context.repoHead === null
      ? 'HEAD was not recorded for this run.'
      : `Facts describe commit \`${context.repoHead}\`, not the working tree.`,
    '',
  ];

  if (ranked.total === 0) {
    lines.push(
      ...(context.analysisStored
        ? [
            'No findings for this run. That means every rule that ran found nothing —',
            'not that nothing was looked at. `stratigraph analyze` reports which rules ran.',
          ]
        : [
            '**No rule has been evaluated against this run.** No analysis output is stored',
            `for run ${context.runId} — no cluster, no finding, no coupled pair — so this is`,
            'an absence of analysis, not a clean result. Run `stratigraph analyze` and',
            'generate the report again.',
          ]),
      '',
      ...limits(context),
    );
    return `${lines.join('\n')}`;
  }

  lines.push(summary(ranked), '', ...limits(context));

  if (ranked.uncited > 0) {
    lines.push(
      `> ${ranked.uncited} finding(s) carry no citation and are not listed. A finding`,
      '> that cannot point at the row it came from is not publishable (ADR-0021).',
      '',
    );
  }

  lines.push('## Ranked', '');
  for (const [n, finding] of ranked.findings.entries()) {
    lines.push(
      `### ${n + 1}. ${escape(finding.title)}`,
      '',
      `**${finding.severity}** · ${escape(finding.ruleTitle)} · ` +
        (finding.authoredBy === 'model'
          ? `written by \`${finding.model ?? 'a model'}\` — inference, not observation`
          : 'derived by an algorithm from parsed facts'),
      '',
    );
    if (finding.detail !== null && finding.detail.trim() !== '') {
      lines.push(indentBlock(finding.detail), '');
    }
    if (finding.evidence.length > 0) {
      lines.push('Evidence:', '');
      for (const item of finding.evidence) lines.push(`- ${evidenceLine(item)}`);
      lines.push('');
    }
  }

  if (ranked.findings.length < publishable(ranked)) {
    lines.push(
      `Showing ${ranked.findings.length} of ${publishable(ranked)} findings — raise \`--top\` for more.`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * What this run could not answer, restated inside the file itself.
 *
 * The HTML report has a limits tab; a markdown file pasted into an issue has
 * whatever it carries. A list of findings mined from a run with no history is
 * a different claim from the same list mined from a full one, and the reader
 * cannot tell without this.
 */
function limits(context: MarkdownContext): string[] {
  const gaps = context.gaps ?? [];
  if (gaps.length === 0) return [];
  return ['## Limits of this run', '', ...gaps.map((gap) => `- ${gap}`), ''];
}

function summary(ranked: RankedFindings): string {
  const bySeverity = ranked.bySeverity
    .map((row) => `${row.count} ${row.severity}`)
    .join(', ');
  return `${publishable(ranked)} finding(s): ${bySeverity}.`;
}

function publishable(ranked: RankedFindings): number {
  return ranked.total - ranked.uncited;
}

export function evidenceLine(item: FindingEvidence): string {
  const where =
    item.path === null ? '' : ` — \`${item.path}${item.line === null ? '' : `:${item.line}`}\``;
  return `${escape(item.label)}${where}`;
}

/**
 * Quote a multi-line detail as a block.
 *
 * Details are written for a terminal, so they carry their own indentation and
 * line breaks. A blockquote keeps that shape instead of letting Markdown
 * reflow it into one paragraph.
 */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Neutralise the characters that would turn a finding's title into markup.
 *
 * Titles hold fqns, and a TypeScript fqn carries a path with underscores and
 * asterisks in it often enough to matter.
 */
function escape(text: string): string {
  return text.replaceAll('\\', '\\\\').replace(/([*_`[\]<>|])/g, '\\$1');
}
