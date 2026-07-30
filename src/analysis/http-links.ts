import type { Db } from '../db/database.js';

/**
 * Cross-stack links: an Angular HTTP call matched to a Spring endpoint.
 *
 * Every rule here, and every refusal, is ADR-0018. The short version: this is
 * the only place in the store where an edge comes from comparing two strings
 * rather than from a parser reading a declaration, so every edge it writes
 * carries `confidence = 'inferred'` and every case it cannot decide writes a
 * diagnostic instead of a guess.
 */

/** An HTTP call the TypeScript extractor observed, read back off a method node. */
interface ObservedCall {
  nodeId: number;
  nodeFqn: string;
  fileId: number | null;
  /** Repo-relative path, for the report's citation. */
  file: string | null;
  method: string;
  /** URL as declared, with each interpolated segment already reduced to `{}`. */
  url: string;
  line: number;
}

interface EndpointPattern {
  id: number;
  fqn: string;
  method: string;
  segments: string[];
  /** How many segments are wildcards. Fewer is more specific. */
  wildcards: number;
  trailingWildcard: boolean;
}

/** One inferred link, with both sides of the comparison, for the report. */
export interface LinkedCall {
  /** `GET /api/orders/{}` — the URL as the client declared it. */
  observed: string;
  /** `GET /api/orders/{id}` — the endpoint fqn it was matched to. */
  endpoint: string;
  /** The method that makes the call. */
  caller: string;
  file: string | null;
  line: number;
}

export interface LinkResult {
  /** Edges written. */
  linked: number;
  /** The links themselves, so a reader can check one without a query. */
  calls: LinkedCall[];
  /** Calls whose URL matched two endpoints equally well; no edge written. */
  ambiguous: number;
  /** Calls whose URL matched no endpoint. Usually a third-party service. */
  unmatched: number;
  /** True when the run has no endpoints at all, so nothing could be matched. */
  noEndpoints: boolean;
}

/**
 * Match every observed call in a run and write the edges.
 *
 * Idempotent: `edge_identity_idx` covers (run, kind, src, dst, file, line), so
 * a second `analyze` bumps the weight of an existing edge rather than
 * duplicating it, and the counts below report what was matched, not what was
 * inserted.
 */
export function linkHttpCalls(db: Db, runId: number): LinkResult {
  const endpoints = loadEndpoints(db, runId);
  const calls = loadCalls(db, runId);

  const result: LinkResult = {
    linked: 0,
    calls: [],
    ambiguous: 0,
    unmatched: 0,
    noEndpoints: endpoints.length === 0,
  };
  if (calls.length === 0) return result;
  if (endpoints.length === 0) {
    // Every call goes unmatched, and it matters that the count is not zero:
    // "nothing matched" and "nothing to match against" must not read the same,
    // and `summariseLinks` needs a number to say so with. This is the shape of
    // a run holding only the Angular half of a full-stack repository.
    result.unmatched = calls.length;
    return result;
  }

  const insertEdge = db.prepare(
    `INSERT INTO edge (run_id, kind, src_id, dst_id, file_id, line, confidence, extractor, attrs)
     VALUES (@runId, 'http_calls', @srcId, @dstId, @fileId, @line, 'inferred', 'http-links', @attrs)
     ON CONFLICT (run_id, kind, src_id, dst_id, ifnull(file_id, -1), ifnull(line, -1))
       DO UPDATE SET weight = weight + 1`,
  );
  const insertDiagnostic = db.prepare(
    `INSERT INTO diagnostic (run_id, extractor, level, message, file_id, line)
     VALUES (@runId, 'http-links', @level, @message, @fileId, @line)`,
  );

  const write = db.transaction((): void => {
    for (const call of calls) {
      const candidates = matchesFor(call, endpoints);

      if (candidates.length === 0) {
        // Almost always a call to a service outside this repository. Not a
        // defect, and not worth a line of output per occurrence.
        result.unmatched += 1;
        continue;
      }

      if (candidates.length > 1) {
        result.ambiguous += 1;
        insertDiagnostic.run({
          runId,
          level: 'warn',
          message:
            `${call.method} ${call.url} matches ${candidates.length} endpoints equally well ` +
            `(${candidates.map((c) => c.fqn).join(', ')}); no http_calls edge recorded — ` +
            `which one is called cannot be told from the URL`,
          fileId: call.fileId,
          line: call.line,
        });
        continue;
      }

      const endpoint = candidates[0]!;
      insertEdge.run({
        runId,
        srcId: call.nodeId,
        dstId: endpoint.id,
        fileId: call.fileId,
        line: call.line,
        // Both sides of the comparison, so a reader can check the inference
        // without re-deriving it. This is what makes M5's acceptance criterion
        // checkable by hand.
        attrs: JSON.stringify({
          observed: `${call.method} ${call.url}`,
          endpoint: endpoint.fqn,
          matchedBy: 'url-pattern',
        }),
      });
      result.linked += 1;
      result.calls.push({
        observed: `${call.method} ${call.url}`,
        endpoint: endpoint.fqn,
        caller: call.nodeFqn,
        file: call.file,
        line: call.line,
      });
    }
  });
  write();

  return result;
}

/**
 * Candidates for one call, narrowed to the most specific.
 *
 * "Most specific wins" is the same rule Spring's own `AntPathMatcher` applies at
 * runtime, so the tool agrees with the framework rather than inventing a policy.
 * Anything still tied after that is genuinely undecidable and the caller refuses.
 */
