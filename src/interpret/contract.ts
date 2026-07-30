/**
 * The grounding contract: what the model is allowed to say, and the check that
 * enforces it.
 *
 * ADR-0013 has the reasoning. In short: the model is shown a pack of
 * opaquely-identified evidence and may refer only to what is in it. This module
 * holds the JSON schema sent as `output_config.format`, and the validator that
 * runs afterwards — because the schema can guarantee a `cites` array of strings
 * and cannot guarantee those strings mean anything.
 *
 * Everything here is a pure function of a pack and a response. No database, no
 * network, no clock. That is what makes the rules exhaustively testable, and
 * why CI never needs an API key.
 */

import type { EvidencePack } from './evidence.js';

/** A sentence the model asserts, and the pack ids that support it. */
export interface Claim {
  text: string;
  cites: string[];
}

export interface AdrCandidate {
  /** A label, not a claim: subject to the vocabulary rule only. */
  title: string;
  /** The decision the code appears to embody. */
  decision: Claim;
  /** What in the pack shows it. */
  evidence: Claim;
  /** A question for the team. Asserts nothing, so it cites nothing. */
  question: string;
}

export interface Interpretation {
  /** A short label for the cluster. Not an assertion about any one edge. */
  name: string;
  /** What the cluster appears to be responsible for. */
  responsibility: Claim[];
  /** The model's reading of an intent mismatch, when the pack carries one. */
  mismatch: Claim | null;
  adrCandidates: AdrCandidate[];
}

export interface Violation {
  /** Which rejection rule fired. */
  rule:
    | 'unknown-citation'
    | 'uncited-claim'
    | 'invented-identifier'
    | 'unresolvable-evidence'
    | 'malformed';
  /** Where in the response, as a dotted path. */
  at: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Interpretation }
  | { ok: false; violations: Violation[] };

/**
 * The JSON schema sent as `output_config.format`.
 *
 * Necessary and not sufficient: it guarantees the shape, which is why the
 * validator below only ever has to reason about meaning.
 */
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'responsibility', 'mismatch', 'adrCandidates'],
  properties: {
    name: {
      type: 'string',
      description:
        'A short label for what this group of packages is, two or three words. ' +
        'Use only words that appear in the evidence or are plain English.',
    },
    responsibility: {
      type: 'array',
      description: 'What this group appears to be responsible for. One to four sentences.',
      items: claimSchema('One sentence. Every sentence must cite the evidence for it.'),
    },
    mismatch: {
      anyOf: [
        claimSchema(
          'Your reading of why the package flagged as a mismatch sits where it does. ' +
            'Null when the evidence does not carry one.',
        ),
        { type: 'null' },
      ],
    },
    adrCandidates: {
      type: 'array',
      description:
        'Decisions this code appears to embody that were probably never written down. ' +
        'Empty is a valid and common answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'decision', 'evidence', 'question'],
        properties: {
          title: { type: 'string' },
          decision: claimSchema('The decision the code embodies.'),
          evidence: claimSchema('What in the evidence shows it.'),
          question: {
            type: 'string',
            description: 'A question for the team. Ask; do not assert.',
          },
        },
      },
    },
  },
} as const;

function claimSchema(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'cites'],
    description,
    properties: {
      text: { type: 'string' },
      cites: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'Evidence ids from the pack, exactly as given (e.g. "e3", "n1").',
      },
    },
  } as const;
}

/**
 * Tokens that look like something from a codebase.
 *
 * Four shapes: a dotted identifier (`com.example.Order`), a path
 * (`src/main/Order.java`), a commit sha, and a synthetic node name — the
 * `<default>` package the Java extractor emits for types declared outside any
 * package, with anything hanging off it.
 *
 * That fourth pattern exists because of a hole found by running the validator
 * over 38 real dubbo evidence packs: `<default>.AbstractRegistryFactory` and
 * `<default>s` matched none of the other three, so a fabrication built on the
 * default package was never checked at all. Angle brackets are not word
 * characters, and `\b` refuses to start a match on one.
 *
 * Exported because `evidence.ts` builds the vocabulary with the *same*
 * function. Two copies of this list is two ways for the check and the
 * vocabulary to disagree, and either direction is a defect: a hole, or a
 * rejection of a name the pack really did contain.
 */
