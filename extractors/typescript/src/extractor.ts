import { join } from 'node:path';

import ts from 'typescript';

import { countLines, moduleOf, type Discovery } from './discovery.js';
import { directoryOf, fieldFqn, methodFqn, modulePath, typeFqn } from './fqn.js';
import { createProgram, Resolver } from './program.js';
import type { FactEmitter, NodeKind, NodeRef } from './protocol.js';

/**
 * The walk that turns a parsed source set into facts.
 *
 * Order is fixed and deterministic — meta, every file, then each source in path
 * order — because `fixtures/tiny-angular/expected-facts.ndjson` asserts the
 * stream exactly, and a fact appearing that should not is as much a failure as
 * one going missing.
 */

export class TypeScriptExtractor {
  private readonly program: ts.Program;
  private readonly resolver: Resolver;
  /** Types declared per module path, so a local name resolves without the checker. */
  private readonly declaredHere = new Map<string, Map<string, NodeKind>>();

  constructor(
    private readonly repoRoot: string,
    private readonly emitter: FactEmitter,
    private readonly discovery: Discovery,
  ) {
    this.program = createProgram(repoRoot, discovery);
    this.resolver = new Resolver(repoRoot, this.program, discovery);
  }

  run(): void {
    for (const path of [...this.discovery.sources].sort()) {
      this.emitter.file(path, 'typescript', countLines(join(this.repoRoot, path)));
    }
    for (const path of this.discovery.templates) {
      this.emitter.file(path, 'html', countLines(join(this.repoRoot, path)));
    }

    for (const path of this.discovery.sources) {
      const source = this.program.getSourceFile(join(this.repoRoot, path));
      if (source === undefined) {
        // The file was discovered but the program declined to parse it. Loud,
        // per ADR-0016: partial results beat no results, but not silently.
        this.emitter.diagnostic('error', `could not be parsed`, path);
        continue;
      }
      this.extractFile(path, source);
    }
  }

