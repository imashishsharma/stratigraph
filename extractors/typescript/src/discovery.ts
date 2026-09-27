import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

/**
 * Finding the TypeScript in a repository, per ADR-0016 — the direct analogue of
 * the Java extractor's `SourceDiscovery`.
 *
 * No layout is assumed. We walk for source files rather than globbing
 * `src/app`, because an Angular 2-era application, an Nx workspace and a
 * `projects/*` CLI workspace put their code in three different places and only
 * one of them looks like the tutorial. `package.json` and `tsconfig.json` are
 * read for a name and for path aliases respectively, and for nothing else: no
 * install runs, no build runs, and a repository with neither file is a normal
 * case rather than an error.
 */

/** Sources we parse. `.d.ts` is excluded — it declares types without code. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

export interface ModuleId {
  fqn: string;
  name: string;
}

/**
 * A module and what its build files say about it (ADR-0040): `root`,
 * `buildFile`, `projectType`, and a deployability proof with its citation.
 */
export interface ModuleEntry {
  root: string;
  id: ModuleId;
  attrs: Record<string, unknown>;
}

/** A complaint discovery has about the build files, emitted by the extractor. */
export interface DiscoveryDiagnostic {
  level: 'warn' | 'info';
  message: string;
  file: string;
  line?: number;
}

export interface Discovery {
  /** Every source found, repo-relative and sorted, so output is deterministic. */
  sources: string[];
  /** Every template found, repo-relative and sorted. */
  templates: string[];
  /** Module root (repo-relative, `.` for the root) → identity, deepest first. */
  modules: ModuleEntry[];
  /** Whether an `angular.json` or an Nx `project.json` was found (ADR-0042). */
  workspace: boolean;
  diagnostics: DiscoveryDiagnostic[];
  /** Path aliases from every `tsconfig.json`, merged. Absolute targets. */
  paths: PathAliases;
}

/** `compilerOptions.paths`, flattened to absolute filesystem prefixes. */
export type PathAliases = Map<string, string[]>;

export interface DiscoveryOptions {
  repoRoot: string;
  excludedDirectories: Set<string>;
  includePrefixes: string[];
}

export function discover(options: DiscoveryOptions): Discovery {
  const { repoRoot, excludedDirectories, includePrefixes } = options;

  const sources: string[] = [];
  const templates: string[] = [];
  const manifests: string[] = [];
  const tsconfigs: string[] = [];

  walk(repoRoot, repoRoot, excludedDirectories, (absolute, name) => {
    const rel = toRepoRelative(repoRoot, absolute);
    if (name === 'package.json' || name === 'project.json' || name === 'angular.json') {
      manifests.push(rel);
    } else if (name === 'tsconfig.json' || (name.startsWith('tsconfig.') && name.endsWith('.json'))) {
      tsconfigs.push(rel);
    } else if (!included(rel, includePrefixes)) {
      // Nothing else below here is worth reading, but a manifest or tsconfig
      // outside the include prefixes still names modules and aliases for the
      // sources inside them.
    } else if (name.endsWith('.d.ts')) {
      // Declarations only.
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      sources.push(rel);
    } else if (name.endsWith('.html')) {
      templates.push(rel);
    }
  });

  sources.sort();
  templates.sort();
  manifests.sort();
  tsconfigs.sort();

  const diagnostics: DiscoveryDiagnostic[] = [];
  return {
    sources,
    templates,
    modules: identifyModules(repoRoot, manifests, diagnostics),
    workspace: manifests.some((m) => m.endsWith('angular.json') || m.endsWith('project.json')),
    diagnostics,
    paths: readPathAliases(repoRoot, tsconfigs),
  };
}