const PATTERNS = [
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
  // A path needs three segments or a file extension. Two bare words around a
  // slash are English — dubbo rejected true descriptions for saying
  // "interface/implementation" and "demo/compatibility", where the slash means
  // "or". Anything shorter that really is a path is a directory prefix of a
  // file the pack showed, and is in the vocabulary for that reason instead.
  /\b[\w.$-]+(?:\/[\w.$-]+){2,}\b|\b[\w.$-]+\/[\w.$-]*\.[\w$-]+\b/g,
  /\b[0-9a-f]{7,40}\b/g,
  /<[A-Za-z_][\w$]*>[\w$.]*/g,
];

/**
 * English that happens to match the identifier pattern. Kept short on purpose:
 * every entry is a hole in rule 3, so the list grows only when a real report
 * shows it must.
 */
const NOT_IDENTIFIERS = new Set(['e.g', 'i.e', 'etc', 'vs', 'a.k.a', 'no.op']);

/**
 * Check a model response against its pack.
 *
 * Collects every violation rather than stopping at the first: the retry sends
 * them all back, and one round trip that fixes four problems beats four that
 * fix one each.
 */
export function validate(response: unknown, pack: EvidencePack): ValidationResult {
  const violations: Violation[] = [];
  const shaped = shape(response, violations);
  if (shaped === null) return { ok: false, violations };

  const known = new Set(pack.items.map((item) => item.id));

  // A label is not an assertion about a particular edge, so it need not cite
  // one — but it may not name a class nobody showed it (ADR-0013).
  checkVocabulary(shaped.name, 'name', pack, violations);

  for (const [at, claim] of claimsOf(shaped)) {
    if (claim.cites.length === 0) {
      violations.push({
        rule: at.startsWith('adrCandidates') ? 'unresolvable-evidence' : 'uncited-claim',
        at,
        message: `"${truncate(claim.text)}" cites nothing. Every claim must cite evidence.`,
      });
    }
    for (const id of claim.cites) {
      if (!known.has(id)) {
        violations.push({
          rule: 'unknown-citation',
          at: `${at}.cites`,
          message: `"${id}" is not an evidence id in this pack.`,
        });
      }
    }
    checkVocabulary(claim.text, `${at}.text`, pack, violations);
  }

  for (const [index, candidate] of shaped.adrCandidates.entries()) {
    checkVocabulary(candidate.title, `adrCandidates[${index}].title`, pack, violations);
    checkVocabulary(candidate.question, `adrCandidates[${index}].question`, pack, violations);
  }

  return violations.length === 0
    ? { ok: true, value: shaped }
    : { ok: false, violations };
}

/** Every claim field in the response, with the path that names it. */
function claimsOf(value: Interpretation): Array<[string, Claim]> {
  const claims: Array<[string, Claim]> = value.responsibility.map((claim, index) => [
    `responsibility[${index}]`,
    claim,
  ]);
  if (value.mismatch !== null) claims.push(['mismatch', value.mismatch]);
  for (const [index, candidate] of value.adrCandidates.entries()) {
    claims.push([`adrCandidates[${index}].decision`, candidate.decision]);
    claims.push([`adrCandidates[${index}].evidence`, candidate.evidence]);
  }
  return claims;
}

/**
 * Rule 3: no identifier the pack did not contain.
 *
 * This is the rule that catches the dangerous shape — a real citation attached
 * to a sentence about a class that does not exist. Rules 1 and 2 check a
 * pointer exists; this checks the prose stayed inside what it points at.
 */
function checkVocabulary(
  text: string,
  at: string,
  pack: EvidencePack,
  violations: Violation[],
): void {
  for (const token of identifiersIn(text)) {
    if (!nameable(token, pack)) {
      violations.push({
        rule: 'invented-identifier',
        at,
        message:
          `"${token}" does not appear anywhere in the evidence. ` +
          `Name only what you were shown.`,
      });
    }
  }
}

