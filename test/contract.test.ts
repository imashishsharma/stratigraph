import { describe, expect, it } from 'vitest';

import {
  describeViolations,
  identifiersIn,
  RESPONSE_SCHEMA,
  validate,
  type Violation,
} from '../src/interpret/contract.js';
import type { EvidencePack } from '../src/interpret/evidence.js';

/** A pack with three items and a small, explicit vocabulary. */
function pack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    clusterId: 1,
    prefix: 'com.example.shop',
    members: ['com.example.shop.web', 'com.example.shop.repo'],
    items: [
      { id: 'n1', kind: 'node', text: 'package com.example.shop.web', ref: { nodeId: 10 } },
      { id: 'n2', kind: 'node', text: 'package com.example.shop.repo', ref: { nodeId: 11 } },
      {
        id: 'e1',
        kind: 'edge',
        text: 'imports com.example.shop.web.OrderController -> com.example.shop.repo.OrderRepo at src/web/OrderController.java:12',
        ref: { edgeId: 500, line: 12 },
      },
    ],
    vocabulary: new Set([
      'com',
      'com.example',
      'com.example.shop',
      'com.example.shop.web',
      'com.example.shop.repo',
      'com.example.shop.web.OrderController',
      'com.example.shop.repo.OrderRepo',
      'src/web/OrderController.java',
    ]),
    mismatch: null,
    source: [],
    ...overrides,
  };
}

function good(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Order handling',
    responsibility: [
      { text: 'Serves order endpoints and persists them.', cites: ['e1'] },
      { text: 'com.example.shop.web is the entry point.', cites: ['n1'] },
    ],
    mismatch: null,
    adrCandidates: [],
    ...overrides,
  };
}

function rules(violations: readonly Violation[]): string[] {
  return [...new Set(violations.map((violation) => violation.rule))].sort();
}

