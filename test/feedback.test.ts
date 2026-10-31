import { describe, expect, it } from 'vitest';

import { DESIGN_PARTNER_URL, DISCUSSION_URL, feedbackLines } from '../src/feedback.js';

describe('the closing feedback line', () => {
  it('points at the discussion and, after an upgrade, the design-partner form', () => {
    expect(feedbackLines('scan').join('\n')).toContain(DISCUSSION_URL);
    expect(feedbackLines('scan').join('\n')).not.toContain(DESIGN_PARTNER_URL);
    expect(feedbackLines('upgrade').join('\n')).toContain(DESIGN_PARTNER_URL);
    expect(DESIGN_PARTNER_URL).toMatch(/template=design-partner\.yml$/);
  });
});