function matchesFor(call: ObservedCall, endpoints: EndpointPattern[]): EndpointPattern[] {
  const segments = splitPath(call.url);
  const matched = endpoints.filter(
    (endpoint) =>
      methodMatches(call.method, endpoint.method) && pathMatches(segments, endpoint),
  );
  if (matched.length <= 1) return matched;

  const best = Math.min(...matched.map((endpoint) => endpoint.wildcards));
  return matched.filter((endpoint) => endpoint.wildcards === best);
}

/**
 * `ANY` is what the Java extractor emits for a `@RequestMapping` with no method
 * element — the endpoint really does serve every verb, so it matches every one.
 */
function methodMatches(observed: string, declared: string): boolean {
  return declared === 'ANY' || declared === observed;
}

function pathMatches(segments: string[], endpoint: EndpointPattern): boolean {
  if (endpoint.trailingWildcard) {
    // `/api/**` matches any remainder, but must still match the prefix.
    if (segments.length < endpoint.segments.length - 1) return false;
    return endpoint.segments
      .slice(0, -1)
      .every((declared, index) => segmentMatches(segments[index]!, declared));
  }
  if (segments.length !== endpoint.segments.length) return false;
  return endpoint.segments.every((declared, index) =>
    segmentMatches(segments[index]!, declared),
  );
}

/**
 * One segment against one declared segment.
 *
 * A wildcard on either side matches any single segment: Spring's `{id}` because
 * it is a path variable, and the client's `{}` because that is what an
 * interpolated expression was reduced to. Two literals must be equal — this is
 * where the whole approach either holds or turns into fuzzy matching, so it is
 * exact, case-sensitively, with no normalisation beyond what `splitPath` did.
 */
function segmentMatches(observed: string, declared: string): boolean {
  if (isWildcard(declared) || isWildcard(observed)) return true;
  return observed === declared;
}

function isWildcard(segment: string): boolean {
  return segment === '{}' || segment === '*' || (segment.startsWith('{') && segment.endsWith('}'));
}

/**
 * A path reduced to comparable segments.
 *
 * The query string and any trailing slash go: neither is part of what a
 * `@GetMapping` declares, and keeping them would fail every match on a call that
 * happens to pass a parameter. A whole interpolated segment (`${id}` alone
 * between two slashes) has already become `{}`; one that is only *part* of a
 * segment (`order-{}`) stays as it is and will only match a wildcard, which is
 * the conservative direction.
 */
function splitPath(path: string): string[] {
  const withoutQuery = path.split('?')[0] ?? path;
  return withoutQuery.split('/').filter((segment) => segment.length > 0);
}

function loadEndpoints(db: Db, runId: number): EndpointPattern[] {
  const rows = db
    .prepare(`SELECT id, fqn FROM node WHERE run_id = ? AND kind = 'endpoint'`)
    .all(runId) as Array<{ id: number; fqn: string }>;

  return rows.flatMap((row) => {
    // ADR-0007: an endpoint fqn is `<HTTP-METHOD> <path>`.
    const space = row.fqn.indexOf(' ');
    if (space === -1) return [];
    const method = row.fqn.slice(0, space);
    const segments = splitPath(row.fqn.slice(space + 1));
    return [
      {
        id: row.id,
        fqn: row.fqn,
        method,
        segments,
        wildcards: segments.filter(isWildcard).length,
        trailingWildcard: segments[segments.length - 1] === '**',
      },
    ];
  });
}

/**
 * Every HTTP call the TypeScript extractor observed.
 *
 * They live in `node.attrs` rather than in edges because at the moment of
 * observation there was nothing to point an edge at — see the reasoning on
 * `AngularFacts.callSites`. The `LIKE` narrows the scan before the JSON is
 * parsed; on a large repository almost no method has this key.
 */
function loadCalls(db: Db, runId: number): ObservedCall[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.fqn, n.file_id, f.path, n.attrs
         FROM node n
         LEFT JOIN source_file f ON f.id = n.file_id
        WHERE n.run_id = ? AND n.kind = 'method' AND n.attrs LIKE '%"httpCalls"%'
        ORDER BY n.id`,
    )
    .all(runId) as Array<{
    id: number;
    fqn: string;
    file_id: number | null;
    path: string | null;
    attrs: string;
  }>;

  const calls: ObservedCall[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.attrs);
    } catch {
      continue;
    }
    const observed = (parsed as Record<string, unknown>)['httpCalls'];
    if (!Array.isArray(observed)) continue;

    for (const entry of observed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { method, url, line } = entry as Record<string, unknown>;
      if (typeof method !== 'string' || typeof url !== 'string') continue;
      calls.push({
        nodeId: row.id,
        nodeFqn: row.fqn,
        fileId: row.file_id,
        file: row.path,
        method,
        url,
        line: typeof line === 'number' ? line : 0,
      });
    }
  }
  return calls;
}

/** One line for `analyze`, or null when this run has nothing to say about it. */
export function summariseLinks(result: LinkResult): string | null {
  if (result.linked === 0 && result.ambiguous === 0 && result.unmatched === 0) {
    return null;
  }
  if (result.noEndpoints) {
    // The distinction ADR-0016 insists on everywhere: nothing found, versus
    // nothing looked at.
    return `${result.unmatched} HTTP call(s) observed, but this run has no endpoints to match them against`;
  }
  const parts = [`${result.linked} HTTP call(s) linked to an endpoint (inferred)`];
  if (result.ambiguous > 0) parts.push(`${result.ambiguous} ambiguous`);
  if (result.unmatched > 0) parts.push(`${result.unmatched} matched nothing`);
  return parts.join(', ');
}