function reject(response: unknown, expected: Violation['rule']): Violation[] {
  const result = validate(response, pack());
  expect(result.ok, `expected ${expected}, but the response validated`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(rules(result.violations)).toContain(expected);
  return result.violations;
}

describe('validate — accepting', () => {
  it('accepts a grounded response', () => {
    const result = validate(good(), pack());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(describeViolations(result.violations));
    expect(result.value.name).toBe('Order handling');
    expect(result.value.responsibility).toHaveLength(2);
  });

  it('accepts a dotted prefix of a member package', () => {
    // "the com.example.shop packages" names a real enclosing package, so it is
    // not an invented fact (ADR-0013).
    const result = validate(
      good({
        responsibility: [{ text: 'The com.example.shop packages serve orders.', cites: ['n1'] }],
      }),
      pack(),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts prose with no identifiers at all', () => {
    const result = validate(
      good({ responsibility: [{ text: 'Handles orders end to end.', cites: ['e1'] }] }),
      pack(),
    );
    expect(result.ok).toBe(true);
  });

  it('does not require a name to cite anything', () => {
    // A label is not an assertion about a particular edge.
    expect(validate(good({ name: 'Ordering' }), pack()).ok).toBe(true);
  });

  it('does not require an ADR question or title to cite anything', () => {
    const result = validate(
      good({
        adrCandidates: [
          {
            title: 'Repository access is package-local',
            decision: { text: 'The web layer talks to its own repo.', cites: ['e1'] },
            evidence: { text: 'One import connects them.', cites: ['e1'] },
            question: 'Was this meant to be the only path to persistence?',
          },
        ],
      }),
      pack(),
    );
    expect(result.ok).toBe(true);
  });

  it('tolerates ordinary English that looks like an identifier', () => {
    const result = validate(
      good({
        responsibility: [{ text: 'Serves orders, e.g. checkout and refunds.', cites: ['e1'] }],
      }),
      pack(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validate — rule 1, unknown citation', () => {
  it('rejects an id that is not in the pack', () => {
    const violations = reject(
      good({ responsibility: [{ text: 'Serves orders.', cites: ['e99'] }] }),
      'unknown-citation',
    );
    expect(violations[0]?.message).toContain('"e99" is not an evidence id');
  });

  it('rejects a database-shaped id, which is the guess that would fail open', () => {
    reject(
      good({ responsibility: [{ text: 'Serves orders.', cites: ['500'] }] }),
      'unknown-citation',
    );
  });

  it('rejects when only one of several citations is unknown', () => {
    reject(
      good({ responsibility: [{ text: 'Serves orders.', cites: ['e1', 'n1', 'f7'] }] }),
      'unknown-citation',
    );
  });
});

describe('validate — rule 2, uncited claim', () => {
  it('rejects a responsibility sentence that cites nothing', () => {
    const violations = reject(
      good({ responsibility: [{ text: 'Serves orders.', cites: [] }] }),
      'uncited-claim',
    );
    expect(violations[0]?.message).toContain('cites nothing');
  });

  it('rejects a mismatch reading that cites nothing', () => {
    reject(good({ mismatch: { text: 'It drifted.', cites: [] } }), 'uncited-claim');
  });

  it('rejects a claim whose cites key is missing entirely', () => {
    reject(good({ responsibility: [{ text: 'Serves orders.' }] }), 'uncited-claim');
  });
});

describe('validate — rule 3, invented identifier', () => {
  it('rejects a class nobody showed it, even with a real citation attached', () => {
    // The dangerous shape: a genuine citation on a fabricated sentence. Rules 1
    // and 2 both pass here; only rule 3 catches it.
    const violations = reject(
      good({
        responsibility: [
          { text: 'com.example.shop.web.TaxCalculator computes VAT.', cites: ['e1'] },
        ],
      }),
      'invented-identifier',
    );
    expect(violations[0]?.message).toContain('com.example.shop.web.TaxCalculator');
    expect(violations[0]?.message).toContain('Name only what you were shown');
  });

  it('rejects an invented file path', () => {
    reject(
      good({
        responsibility: [{ text: 'See src/web/TaxService.java for it.', cites: ['e1'] }],
      }),
      'invented-identifier',
    );
  });

  it('rejects an invented commit sha', () => {
    reject(
      good({ responsibility: [{ text: 'Introduced in deadbeef1234.', cites: ['e1'] }] }),
      'invented-identifier',
    );
  });

  it('rejects an invented identifier in the name, which cites nothing by design', () => {
    reject(good({ name: 'com.example.billing.Tax' }), 'invented-identifier');
  });

  it('rejects an invented identifier in an ADR question', () => {
    reject(
      good({
        adrCandidates: [
          {
            title: 'ok',
            decision: { text: 'Web talks to repo.', cites: ['e1'] },
            evidence: { text: 'One import.', cites: ['e1'] },
            question: 'Should com.example.audit.Trail be involved?',
          },
        ],
      }),
      'invented-identifier',
    );
  });

  it('rejects a near-miss on a real identifier', () => {
    // `OrderRepos` is one character from a real class, which is exactly the
    // case a human reviewer would skim past.
    reject(
      good({
        responsibility: [
          { text: 'com.example.shop.repo.OrderRepos stores them.', cites: ['e1'] },
        ],
      }),
      'invented-identifier',
    );
  });
});

describe('validate — rule 4, unresolvable ADR evidence', () => {
  it('rejects an ADR candidate whose evidence cites nothing', () => {
    const violations = reject(
      good({
        adrCandidates: [
          {
            title: 'Some decision',
            decision: { text: 'Web talks to repo directly.', cites: ['e1'] },
            evidence: { text: 'It is visible throughout.', cites: [] },
            question: 'Was that deliberate?',
          },
        ],
      }),
      'unresolvable-evidence',
    );
    expect(violations.some((violation) => violation.at.includes('evidence'))).toBe(true);
  });

  it('rejects an ADR candidate whose decision cites nothing', () => {
    reject(
      good({
        adrCandidates: [
          {
            title: 'Some decision',
            decision: { text: 'Web talks to repo directly.', cites: [] },
            evidence: { text: 'One import connects them.', cites: ['e1'] },
            question: 'Was that deliberate?',
          },
        ],
      }),
      'unresolvable-evidence',
    );
  });
});

describe('validate — malformed responses', () => {
  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
    ['a missing name', { responsibility: [], mismatch: null, adrCandidates: [] }],
    ['a non-array responsibility', good({ responsibility: 'lots' })],
    ['a claim that is a bare string', good({ responsibility: ['Serves orders.'] })],
  ])('rejects %s rather than throwing', (_label, response) => {
    reject(response, 'malformed');
  });

  it('rejects a malformed ADR candidate without discarding the rest', () => {
    const result = validate(good({ adrCandidates: [42] }), pack());
    expect(result.ok).toBe(false);
  });
});

describe('validate — reporting', () => {
  it('collects every violation rather than stopping at the first', () => {
    // One retry sends them all back, so one round trip fixes four problems.
    const result = validate(
      good({
        name: 'com.example.nope.Thing',
        responsibility: [
          { text: 'com.example.other.Missing does it.', cites: ['zz9'] },
          { text: 'And this.', cites: [] },
        ],
      }),
      pack(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(rules(result.violations)).toEqual([
      'invented-identifier',
      'uncited-claim',
      'unknown-citation',
    ]);
  });

  it('renders violations as a list the retry can use', () => {
    const violations = reject(
      good({ responsibility: [{ text: 'Serves orders.', cites: ['e99'] }] }),
      'unknown-citation',
    );
    const rendered = describeViolations(violations);
    expect(rendered).toContain('responsibility[0].cites');
    expect(rendered).toContain('e99');
  });
});

describe('identifiersIn', () => {
  it.each([
    ['com.example.shop.Order', ['com.example.shop.Order']],
    // A path yields its own basename too, so prose naming the file alone is
    // still checked. The pack's vocabulary is built with the same tokeniser,
    // so both forms are nameable whenever the path was shown.
    ['src/main/java/Order.java', ['src/main/java/Order.java', 'Order.java']],
    ['deadbeef1234', ['deadbeef1234']],
    ['Just plain prose about orders.', []],
    ['Orders, e.g. refunds, i.e. reversals.', []],
    ['Ends a sentence with com.example.shop.', ['com.example.shop']],
  ])('%s', (text, expected) => {
    expect(identifiersIn(text).sort()).toEqual([...expected].sort());
  });
});

describe('RESPONSE_SCHEMA', () => {
  it('closes every object, so the model cannot add fields nobody checks', () => {
    const closed = (node: unknown): boolean => {
      if (typeof node !== 'object' || node === null) return true;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && record['additionalProperties'] !== false) return false;
      return Object.values(record).every((child) =>
        Array.isArray(child) ? child.every(closed) : closed(child),
      );
    };
    expect(closed(RESPONSE_SCHEMA)).toBe(true);
  });

  it('requires at least one citation per claim at the schema level too', () => {
    const claim = RESPONSE_SCHEMA.properties.responsibility.items;
    expect(claim.properties.cites.minItems).toBe(1);
    expect(claim.required).toContain('cites');
  });
});