/** The module a file belongs to: the nearest module root above it. */
export function moduleOf(discovery: Discovery, repoRelativePath: string): ModuleEntry {
  for (const entry of discovery.modules) {
    const { root } = entry;
    if (root === '.' || repoRelativePath === root || repoRelativePath.startsWith(`${root}/`)) {
      return entry;
    }
  }
  // Sources above every manifest still belong somewhere.
  return (
    discovery.modules[discovery.modules.length - 1] ?? {
      root: '.',
      id: { fqn: '.', name: '.' },
      attrs: { root: '.' },
    }
  );
}

function walk(
  dir: string,
  repoRoot: string,
  excluded: Set<string>,
  visit: (absolutePath: string, name: string) => void,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is not a reason to abandon the repository.
    return;
  }
  // Sorted so that a `readdir` ordering difference between two machines cannot
  // move a line in the golden.
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) walk(absolute, repoRoot, excluded, visit);
    } else if (entry.isFile()) {
      visit(absolute, entry.name);
    }
  }
}

function toRepoRelative(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

function included(repoRelativePath: string, includePrefixes: string[]): boolean {
  return (
    includePrefixes.length === 0 ||
    includePrefixes.some((prefix) => repoRelativePath.startsWith(prefix))
  );
}

/**
 * Module identity from a manifest.
 *
 * `package.json`'s `name` where there is one; Nx's `project.json` `name` next,
 * because most Nx libraries have no `package.json` at all; then the project's
 * key in `angular.json`; otherwise the directory. Deepest first, so a library
 * inside a workspace wins over the workspace root above it — the same rule the
 * Java side applies to a nested Maven module.
 *
 * `angular.json` and `project.json` also say whether a project is an
 * `application` or a `library` (ADR-0040). Both are read with positions, so a
 * deployability proof cites its line. Where both describe one root and
 * disagree, `project.json` wins and the disagreement is reported: in an Nx
 * workspace it is the project's own definition.
 */
function identifyModules(
  repoRoot: string,
  manifests: string[],
  diagnostics: DiscoveryDiagnostic[],
): ModuleEntry[] {
  const byRoot = new Map<string, { id: ModuleId; buildFile: string | null }>();
  const nx = new Map<string, ProjectType>();
  const ng = new Map<string, ProjectType & { project: string }>();
  const angularProjects: ReturnType<typeof readAngularProjects> = [];

  const directoryName = (root: string): string =>
    root === '.' ? (repoRoot.split(sep).pop() ?? '.') : (root.split('/').pop() ?? root);

  for (const manifest of manifests) {
    const slash = manifest.lastIndexOf('/');
    const root = slash === -1 ? '.' : manifest.slice(0, slash);

    if (manifest.endsWith('angular.json')) {
      angularProjects.push(...readAngularProjects(repoRoot, manifest));
      continue;
    }

    const directory = directoryName(root);
    const json = readJson(repoRoot, manifest);
    let name: string | null = null;
    const candidate = json?.['name'];
    if (typeof candidate === 'string' && candidate.length > 0) name = candidate;

    if (manifest.endsWith('project.json')) {
      const type = readProjectType(repoRoot, manifest);
      if (type !== null) nx.set(root, type);
    }

    const existing = byRoot.get(root);
    // `package.json` sorts before `project.json`, so the first name found for a
    // root wins and the Nx file is only consulted when there was no npm one.
    if (existing === undefined || (existing.id.fqn === directory && name !== null)) {
      byRoot.set(root, { id: { fqn: name ?? directory, name: name ?? directory }, buildFile: manifest });
    }
  }

  // After the npm and Nx manifests, so their names win: an angular.json key
  // names only a project root no manifest named.
  for (const project of angularProjects) {
    if (!byRoot.has(project.root)) {
      byRoot.set(project.root, { id: { fqn: project.project, name: project.project }, buildFile: project.file });
    }
    if (project.projectType !== null) ng.set(project.root, { ...project, projectType: project.projectType });
  }

  if (byRoot.size === 0) {
    const name = repoRoot.split(sep).pop() ?? '.';
    byRoot.set('.', { id: { fqn: name, name }, buildFile: null });
  }

  return [...byRoot.entries()]
    .map(([root, { id, buildFile }]) => {
      const attrs: Record<string, unknown> = { root };
      if (buildFile !== null) attrs['buildFile'] = buildFile;

      const fromNx = nx.get(root);
      const fromNg = ng.get(root);
      if (fromNx !== undefined && fromNg !== undefined && fromNx.projectType !== fromNg.projectType) {
        diagnostics.push({
          level: 'warn',
          message:
            `angular.json declares project "${fromNg.project}" an ${fromNg.projectType}, but ` +
            `${fromNx.file} declares it a ${fromNx.projectType}; project.json is taken as the ` +
            `project's own definition (ADR-0040)`,
          file: fromNg.file,
          line: fromNg.line,
        });
      }
      const decided = fromNx ?? fromNg;
      if (decided !== undefined) {
        attrs['projectType'] = decided.projectType;
        if (decided.projectType === 'application') {
          // `angular-app` when angular.json agrees it is an application:
          // that is the file that says the project is built by Angular.
          const proof = fromNg?.projectType === 'application' ? fromNg : decided;
          attrs['deployable'] = proof === fromNg ? 'angular-app' : 'nx-app';
          attrs['deployableFile'] = proof.file;
          attrs['deployableLine'] = proof.line;
          attrs['deployableRule'] =
            proof === fromNg
              ? `angular.json:projects.${fromNg.project}.projectType=application`
              : 'project.json:projectType=application';
        }
      }
      return { root, id, attrs };
    })
    .sort((a, b) => depth(b.root) - depth(a.root) || (a.root < b.root ? -1 : 1));
}

interface ProjectType {
  projectType: string;
  file: string;
  line: number;
}

function readJson(repoRoot: string, manifest: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // An unreadable manifest costs us a module name, not the analysis.
    return null;
  }
}

