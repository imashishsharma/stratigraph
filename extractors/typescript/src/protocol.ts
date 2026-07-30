/**
 * The extractor's half of the NDJSON protocol (ADR-0003).
 *
 * Deliberately a local definition rather than an import from the core, for the
 * same reason `FactEmitter.java` hand-writes its JSON: an extractor knows the
 * wire format and nothing else. The core's `src/facts/ndjson.ts` validates every
 * line it receives, and `test/ts-extractor-protocol.test.ts` replays this
 * extractor's whole golden through that validator — so the contract is checked
 * against the real parser rather than kept in step by a shared type.
 */

export const FACT_PROTOCOL_VERSION = 1;

export type NodeKind =
  | 'module'
  | 'package'
  | 'file'
  | 'class'
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'method'
  | 'field'
  | 'endpoint'
  | 'table'
  | 'component'
  | 'service'
  | 'route';

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'injects'
  | 'implements'
  | 'extends'
  | 'annotated_with'
  | 'reads_table'
  | 'writes_table'
  | 'maps_to'
  | 'http_calls'
  | 'handles'
  | 'imports'
  | 'declares_route';

export type Confidence = 'fact' | 'inferred';

export interface NodeRef {
  kind: NodeKind;
  fqn: string;
}

export interface NodeSpec {
  kind: NodeKind;
  fqn: string;
  name: string;
  parent?: NodeRef;
  file?: string;
  startLine?: number;
  endLine?: number;
  attrs?: Record<string, unknown>;
}

export interface EdgeSpec {
  kind: EdgeKind;
  src: NodeRef;
  dst: NodeRef;
  file?: string;
  line?: number;
  confidence?: Confidence;
  attrs?: Record<string, unknown>;
}

export type Level = 'error' | 'warn' | 'info';

/** Somewhere to write a line. `process.stdout` in production, an array in tests. */
export interface LineSink {
  write(line: string): void;
}

export class FactEmitter {
  private files = 0;
  private nodes = 0;
  private edges = 0;
  private diagnostics = 0;

  /** `kind fqn` of every node already emitted, so a package is declared once. */
  private readonly declared = new Set<string>();

  constructor(private readonly sink: LineSink) {}

  meta(extractor: string, extractorVersion: string, repoPath: string): void {
    this.emit({ type: 'meta', extractor, extractorVersion, repoPath });
  }

  file(path: string, language: string, loc: number): void {
    this.files += 1;
    this.emit({ type: 'file', path, language, loc });
  }

  /** Returns false when this node was already declared, so callers can skip work. */
  node(spec: NodeSpec): boolean {
    const key = `${spec.kind} ${spec.fqn}`;
    if (this.declared.has(key)) return false;
    this.declared.add(key);
    this.nodes += 1;
    this.emit({ type: 'node', ...spec });
    return true;
  }

  has(kind: NodeKind, fqn: string): boolean {
    return this.declared.has(`${kind} ${fqn}`);
  }

  edge(spec: EdgeSpec): void {
    this.edges += 1;
    this.emit({ type: 'edge', ...spec });
  }

  diagnostic(level: Level, message: string, file?: string, line?: number): void {
    this.diagnostics += 1;
    this.emit(dropUndefined({ type: 'diagnostic', level, message, file, line }));
  }

  summary(): string {
    return (
      `emitted ${this.files} file(s), ${this.nodes} node(s), ${this.edges} edge(s), ` +
      `${this.diagnostics} diagnostic(s)`
    );
  }

  private emit(fact: Record<string, unknown>): void {
    // `v` first so a truncated line is still recognisable as ours.
    this.sink.write(JSON.stringify({ v: FACT_PROTOCOL_VERSION, ...dropUndefined(fact) }));
  }
}

/**
 * An absent optional field and one explicitly set to `undefined` serialise the
 * same way through `JSON.stringify`, but building the object without the key at
 * all is what keeps the golden stable when a caller passes `undefined`.
 */
function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
