/**
 * Path scoping, matching the Java extractor exactly.
 *
 * ADR-0011 requires history to cover the same files as extraction, so that the
 * two halves of a report describe the same repository. That only holds if both
 * sides read `include` and `exclude` the same way, and the Java extractor
 * (`SourceDiscovery`) reads them as: exclude is a set of **directory names**
 * pruned at any depth, include is a list of repo-relative **path prefixes**.
 */
export interface PathScope {
  exclude: ReadonlySet<string>;
  include: readonly string[];
}

export function pathScope(exclude: readonly string[], include: readonly string[]): PathScope {
  return { exclude: new Set(exclude), include };
}

/**
 * Repo-relative path, forward slashes.
 *
 * Excludes match directory segments only, never the filename — so a file
 * called `build` is kept while a directory called `build` is pruned, which is
 * what pruning a walk does and therefore what the extractor does.
 */
export function inScope(path: string, scope: PathScope): boolean {
  if (scope.exclude.size > 0) {
    const segments = path.split('/');
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (scope.exclude.has(segments[i] as string)) return false;
    }
  }
  if (scope.include.length === 0) return true;
  return scope.include.some((prefix) => path.startsWith(prefix));
}