/**
 * A JSON file parsed with positions. `ts.parseJsonText` is the TypeScript
 * compiler's own JSON reader: it tolerates comments, and every property keeps
 * its offset, which is what a citation needs.
 */
function readJsonWithPositions(
  repoRoot: string,
  manifest: string,
): { source: ts.JsonSourceFile; root: ts.ObjectLiteralExpression } | null {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, manifest), 'utf8');
  } catch {
    return null;
  }
  const source = ts.parseJsonText(manifest, text);
  const statement = source.statements[0];
  if (statement === undefined || !ts.isObjectLiteralExpression(statement.expression)) return null;
  return { source, root: statement.expression };
}

function jsonProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    if ((ts.isStringLiteral(key) || ts.isIdentifier(key)) && key.text === name) return property;
  }
  return null;
}

function jsonString(object: ts.ObjectLiteralExpression, name: string): { value: string; node: ts.Node } | null {
  const property = jsonProperty(object, name);
  if (property === null || !ts.isStringLiteral(property.initializer)) return null;
  return { value: property.initializer.text, node: property };
}

function lineIn(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function readProjectType(repoRoot: string, manifest: string): ProjectType | null {
  const parsed = readJsonWithPositions(repoRoot, manifest);
  if (parsed === null) return null;
  const type = jsonString(parsed.root, 'projectType');
  if (type === null) return null;
  return { projectType: type.value, file: manifest, line: lineIn(parsed.source, type.node) };
}

/** Every project an `angular.json` declares: its root, and its type where stated. */
function readAngularProjects(
  repoRoot: string,
  manifest: string,
): Array<{ project: string; root: string; projectType: string | null; file: string; line: number }> {
  const parsed = readJsonWithPositions(repoRoot, manifest);
  if (parsed === null) return [];
  const projects = jsonProperty(parsed.root, 'projects');
  if (projects === null || !ts.isObjectLiteralExpression(projects.initializer)) return [];

  const slash = manifest.lastIndexOf('/');
  const base = slash === -1 ? '' : manifest.slice(0, slash);
  const out = [];
  for (const property of projects.initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
    const key = property.name;
    if (!ts.isStringLiteral(key) && !ts.isIdentifier(key)) continue;

    const declaredRoot = jsonString(property.initializer, 'root')?.value ?? '';
    const joined = [base, declaredRoot]
      .filter((part) => part.length > 0)
      .join('/')
      .replace(/\/+$/, '');
    const type = jsonString(property.initializer, 'projectType');
    out.push({
      project: key.text,
      root: joined.length === 0 ? '.' : joined,
      projectType: type?.value ?? null,
      file: manifest,
      line: lineIn(parsed.source, type?.node ?? property),
    });
  }
  return out;
}

function depth(root: string): number {
  return root === '.' ? 0 : root.split('/').length;
}

/**
 * `compilerOptions.paths` from every tsconfig in the repository, merged.
 *
 * Read as plain JSON — `ts.parseConfigFileTextToJson` tolerates the comments and
 * trailing commas that real tsconfigs are full of — exactly as ADR-0006 reads a
 * POM as plain XML. `extends` is followed only within the repository, so a
 * config extending `@nx/js/tsconfig.base.json` contributes what it declares
 * itself and nothing from a package we never installed.
 *
 * These matter more than they look: in an Nx workspace `@myorg/data-access` is
 * the only way cross-project imports are ever written, and without the alias
 * every one of them is unresolvable.
 */
function readPathAliases(repoRoot: string, tsconfigs: string[]): PathAliases {
  const aliases: PathAliases = new Map();

  for (const configPath of tsconfigs) {
    const absolute = join(repoRoot, configPath);
    for (const { file, json } of readConfigChain(absolute, repoRoot, new Set())) {
      const compilerOptions = json['compilerOptions'];
      if (typeof compilerOptions !== 'object' || compilerOptions === null) continue;
      const options = compilerOptions as Record<string, unknown>;

      const baseUrl = typeof options['baseUrl'] === 'string' ? options['baseUrl'] : '.';
      const base = resolve(file, '..', baseUrl);

      const paths = options['paths'];
      if (typeof paths !== 'object' || paths === null) continue;
      for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const resolved = targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => resolve(base, t));
        if (resolved.length === 0) continue;
        // First config wins: a project-local alias should not be overwritten by
        // a workspace-root one that happens to be walked later.
        if (!aliases.has(pattern)) aliases.set(pattern, resolved);
      }
    }
  }

  return aliases;
}

