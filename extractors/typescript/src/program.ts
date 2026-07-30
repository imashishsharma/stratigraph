import { join, relative, sep } from 'node:path';

import ts from 'typescript';

import type { Discovery, PathAliases } from './discovery.js';
import { modulePath, typeFqn } from './fqn.js';
import type { NodeKind, NodeRef } from './protocol.js';

/**
 * One `ts.Program` over every discovered source (ADR-0016), and the resolver
 * that turns a name in a file into a node reference.
 *
 * The program is built from the filesystem walk rather than from a
 * `tsconfig.json`, and never from one program per project: that is what lets a
 * component in `apps/web` resolve a service in `libs/data-access` on a workspace
 * nobody has installed or built. Program diagnostics are not consulted — a
 * repository that does not type-check still yields its structure.
 *
 * The checker earns its cost on one case in particular. Angular monorepos import
 * through barrels (`import { UserService } from '@myorg/core'`, where `@myorg/core`
 * is an `index.ts` re-exporting from three directories down). Following the
 * import statement alone would land on the barrel and mint a node the class is
 * not declared in; the checker follows the alias chain to the real declaration,
 * which is the difference between a DI graph that is right and one that looks
 * right.
 */

export interface Resolved {
  ref: NodeRef;
  /** True when the declaration is outside the parsed source set. */
  external: boolean;
  /** How the name was resolved, recorded on the edge as ADR-0005 does for Java. */
  resolution: 'checker' | 'import';
}

export function createProgram(repoRoot: string, discovery: Discovery): ts.Program {
  const options: ts.CompilerOptions = {
    allowJs: false,
    noEmit: true,
    noResolve: false,
    skipLibCheck: true,
    // Angular's decorators are the legacy form; without this, TypeScript parses
    // them under the ES decorator proposal and a `@Component({...})` call
    // expression comes out shaped differently.
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // Node10 rather than Bundler: it is what the Angular CLI has always
    // configured, and it resolves `./order.service` to `order.service.ts` on
    // repositories far older than `exports` maps.
    moduleResolution: ts.ModuleResolutionKind.Node10,
    baseUrl: repoRoot,
    paths: aliasesRelativeTo(repoRoot, discovery.paths),
    allowNonTsExtensions: true,
  };

  const host = ts.createCompilerHost(options, /* setParentNodes */ true);
  return ts.createProgram(
    discovery.sources.map((source) => join(repoRoot, source)),
    options,
    host,
  );
}

/**
 * `compilerOptions.paths` wants patterns relative to `baseUrl`; discovery
 * resolved them to absolute filesystem paths so that a `tsconfig.json` three
 * directories down still means what it said.
 */
function aliasesRelativeTo(repoRoot: string, aliases: PathAliases): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [pattern, targets] of aliases) {
    out[pattern] = targets.map((target) => {
      const rel = relative(repoRoot, target).split(sep).join('/');
      return rel.length === 0 ? '.' : rel;
    });
  }
  return out;
}

export class Resolver {
  private readonly checker: ts.TypeChecker;
  /** Absolute file name → true when the file is part of the parsed source set. */
  private readonly internal: Set<string>;

  constructor(
    private readonly repoRoot: string,
    program: ts.Program,
    discovery: Discovery,
  ) {
    this.checker = program.getTypeChecker();
    this.internal = new Set(discovery.sources.map((source) => normalise(join(repoRoot, source))));
  }

  /**
   * Resolve an identifier or qualified name used as a type or a value.
   *
   * Returns null when nothing resolves. That is the important case and it must
   * stay a null: an unresolved name means "we could not see what this refers
   * to", and the caller's job is then to record a diagnostic rather than to
   * name something plausible.
   */
  resolve(node: ts.Node): Resolved | null {
    const symbol = this.symbolAt(node);
    if (symbol === undefined) return this.fromImportStatement(node);

    const declaration = declarationOf(symbol);
    if (declaration === undefined) return this.fromImportStatement(node);

    const fileName = normalise(declaration.getSourceFile().fileName);
    const kind = kindOfDeclaration(declaration);
    if (kind === null) return null;

    if (this.internal.has(fileName)) {
      const rel = relative(this.repoRoot, fileName).split(sep).join('/');
      return {
        ref: { kind, fqn: typeFqn(modulePath(rel), qualifiedName(declaration, symbol)) },
        external: false,
        resolution: 'checker',
      };
    }

    // Declared outside the source set — a library `.d.ts`, or a lib file. Named
    // by the module it came from, so `@angular/common/http:HttpClient` reads the
    // way the import that introduced it does. It becomes a stub node in the
    // store: we recorded that something depends on it, not what it contains.
    const specifier = moduleSpecifierOf(declaration) ?? this.specifierFromImport(node);
    if (specifier === null) return null;
    return {
      ref: { kind, fqn: typeFqn(specifier, symbol.getName()) },
      external: true,
      resolution: 'checker',
    };
  }

