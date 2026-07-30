/**
 * Node identity for TypeScript, per ADR-0017.
 *
 * A Java `import` names a package-qualified type, so ADR-0007 could leave the
 * file out of an `fqn`. A TypeScript `import` names a *file*, and the same class
 * name recurs in every feature directory of a large app — so here the module
 * path is the identity, and leaving it out would merge every `ListComponent` in
 * the repository into one node.
 *
 *   module path   src/app/orders/order.service       (repo-relative, no extension)
 *   type          src/app/orders/order.service:OrderService
 *   member        src/app/orders/order.service:OrderService#find()
 *   free function src/app/core/guards#canActivateAdmin()
 *   directory     src/app/orders
 *   route         /orders/:id
 */

/** Extensions stripped from a module path. Longest first: `.d.ts` before `.ts`. */
const EXTENSIONS = ['.d.ts', '.tsx', '.mts', '.cts', '.ts', '.jsx', '.mjs', '.cjs', '.js'];

/** The repo-relative path of a file with its extension removed. */
export function modulePath(repoRelativePath: string): string {
  const path = repoRelativePath.replace(/\\/g, '/');
  for (const ext of EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

/** The `package` fqn for the directory a file sits in; the repo root is `.`. */
export function directoryOf(repoRelativePath: string): string {
  const path = repoRelativePath.replace(/\\/g, '/');
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

/**
 * A type declared in a module. `name` carries any enclosing namespace, dotted
 * (`Api.Client`) — `$` would be a lie here, since there is no binary name.
 */
export function typeFqn(modulePath: string, name: string): string {
  return `${modulePath}:${name}`;
}

/** A property or parameter property. `owner` is a type or module fqn. */
export function fieldFqn(owner: string, name: string): string {
  return `${owner}#${name}`;
}

/**
 * A method, or a module-level function whose `owner` is a module path.
 *
 * No parameters, unlike ADR-0007's Java scheme: TypeScript overload signatures
 * share one implementation, so there are never two things to tell apart.
 */
export function methodFqn(owner: string, name: string): string {
  return `${owner}#${name}()`;
}

/**
 * A route path, resolved through its ancestors.
 *
 * Angular writes segments without leading slashes and uses `''` for the empty
 * path, so joining is string work rather than URL work: drop empties, collapse
 * duplicate slashes, keep `:id` and `**` exactly as declared so the result reads
 * next to a Spring endpoint pattern.
 */
export function routeFqn(segments: readonly string[]): string {
  const joined = segments
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}

/** The display name of a route: its own segment, or `/` at the root. */
export function routeName(fqn: string): string {
  const slash = fqn.lastIndexOf('/');
  const last = fqn.slice(slash + 1);
  return last.length > 0 ? last : '/';
}