function readConfigChain(
  absolute: string,
  repoRoot: string,
  seen: Set<string>,
): Array<{ file: string; json: Record<string, unknown> }> {
  if (seen.has(absolute)) return [];
  seen.add(absolute);

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return [];
  }
  const parsed = ts.parseConfigFileTextToJson(absolute, text);
  if (parsed.error !== undefined || typeof parsed.config !== 'object' || parsed.config === null) {
    return [];
  }
  const json = parsed.config as Record<string, unknown>;
  const chain = [{ file: absolute, json }];

  const extendsValue = json['extends'];
  const parents = typeof extendsValue === 'string' ? [extendsValue] : [];
  for (const parent of parents) {
    // Only relative extends: `@nx/js/tsconfig.base.json` lives in node_modules,
    // which ADR-0016 says we do not require to be there.
    if (!parent.startsWith('.')) continue;
    const parentPath = resolve(absolute, '..', parent.endsWith('.json') ? parent : `${parent}.json`);
    if (!parentPath.startsWith(repoRoot)) continue;
    chain.push(...readConfigChain(parentPath, repoRoot, seen));
  }

  return chain;
}

/** Lines in a file, for the `loc` field on a `file` fact. */
export function countLines(absolutePath: string): number {
  try {
    const text = readFileSync(absolutePath, 'utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/** Whether a path exists and is a directory. Used to validate `--repo`. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
