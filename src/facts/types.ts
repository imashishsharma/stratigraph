/**
 * The fact vocabulary.
 *
 * Everything in here is produced by a parser, by `git log`, or by a build file.
 * Nothing in here is produced by a model. Interpretation lives in a separate
 * vocabulary (see the `cluster` / `finding` tables) and is always marked as
 * inference.
 */

export const FACT_PROTOCOL_VERSION = 1;

export const NODE_KINDS = [
  'module', // a build module (maven/gradle project, npm package)
  'package', // java package / ts directory namespace
  'file',
  'class',
  'interface',
  'enum',
  'annotation',
  'method',
  'field',
  'endpoint', // an HTTP route served by the backend
  'table', // a database table
  'component', // angular component
  'service', // angular/spring injectable service
  'route', // angular route
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  'contains', // structural containment: package contains class, class contains method
  'calls',
  'injects',
  'implements',
  'extends',
  'annotated_with',
  'reads_table',
  'writes_table',
  'http_calls', // a client calls an HTTP endpoint
  'handles', // a method handles an endpoint
  'imports',
  'declares_route',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * `fact` — the extractor saw it in the source, and can point at file+line.
 * `inferred` — derived by matching (e.g. an Angular URL string against a Spring
 * endpoint pattern). Never presented to a user as if it were observed.
 */
export const CONFIDENCE = ['fact', 'inferred'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** How an extractor refers to a node it did not necessarily emit itself. */
export interface NodeRef {
  kind: NodeKind;
  /** Fully-qualified name. Unique per (run, kind). The extractor owns this identity. */
  fqn: string;
}

interface BaseFact {
  v: typeof FACT_PROTOCOL_VERSION;
}

/** First line an extractor emits. Identifies who is talking. */
export interface MetaFact extends BaseFact {
  type: 'meta';
  extractor: string;
  extractorVersion: string;
  /** Absolute path of the repository the extractor was pointed at. */
  repoPath?: string;
}

export interface FileFact extends BaseFact {
  type: 'file';
  /** Repo-relative, forward slashes. */
  path: string;
  language: string;
  loc?: number;
  /** Blob sha or content hash, if the extractor computed one. */
  sha?: string;
}

export interface NodeFact extends BaseFact {
  type: 'node';
  kind: NodeKind;
  fqn: string;
  name: string;
  parent?: NodeRef;
  /** Repo-relative path of the file this was observed in. Absent for synthetic nodes like packages. */
  file?: string;
  startLine?: number;
  endLine?: number;
  attrs?: Record<string, unknown>;
}

export interface EdgeFact extends BaseFact {
  type: 'edge';
  kind: EdgeKind;
  src: NodeRef;
  dst: NodeRef;
  file?: string;
  line?: number;
  /** Defaults to 'fact'. An extractor must set 'inferred' explicitly. */
  confidence?: Confidence;
  attrs?: Record<string, unknown>;
}

/** Out-of-band complaint from an extractor: unparseable file, unresolved type, etc. */
export interface DiagnosticFact extends BaseFact {
  type: 'diagnostic';
  level: 'error' | 'warn' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export type Fact = MetaFact | FileFact | NodeFact | EdgeFact | DiagnosticFact;
export type FactType = Fact['type'];
