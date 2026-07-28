/**
 * The wire format between extractors and the core: one JSON object per line on
 * stdout. stderr is for human-readable logging and is never parsed.
 *
 * Validation is deliberately strict and hand-written. A malformed fact is a bug
 * in an extractor, and we would rather see it at the boundary than discover it
 * three layers later in a report.
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import {
  EDGE_KINDS,
  FACT_PROTOCOL_VERSION,
  NODE_KINDS,
  CONFIDENCE,
  type Confidence,
  type DiagnosticFact,
  type EdgeFact,
  type EdgeKind,
  type Fact,
  type FileFact,
  type MetaFact,
  type NodeFact,
  type NodeKind,
  type NodeRef,
} from './types.js';

const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const EDGE_KIND_SET = new Set<string>(EDGE_KINDS);
const CONFIDENCE_SET = new Set<string>(CONFIDENCE);

export class FactProtocolError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly raw: string,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'FactProtocolError';
  }
}

export function serializeFact(fact: Fact): string {
  return JSON.stringify(fact);
}

/** Parse a single NDJSON line. `lineNumber` is only used for error messages. */
export function parseFact(raw: string, lineNumber = 0): Fact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new FactProtocolError(
      `not valid JSON: ${(err as Error).message}`,
      lineNumber,
      raw,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FactProtocolError('expected a JSON object', lineNumber, raw);
  }
  const obj = value as Record<string, unknown>;

  if (obj['v'] !== FACT_PROTOCOL_VERSION) {
    throw new FactProtocolError(
      `unsupported protocol version ${JSON.stringify(obj['v'])}, expected ${FACT_PROTOCOL_VERSION}`,
      lineNumber,
      raw,
    );
  }

  const fail = (msg: string): never => {
    throw new FactProtocolError(msg, lineNumber, raw);
  };
  const str = (field: string): string => {
    const v = obj[field];
    if (typeof v !== 'string' || v.length === 0) {
      return fail(`"${field}" must be a non-empty string`);
    }
    return v;
  };
  const optStr = (field: string): string | undefined => {
    const v = obj[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length === 0) {
      return fail(`"${field}" must be a non-empty string when present`);
    }
    return v;
  };
  const optInt = (field: string): number | undefined => {
    const v = obj[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return fail(`"${field}" must be a non-negative integer when present`);
    }
    return v;
  };
  const optAttrs = (): Record<string, unknown> | undefined => {
    const v = obj['attrs'];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) {
      return fail('"attrs" must be an object when present');
    }
    return v as Record<string, unknown>;
  };
  const nodeRef = (field: string, required: boolean): NodeRef | undefined => {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (required) fail(`"${field}" is required`);
      return undefined;
    }
    if (typeof v !== 'object' || Array.isArray(v)) {
      return fail(`"${field}" must be an object with {kind, fqn}`);
    }
    const ref = v as Record<string, unknown>;
    if (typeof ref['kind'] !== 'string' || !NODE_KIND_SET.has(ref['kind'])) {
      return fail(`"${field}.kind" must be one of ${NODE_KINDS.join('|')}`);
    }
    if (typeof ref['fqn'] !== 'string' || ref['fqn'].length === 0) {
      return fail(`"${field}.fqn" must be a non-empty string`);
    }
    return { kind: ref['kind'] as NodeKind, fqn: ref['fqn'] };
  };

  switch (obj['type']) {
    case 'meta':
      return withDefined<MetaFact>({
        v: FACT_PROTOCOL_VERSION,
        type: 'meta',
        extractor: str('extractor'),
        extractorVersion: str('extractorVersion'),
        repoPath: optStr('repoPath'),
      });

    case 'file':
      return withDefined<FileFact>({
        v: FACT_PROTOCOL_VERSION,
        type: 'file',
        path: str('path'),
        language: str('language'),
        loc: optInt('loc'),
        sha: optStr('sha'),
      });

    case 'node': {
      const kind = str('kind');
      if (!NODE_KIND_SET.has(kind)) {
        fail(`"kind" must be one of ${NODE_KINDS.join('|')}, got "${kind}"`);
      }
      return withDefined<NodeFact>({
        v: FACT_PROTOCOL_VERSION,
        type: 'node',
        kind: kind as NodeKind,
        fqn: str('fqn'),
        name: str('name'),
        parent: nodeRef('parent', false),
        file: optStr('file'),
        startLine: optInt('startLine'),
        endLine: optInt('endLine'),
        attrs: optAttrs(),
      });
    }

    case 'edge': {
      const kind = str('kind');
      if (!EDGE_KIND_SET.has(kind)) {
        fail(`"kind" must be one of ${EDGE_KINDS.join('|')}, got "${kind}"`);
      }
      const confidence = optStr('confidence');
      if (confidence !== undefined && !CONFIDENCE_SET.has(confidence)) {
        fail(`"confidence" must be one of ${CONFIDENCE.join('|')}`);
      }
      return withDefined<EdgeFact>({
        v: FACT_PROTOCOL_VERSION,
        type: 'edge',
        kind: kind as EdgeKind,
        src: nodeRef('src', true) as NodeRef,
        dst: nodeRef('dst', true) as NodeRef,
        file: optStr('file'),
        line: optInt('line'),
        confidence: confidence as Confidence | undefined,
        attrs: optAttrs(),
      });
    }

    case 'diagnostic': {
      const level = str('level');
      if (level !== 'error' && level !== 'warn' && level !== 'info') {
        fail('"level" must be one of error|warn|info');
      }
      return withDefined<DiagnosticFact>({
        v: FACT_PROTOCOL_VERSION,
        type: 'diagnostic',
        level: level as 'error' | 'warn' | 'info',
        message: str('message'),
        file: optStr('file'),
        line: optInt('line'),
      });
    }

    default:
      return fail(`unknown fact type ${JSON.stringify(obj['type'])}`);
  }
}

/**
 * Read NDJSON facts from a stream. Blank lines are skipped; anything else that
 * fails validation throws, because a silently dropped fact is a lie by omission.
 */
export async function* readFacts(stream: Readable): AsyncGenerator<Fact> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    yield parseFact(line, lineNumber);
  }
}

/**
 * Drop undefined-valued keys. An absent optional field and a field explicitly
 * set to undefined are different things under `exactOptionalPropertyTypes`, and
 * only the former should ever reach the store.
 */
function withDefined<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj as T;
}
