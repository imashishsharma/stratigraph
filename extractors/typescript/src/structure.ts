import { join, relative, sep } from 'node:path';

import ts from 'typescript';

import { CLASS_DECORATORS, exportedName, isAngular } from './angular.js';
import { moduleOf, type Discovery } from './discovery.js';
import { directoryOf } from './fqn.js';
import type { Resolver } from './program.js';

/**
 * What a TypeScript `package` is (ADR-0042).
 *
 * In an Angular workspace a package is the nearest **boundary directory**
 * above a file — a module root, a directory holding an `@NgModule`, or the
 * directory a lazy route's dynamic import lands in — rather than the file's own
 * directory. Everywhere else it is the directory, as ADR-0017 had it.
 *
 * Boundaries are found in a pass over every source before any fact is emitted,
 * because a file's package depends on files it does not import: the NgModule
 * one directory up, the route table that lazy-loads it.
 */

export type BoundaryKind = 'module-root' | 'ngmodule' | 'lazy-route';

export interface Boundary {
  kind: BoundaryKind;
  file?: string;
  line?: number;
}

export interface PackageSpec {
  fqn: string;
  name: string;
  attrs?: Record<string, unknown>;
}

const LAZY_KEYS = new Set(['loadChildren', 'loadComponent']);

export class PackageStructure {
  /** True when packages are boundaries rather than directories. */
  readonly grouped: boolean;
  private readonly boundaries = new Map<string, Boundary[]>();

  constructor(
    private readonly repoRoot: string,
    program: ts.Program,
    resolver: Resolver,
    private readonly discovery: Discovery,
  ) {
    const internal = new Set(discovery.sources);
    let angular = false;

    for (const path of discovery.sources) {
      const source = program.getSourceFile(join(repoRoot, path));
      if (source === undefined) continue;

      for (const statement of source.statements) {
        if (!ts.isClassDeclaration(statement)) continue;
        for (const decorator of ts.getDecorators(statement) ?? []) {
          const expression = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression;
          const resolved = resolver.resolve(expression);
          if (resolved === null || !isAngular(resolved.ref.fqn)) continue;
          const name = exportedName(resolved.ref.fqn);
          if (!CLASS_DECORATORS.has(name)) continue;
          angular = true;
          if (name === 'NgModule') {
            this.add(directoryOf(path), { kind: 'ngmodule', file: path, line: lineOf(source, decorator) });
          }
        }
      }

      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && LAZY_KEYS.has(propertyName(node))) {
          const specifier = dynamicImportOf(node.initializer);
          if (specifier !== null) {
            const target = this.resolveModule(specifier, source.fileName, program.getCompilerOptions());
            if (target !== null && internal.has(target)) {
              this.add(directoryOf(target), { kind: 'lazy-route', file: path, line: lineOf(source, node) });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    this.grouped = discovery.workspace || angular;
  }

  /** The package a source file belongs to. */
  packageOf(path: string): PackageSpec {
    const directory = directoryOf(path);
    if (!this.grouped) {
      return { fqn: directory, name: lastSegment(directory) };
    }

    const module = moduleOf(this.discovery, path);
    let dir = directory;
    for (;;) {
      if (dir === module.root || dir === '.') break;
      if (this.boundaries.has(dir)) {
        return { fqn: dir, name: lastSegment(dir), attrs: { boundaries: this.boundaries.get(dir) } };
      }
      dir = directoryOf(dir);
    }

    // No boundary between the file and its module root: the module root's
    // package. A file above every manifest lands in the fallback module's.
    const root = module.root;
    const buildFile = module.attrs['buildFile'];
    const own: Boundary = typeof buildFile === 'string' ? { kind: 'module-root', file: buildFile } : { kind: 'module-root' };
    return {
      fqn: root,
      name: module.id.name,
      attrs: { boundaries: [own, ...(this.boundaries.get(root) ?? [])] },
    };
  }

  private add(dir: string, boundary: Boundary): void {
    const list = this.boundaries.get(dir) ?? [];
    list.push(boundary);
    this.boundaries.set(dir, list);
  }

  private resolveModule(specifier: string, containingFile: string, options: ts.CompilerOptions): string | null {
    const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule;
    if (resolved === undefined) return null;
    return relative(this.repoRoot, resolved.resolvedFileName).split(sep).join('/');
  }
}

function propertyName(node: ts.PropertyAssignment): string {
  const key = node.name;
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '';
}

/** The specifier of the first `import('…')` inside an expression. */
function dynamicImportOf(expression: ts.Node): string | null {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) found = arg.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function lastSegment(directory: string): string {
  return directory === '.' ? '.' : (directory.split('/').pop() ?? directory);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