  private extractFile(path: string, source: ts.SourceFile): void {
    const packageFqn = this.ensurePackage(path);
    const module = modulePath(path);

    this.extractImports(path, source, packageFqn);

    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement)) {
        this.extractClass(path, source, packageFqn, module, statement);
      } else if (ts.isInterfaceDeclaration(statement)) {
        this.extractInterface(path, source, packageFqn, module, statement);
      } else if (ts.isEnumDeclaration(statement)) {
        this.extractEnum(path, source, packageFqn, module, statement);
      } else if (ts.isFunctionDeclaration(statement)) {
        this.extractFunction(path, source, packageFqn, module, statement);
      } else if (ts.isVariableStatement(statement)) {
        this.extractVariables(path, source, packageFqn, module, statement);
      }
    }
  }

  /** The `module` and `package` nodes a file belongs to. Emitted once each. */
  private ensurePackage(path: string): string {
    const module = moduleOf(this.discovery, path);
    this.emitter.node({ kind: 'module', fqn: module.fqn, name: module.name });

    const directory = directoryOf(path);
    this.emitter.node({
      kind: 'package',
      fqn: directory,
      name: directory === '.' ? '.' : (directory.split('/').pop() ?? directory),
      parent: { kind: 'module', fqn: module.fqn },
    });
    return directory;
  }

  /**
   * `imports` edges, from the importing file's **directory** rather than from a
   * declaration inside it.
   *
   * This is the one place the TypeScript scheme deliberately reads coarser than
   * the Java one, and the reason is that a TypeScript import is a property of
   * the module, not of any declaration in it: it exists whether or not anything
   * in the file uses the name, and plenty of the files that matter most —
   * `app.routes.ts`, a barrel `index.ts`, an `environment.ts` — declare no type
   * for the edge to hang off. Directory granularity is also exactly what the
   * package graph, cycle detection and clustering consume.
   *
   * Nothing is lost where precision matters: the edge carries the file and the
   * line of the import statement, so a citation still points at the source
   * line, and the edges that need per-symbol precision — `injects`, `extends`,
   * `implements` — are declaration to declaration.
   */
  private extractImports(path: string, source: ts.SourceFile, packageFqn: string): void {
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      // `import './polyfills'` names nothing to depend on beyond the module,
      // and we do not model modules as nodes. Skipped rather than guessed at.
      if (clause === undefined) continue;

      const line = lineOf(source, statement);
      const names: ts.Identifier[] = [];
      if (clause.name !== undefined) names.push(clause.name);
      const bindings = clause.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) {
          names.push(bindings.name);
        } else {
          for (const element of bindings.elements) names.push(element.name);
        }
      }

      for (const name of names) {
        const resolved = this.resolver.resolve(name);
        if (resolved === null) {
          this.emitter.diagnostic(
            'warn',
            `import of "${name.text}" from "${statement.moduleSpecifier.text}" resolved to ` +
              `nothing; no imports edge recorded`,
            path,
            line,
          );
          continue;
        }
        this.emitter.edge({
          kind: 'imports',
          src: { kind: 'package', fqn: packageFqn },
          dst: resolved.ref,
          file: path,
          line,
          attrs: { resolution: resolved.resolution },
        });
      }
    }
  }

  private extractClass(
    path: string,
    source: ts.SourceFile,
    packageFqn: string,
    module: string,
    declaration: ts.ClassDeclaration,
  ): void {
    const name = declaration.name?.text;
    // `export default class {}` has no name. ADR-0017 calls it `default`.
    const declared = name ?? (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
    if (declared === null) return;

    const fqn = typeFqn(module, declared);
    this.declare(module, declared, 'class');
    this.emitter.node({
      kind: 'class',
      fqn,
      name: declared,
      parent: { kind: 'package', fqn: packageFqn },
      file: path,
      startLine: lineOf(source, declaration),
      endLine: endLineOf(source, declaration),
      ...attrsOf(modifiersOf(declaration)),
    });

    this.extractHeritage(path, source, fqn, declaration);
    this.extractMembers(path, source, fqn, declaration);
  }

  private extractInterface(
    path: string,
    source: ts.SourceFile,
    packageFqn: string,
    module: string,
    declaration: ts.InterfaceDeclaration,
  ): void {
    const declared = declaration.name.text;
    const fqn = typeFqn(module, declared);
    this.declare(module, declared, 'interface');
    this.emitter.node({
      kind: 'interface',
      fqn,
      name: declared,
      parent: { kind: 'package', fqn: packageFqn },
      file: path,
      startLine: lineOf(source, declaration),
      endLine: endLineOf(source, declaration),
      ...attrsOf(modifiersOf(declaration)),
    });
    this.extractHeritage(path, source, fqn, declaration);
  }

  private extractEnum(
    path: string,
    source: ts.SourceFile,
    packageFqn: string,
    module: string,
    declaration: ts.EnumDeclaration,
  ): void {
    const declared = declaration.name.text;
    this.declare(module, declared, 'enum');
    this.emitter.node({
      kind: 'enum',
      fqn: typeFqn(module, declared),
      name: declared,
      parent: { kind: 'package', fqn: packageFqn },
      file: path,
      startLine: lineOf(source, declaration),
      endLine: endLineOf(source, declaration),
      ...attrsOf(modifiersOf(declaration)),
    });
  }

  /**
   * A module-level function is a `method` owned by its module (ADR-0017). A
   * route guard written as a standalone function and one written as a service
   * method are the same thing to every analysis downstream.
   */
  private extractFunction(
    path: string,
    source: ts.SourceFile,
    packageFqn: string,
    module: string,
    declaration: ts.FunctionDeclaration,
  ): void {
    const declared = declaration.name?.text;
    if (declared === undefined) return;
    this.emitter.node({
      kind: 'method',
      fqn: methodFqn(module, declared),
      name: declared,
      parent: { kind: 'package', fqn: packageFqn },
      file: path,
      startLine: lineOf(source, declaration),
      endLine: endLineOf(source, declaration),
      ...attrsOf(modifiersOf(declaration), returnsOf(declaration)),
    });
  }

  /**
   * Exported module-level bindings become `field` nodes owned by the module.
   *
   * Not gold-plating: `export const routes: Routes = [...]` is where an Angular
   * application's entire route table lives, and it needs a node for the route
   * facts to attach to.
   */
  private extractVariables(
    path: string,
    source: ts.SourceFile,
    packageFqn: string,
    module: string,
    statement: ts.VariableStatement,
  ): void {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const declared = declaration.name.text;
      this.emitter.node({
        kind: 'field',
        fqn: fieldFqn(module, declared),
        name: declared,
        parent: { kind: 'package', fqn: packageFqn },
        file: path,
        startLine: lineOf(source, statement),
        ...attrsOf(modifiersOf(statement), typeTextOf(declaration.type)),
      });
    }
  }

  private extractHeritage(
    path: string,
    source: ts.SourceFile,
    ownerFqn: string,
    declaration: ts.ClassDeclaration | ts.InterfaceDeclaration,
  ): void {
    const ownerKind: NodeKind = ts.isClassDeclaration(declaration) ? 'class' : 'interface';
    for (const clause of declaration.heritageClauses ?? []) {
      const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
      for (const type of clause.types) {
        const line = lineOf(source, type);
        const resolved = this.resolver.resolve(type);
        if (resolved === null) {
          this.emitter.diagnostic(
            'warn',
            `${kind} target "${type.expression.getText(source)}" resolved to nothing; ` +
              `no ${kind} edge recorded`,
            path,
            line,
          );
          continue;
        }
        this.emitter.edge({
          kind,
          src: { kind: ownerKind, fqn: ownerFqn },
          dst: resolved.ref,
          file: path,
          line,
          attrs: { resolution: resolved.resolution },
        });
      }
    }
  }

  private extractMembers(
    path: string,
    source: ts.SourceFile,
    ownerFqn: string,
    declaration: ts.ClassDeclaration,
  ): void {
    /** Members already emitted, so a static/instance clash can be reported. */
    const seen = new Map<string, number>();

    const record = (name: string, line: number): boolean => {
      const previous = seen.get(name);
      if (previous !== undefined) {
        // ADR-0017: TypeScript allows `static x` alongside `x` because statics
        // live on the constructor. They merge onto one node, and the merge must
        // not be invisible.
        this.emitter.diagnostic(
          'warn',
          `"${name}" is declared twice in this class (lines ${previous} and ${line}); ` +
            `the two merge onto one node`,
          path,
          line,
        );
        return false;
      }
      seen.set(name, line);
      return true;
    };

    for (const member of declaration.members) {
      const line = lineOf(source, member);

      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
        if (!record(member.name.text, line)) continue;
        this.emitter.node({
          kind: 'field',
          fqn: fieldFqn(ownerFqn, member.name.text),
          name: member.name.text,
          parent: { kind: 'class', fqn: ownerFqn },
          file: path,
          startLine: line,
          ...attrsOf(modifiersOf(member), typeTextOf(member.type)),
        });
      } else if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
        if (!record(member.name.text, line)) continue;
        this.emitter.node({
          kind: 'method',
          fqn: methodFqn(ownerFqn, member.name.text),
          name: member.name.text,
          parent: { kind: 'class', fqn: ownerFqn },
          file: path,
          startLine: line,
          endLine: endLineOf(source, member),
          ...attrsOf(modifiersOf(member), returnsOf(member)),
        });
      } else if (ts.isConstructorDeclaration(member)) {
        this.emitter.node({
          kind: 'method',
          fqn: methodFqn(ownerFqn, 'constructor'),
          name: 'constructor',
          parent: { kind: 'class', fqn: ownerFqn },
          file: path,
          startLine: line,
          endLine: endLineOf(source, member),
        });
        this.extractParameterProperties(path, source, ownerFqn, member);
      }
    }
  }

  /**
   * `constructor(private readonly http: HttpClient)` declares a field. Angular
   * code is written this way almost exclusively, so without this the class that
   * does all the injecting appears to have no state at all.
   */
  private extractParameterProperties(
    path: string,
    source: ts.SourceFile,
    ownerFqn: string,
    constructorDeclaration: ts.ConstructorDeclaration,
  ): void {
    for (const parameter of constructorDeclaration.parameters) {
      if (!ts.isIdentifier(parameter.name)) continue;
      const modifiers = modifiersOf(parameter);
      const isProperty = modifiers.some((m) =>
        ['private', 'protected', 'public', 'readonly'].includes(m),
      );
      if (!isProperty) continue;
      this.emitter.node({
        kind: 'field',
        fqn: fieldFqn(ownerFqn, parameter.name.text),
        name: parameter.name.text,
        parent: { kind: 'class', fqn: ownerFqn },
        file: path,
        startLine: lineOf(source, parameter),
        ...attrsOf(modifiers, typeTextOf(parameter.type), { parameterProperty: true }),
      });
    }
  }

  private declare(module: string, name: string, kind: NodeKind): void {
    let declarations = this.declaredHere.get(module);
    if (declarations === undefined) {
      declarations = new Map();
      this.declaredHere.set(module, declarations);
    }
    declarations.set(name, kind);
  }
}

export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function endLineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

export function modifiersOf(node: ts.Node): string[] {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return modifiers
    .map((modifier) => ts.tokenToString(modifier.kind))
    .filter((text): text is string => text !== undefined);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === kind);
}

function typeTextOf(type: ts.TypeNode | undefined): Record<string, unknown> {
  return type === undefined ? {} : { type: type.getText() };
}

function returnsOf(node: ts.FunctionDeclaration | ts.MethodDeclaration): Record<string, unknown> {
  return node.type === undefined ? {} : { returns: node.type.getText() };
}

/** Merge attribute fragments, omitting `attrs` entirely when there is nothing. */
function attrsOf(
  modifiers: string[],
  ...rest: Array<Record<string, unknown>>
): { attrs?: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {};
  if (modifiers.length > 0) attrs['modifiers'] = modifiers;
  for (const fragment of rest) Object.assign(attrs, fragment);
  return Object.keys(attrs).length === 0 ? {} : { attrs };
}

export type { NodeRef };