/**
 * Whether the pack accounts for this token.
 *
 * Exact match, or a dot-suffix of something the pack contains: a model that
 * writes `adaptive.impl` for `org.apache.dubbo.common.extension.adaptive.impl`
 * is abbreviating a real name, not inventing one, and on dubbo that shortening
 * alone sank three otherwise-sound descriptions. A suffix cannot smuggle
 * anything in — `bar.Qux` is a suffix of nothing when only `foo.bar.Baz` was
 * shown — so this admits real sub-parts of real names and nothing else.
 */
function nameable(token: string, pack: EvidencePack): boolean {
  if (pack.vocabulary.has(token)) return true;
  if (!token.includes('.')) return false;
  const suffix = `.${token}`;
  for (const known of pack.vocabulary) {
    if (known.endsWith(suffix)) return true;
  }
  return false;
}

/** Identifier-shaped tokens in a string, deduplicated and stop-listed. */
export function identifiersIn(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].replace(/[.,;:]+$/, '');
      if (token.length === 0) continue;
      if (NOT_IDENTIFIERS.has(token.toLowerCase())) continue;
      found.add(token);
    }
  }
  return [...found];
}

/**
 * Structural check, before meaning.
 *
 * `output_config.format` should make this unreachable, but "should" is how the
 * unfalsifiable claims get in, and a malformed response must fail closed rather
 * than throw somewhere further down.
 */
function shape(response: unknown, violations: Violation[]): Interpretation | null {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    violations.push({ rule: 'malformed', at: '', message: 'expected a JSON object' });
    return null;
  }
  const raw = response as Record<string, unknown>;

  const name = typeof raw['name'] === 'string' ? raw['name'] : null;
  if (name === null) {
    violations.push({ rule: 'malformed', at: 'name', message: 'expected a string' });
  }

  const responsibility = claimList(raw['responsibility'], 'responsibility', violations);
  const mismatch =
    raw['mismatch'] === null || raw['mismatch'] === undefined
      ? null
      : claim(raw['mismatch'], 'mismatch', violations);

  const candidates: AdrCandidate[] = [];
  const rawCandidates = raw['adrCandidates'];
  if (rawCandidates !== undefined && rawCandidates !== null) {
    if (!Array.isArray(rawCandidates)) {
      violations.push({ rule: 'malformed', at: 'adrCandidates', message: 'expected an array' });
    } else {
      for (const [index, entry] of rawCandidates.entries()) {
        const at = `adrCandidates[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          violations.push({ rule: 'malformed', at, message: 'expected an object' });
          continue;
        }
        const record = entry as Record<string, unknown>;
        const decision = claim(record['decision'], `${at}.decision`, violations);
        const evidence = claim(record['evidence'], `${at}.evidence`, violations);
        if (decision === null || evidence === null) continue;
        candidates.push({
          title: typeof record['title'] === 'string' ? record['title'] : '',
          decision,
          evidence,
          question: typeof record['question'] === 'string' ? record['question'] : '',
        });
      }
    }
  }

  if (name === null || responsibility === null) return null;
  return { name, responsibility, mismatch, adrCandidates: candidates };
}

function claimList(value: unknown, at: string, violations: Violation[]): Claim[] | null {
  if (!Array.isArray(value)) {
    violations.push({ rule: 'malformed', at, message: 'expected an array' });
    return null;
  }
  const claims: Claim[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = claim(entry, `${at}[${index}]`, violations);
    if (parsed !== null) claims.push(parsed);
  }
  return claims;
}

function claim(value: unknown, at: string, violations: Violation[]): Claim | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    violations.push({ rule: 'malformed', at, message: 'expected an object' });
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['text'] !== 'string') {
    violations.push({ rule: 'malformed', at: `${at}.text`, message: 'expected a string' });
    return null;
  }
  const cites = record['cites'];
  if (cites !== undefined && !Array.isArray(cites)) {
    violations.push({ rule: 'malformed', at: `${at}.cites`, message: 'expected an array' });
    return null;
  }
  return {
    text: record['text'],
    cites: ((cites ?? []) as unknown[]).filter(
      (id): id is string => typeof id === 'string',
    ),
  };
}

function truncate(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

/** The violations, rendered for the one retry the layer allows (ADR-0013). */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `- ${violation.at || '(root)'}: ${violation.message}`)
    .join('\n');
}
