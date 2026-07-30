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

export interface Discovery {
  /** Every source found, repo-relative and sorted, so output is deterministic. */
  sources: string[];
  /** Every template found, repo-relative and sorted. */
  templates: string[];
  /** Module root (repo-relative, `.` for the root) → identity, deepest first. */
  modules: Array<{ root: string; id: ModuleId }>;
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
    if (name === 'package.json' || name === 'project.json') {
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

  return {
    sources,
    templates,
    modules: identifyModules(repoRoot, manifests),
    paths: readPathAliases(repoRoot, tsconfigs),
  };
}

/** The module a file belongs to: the nearest module root above it. */
export function moduleOf(discovery: Discovery, repoRelativePath: string): ModuleId {
  for (const { root, id } of discovery.modules) {
    if (root === '.' || repoRelativePath === root || repoRelativePath.startsWith(`${root}/`)) {
      return id;
    }
  }
  // Sources above every manifest still belong somewhere.
  return discovery.modules[discovery.modules.length - 1]?.id ?? { fqn: '.', name: '.' };
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
 * because most Nx libraries have no `package.json` at all; otherwise the
 * directory. Deepest first, so a library inside a workspace wins over the
 * workspace root above it — the same rule the Java side applies to a nested
 * Maven module.
 */
function identifyModules(repoRoot: string, manifests: string[]): Discovery['modules'] {
  const byRoot = new Map<string, ModuleId>();

  for (const manifest of manifests) {
    const slash = manifest.lastIndexOf('/');
    const root = slash === -1 ? '.' : manifest.slice(0, slash);
    const directory = root === '.' ? (repoRoot.split(sep).pop() ?? '.') : (root.split('/').pop() ?? root);

    let name: string | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = (parsed as Record<string, unknown>)['name'];
        if (typeof candidate === 'string' && candidate.length > 0) name = candidate;
      }
    } catch {
      // An unreadable manifest costs us a module name, not the analysis.
    }

    const existing = byRoot.get(root);
    // `package.json` sorts before `project.json`, so the first name found for a
    // root wins and the Nx file is only consulted when there was no npm one.
    if (existing === undefined || (existing.fqn === directory && name !== null)) {
      byRoot.set(root, { fqn: name ?? directory, name: name ?? directory });
    }
  }

  if (byRoot.size === 0) {
    const name = repoRoot.split(sep).pop() ?? '.';
    byRoot.set('.', { fqn: name, name });
  }

  return [...byRoot.entries()]
    .map(([root, id]) => ({ root, id }))
    .sort((a, b) => depth(b.root) - depth(a.root) || (a.root < b.root ? -1 : 1));
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