  /**
   * Fallback for when the checker resolves nothing — which on an uninstalled
   * repository is every single library type. The import statement is still
   * right there in the file and says exactly where the name came from, so we
   * use it, and mark the edge `resolution: "import"` the way ADR-0005 does on
   * the Java side.
   *
   * The kind is `class` because that is what an injectable or a decorated
   * declaration is; nothing downstream distinguishes a stubbed class from a
   * stubbed interface, and guessing `interface` from a naming convention would
   * be inventing a fact.
   */
  private fromImportStatement(node: ts.Node): Resolved | null {
    const found = this.importBinding(node);
    if (found === null) return null;
    return {
      ref: { kind: 'class', fqn: typeFqn(found.specifier, found.exported) },
      external: true,
      resolution: 'import',
    };
  }

  private specifierFromImport(node: ts.Node): string | null {
    return this.importBinding(node)?.specifier ?? null;
  }

  /** The import that introduced the leftmost name of `node`, if any. */
  private importBinding(node: ts.Node): { specifier: string; exported: string } | null {
    const root = rootIdentifier(node);
    if (root === null) return null;
    const source = root.getSourceFile();
    const wanted = root.text;

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) continue;

      if (clause.name !== undefined && clause.name.text === wanted) {
        return { specifier, exported: 'default' };
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        if (bindings.name.text === wanted) return { specifier, exported: wanted };
        continue;
      }
      for (const element of bindings.elements) {
        if (element.name.text === wanted) {
          return { specifier, exported: (element.propertyName ?? element.name).text };
        }
      }
    }
    return null;
  }

  private symbolAt(node: ts.Node): ts.Symbol | undefined {
    const target = rootTarget(node);
    let symbol = this.checker.getSymbolAtLocation(target);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        symbol = this.checker.getAliasedSymbol(symbol);
      } catch {
        // A broken alias chain is a repository that does not compile, which
        // ADR-0016 says is a normal input. Keep the unaliased symbol.
      }
    }
    return symbol;
  }
}

/** The declaration a symbol names, preferring one that declares a type. */
function declarationOf(symbol: ts.Symbol): ts.Declaration | undefined {
  const declarations = symbol.getDeclarations();
  if (declarations === undefined || declarations.length === 0) return undefined;
  return declarations.find((d) => kindOfDeclaration(d) !== null) ?? declarations[0];
}

function kindOfDeclaration(declaration: ts.Declaration): NodeKind | null {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return 'class';
  if (ts.isInterfaceDeclaration(declaration)) return 'interface';
  if (ts.isEnumDeclaration(declaration)) return 'enum';
  // A library type we only ever see through its `.d.ts` may be a variable
  // declaration of an interface type (`declare const Foo: FooCtor`). Treated as
  // a class for the reason given on `fromImportStatement`.
  if (ts.isVariableDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    return 'class';
  }
  return null;
}

/** `Api.Client` for a class nested in a namespace; the bare name otherwise. */
function qualifiedName(declaration: ts.Declaration, symbol: ts.Symbol): string {
  const parts: string[] = [symbol.getName()];
  let parent: ts.Node | undefined = declaration.parent;
  while (parent !== undefined) {
    if (ts.isModuleDeclaration(parent) && ts.isIdentifier(parent.name)) {
      parts.unshift(parent.name.text);
    }
    parent = parent.parent;
  }
  return parts.join('.');
}

/** The `'@angular/core'` of the ambient module a declaration sits in. */
function moduleSpecifierOf(declaration: ts.Declaration): string | null {
  let parent: ts.Node | undefined = declaration.parent;
  while (parent !== undefined) {
    if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name)) {
      return parent.name.text;
    }
    parent = parent.parent;
  }
  return null;
}

/** `Foo` from `Foo`, `Foo.Bar` or `Foo<T>` — the name the checker can resolve. */
function rootTarget(node: ts.Node): ts.Node {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isExpressionWithTypeArguments(node)) return node.expression;
  return node;
}

/** The leftmost identifier of a possibly-qualified name. */
function rootIdentifier(node: ts.Node): ts.Identifier | null {
  let current: ts.Node = rootTarget(node);
  for (;;) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isQualifiedName(current)) {
      current = current.left;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else {
      return null;
    }
  }
}

/** Windows path separators would otherwise make two names for one file. */
function normalise(fileName: string): string {
  return fileName.split(sep).join('/');
}
