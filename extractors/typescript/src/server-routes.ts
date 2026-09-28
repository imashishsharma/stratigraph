/**
 * HTTP routes a Node server registers with Koa or Express (ADR-0045).
 *
 * `router.get("/status", handler)` is a route declaration as surely as
 * `@GetMapping("/status")` is — when `router` is provably a Koa or Express
 * router: its binding is created by `new Router()` / `express()` /
 * `express.Router()` from an import of `@koa/router`, `koa-router` or
 * `express`, or is a parameter typed with such an import. Anything else named
 * `router` is not read, however it is called.
 */

import ts from 'typescript';

export interface ServerRoute {
  method: string;
  path: string;
  framework: 'koa' | 'express';
  line: number;
  /** The call's enclosing method or function, for the `handles` edge. */
  enclosing: ts.Node | null;
}

const MODULES: Record<string, 'koa' | 'express'> = {
  '@koa/router': 'koa',
  'koa-router': 'koa',
  express: 'express',
};

const VERBS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'head', 'options']);

export function serverRoutes(source: ts.SourceFile, checker: ts.TypeChecker): ServerRoute[] {
  // Local names bound to a router module by this file's imports.
  const imported = new Map<string, 'koa' | 'express'>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const framework = MODULES[statement.moduleSpecifier.text];
    const clause = statement.importClause;
    if (framework === undefined || clause === undefined) continue;
    if (clause.name) imported.set(clause.name.text, framework);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, framework);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imported.set(element.name.text, framework);
    }
  }
  if (imported.size === 0) return [];

  /** The framework a router-producing expression comes from, or null. */
  const producer = (expression: ts.Expression | undefined): 'koa' | 'express' | null => {
    if (expression === undefined) return null;
    if (ts.isNewExpression(expression) || ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (ts.isIdentifier(callee)) return imported.get(callee.text) ?? null;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        return imported.get(callee.expression.text) ?? null; // express.Router()
      }
    }
    return null;
  };

  /** The framework of a receiver identifier, from its declaration. */
  const receiver = (identifier: ts.Identifier): 'koa' | 'express' | null => {
    const symbol = checker.getSymbolAtLocation(identifier);
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration)) {
        const framework = producer(declaration.initializer);
        if (framework !== null) return framework;
      }
      if ((ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) && declaration.type) {
        const type = declaration.type;
        if (ts.isTypeReferenceNode(type)) {
          const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.left.getText(source);
          const framework = imported.get(name);
          if (framework !== undefined) return framework;
        }
      }
    }
    return null;
  };

  const routes: ServerRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      VERBS.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const first = node.arguments[0];
      const path =
        first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : null;
      const framework = path === null ? null : receiver(node.expression.expression);
      if (path !== null && framework !== null) {
        const verb = node.expression.name.text === 'del' ? 'DELETE' : node.expression.name.text.toUpperCase();
        routes.push({
          method: verb,
          path: path.replace(/:([A-Za-z_]\w*)\??/g, '{$1}'),
          framework,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          enclosing: enclosingDeclaration(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

function enclosingDeclaration(node: ts.Node): ts.Node | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isConstructorDeclaration(current)) {
      return current;
    }
  }
  return null;
}
