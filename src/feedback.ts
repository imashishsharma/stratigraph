/**
 * One line at the end of `scan` and `upgrade run` saying where to tell the
 * maintainer how it went. Printed, never sent: nothing about the run leaves
 * the machine (the tool makes no network calls of its own for this, and has
 * no telemetry).
 */

import { info } from './log.js';

export const DISCUSSION_URL = 'https://github.com/imashishsharma/stratigraph/discussions/1';
export const DESIGN_PARTNER_URL = 'https://github.com/imashishsharma/stratigraph/issues/new?template=design-partner.yml';

export function feedbackLines(command: 'scan' | 'upgrade'): string[] {
  return command === 'upgrade'
    ? [
        `How did it go? Tell us (no code needed): ${DISCUSSION_URL}`,
        `Upgrading more services? Work on them with the maintainer: ${DESIGN_PARTNER_URL}`,
      ]
    : [`Useful, or wrong somewhere? Tell us: ${DISCUSSION_URL}`];
}

/** To stderr, so a script reading stdout is unaffected. */
export function printFeedback(command: 'scan' | 'upgrade'): void {
  info('');
  for (const line of feedbackLines(command)) info(line);
}
