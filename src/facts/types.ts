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

/**
 * What a build file can prove a module deploys as (ADR-0040), recorded as
 * `attrs.deployable` on a `module` node with `deployableFile`,
 * `deployableLine` and `deployableRule` citing the proof. A `@SpringBootApplication`
 * class proves `spring-boot` too; that proof is its `annotated_with` edge.
 */
export const DEPLOYABLE_KINDS = ['spring-boot', 'war', 'angular-app', 'nx-app'] as const;
export type DeployableKind = (typeof DEPLOYABLE_KINDS)[number];

/** The build-file facts on a `module` node's `attrs`. Every field is optional. */
export interface ModuleAttrs {
  /** The module's directory, repo-relative; `.` for the repository root. */
  root?: string;
  /** The file that named the module. */
  buildFile?: string;
  /** Maven `<packaging>`, when declared. `pom` is never a container. */
  packaging?: string;
  /** Maven `<modules>`, when declared. */
  modules?: string[];
  /** `application` or `library`, from `angular.json` / Nx `project.json`. */
  projectType?: string;
  deployable?: DeployableKind;
  deployableFile?: string;
  deployableLine?: number;
  deployableRule?: string;
}

/**
 * Why a directory is a TypeScript `package` in an Angular workspace
 * (ADR-0042), recorded as `attrs.boundaries: [{ kind, file?, line? }]`.
 */
export const BOUNDARY_KINDS = ['module-root', 'ngmodule', 'lazy-route'] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export const EDGE_KINDS = [
  // Structural containment that is not a tree: a module containing a package
  // that is split across modules (ADR-0041). A tree is `NodeFact.parent`.
  'contains',
  'calls',
  'injects',
  'implements',
  'extends',
  'annotated_with',
  'reads_table',
  'writes_table',
  // A declared mapping between a type and a table (`@Entity` + `@Table`). Not a
  // read and not a write — an ORM mapping says the two correspond, not that
  // anything touched the table.
  'maps_to',
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
