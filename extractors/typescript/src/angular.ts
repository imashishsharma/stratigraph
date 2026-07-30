import { dirname, join, relative, sep } from 'node:path';

import ts from 'typescript';

import { modulePath, routeFqn, routeName, typeFqn } from './fqn.js';
import type { Resolved, Resolver } from './program.js';
import type { EdgeSpec, FactEmitter, NodeRef } from './protocol.js';

/**
 * Angular, read from decorators rather than from Angular (ADR-0016).
 *
 * A decorator is recognised by its name **and by the module the name was
 * imported from**, which is ADR-0005's rule applied to a second framework: a
 * class decorated `@Component` from `@angular/core` is a component, and a team's
 * own `@Page` wrapper is a decorated class and nothing more. Recognising it by
 * name alone would be the confidently-wrong map this project exists to prevent.
 */

/** Decorators whose metadata we understand, keyed by the package they live in. */
const ANGULAR_PACKAGES = ['@angular/core', '@angular/common', '@angular/router'];

const CLASS_DECORATORS = new Set(['Component', 'Directive', 'Injectable', 'NgModule', 'Pipe']);

/** Members of an `@NgModule` or standalone `imports` that become edges. */
const MODULE_ARRAYS = ['imports', 'declarations', 'exports', 'providers'] as const;

/** `HttpClient` methods whose first argument is a URL. */
const HTTP_METHODS = new Map<string, string>([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

export interface AngularClass {
  /** `Component`, `Injectable`, … when an Angular class decorator is present. */
  stereotype: string | null;
  /** Attributes to merge onto the class node. */
  attrs: Record<string, unknown>;
  /** Every decorator that resolved, Angular's or not. */
  decorators: Array<{
    ref: NodeRef;
    external: boolean;
    resolution: Resolved['resolution'];
    line: number;
  }>;
  /** The decorator's metadata object, when it has one. */
  metadata: ts.ObjectLiteralExpression | null;
}

/**
 * An observed `.subscribe(...)` site.
 *
 * `guarded` and `retained` are recorded here rather than derived later because
 * they are syntax, and this is the only place the syntax exists — by the time
 * `src/analysis/rxjs-findings.ts` runs there is no AST to ask. Both are facts
 * about the call site, not judgements about it: whether the subscription leaks
 * is layer 4's to decide, on ADR-0008's rule that a judgement is a finding.
 */
export interface Subscribe {
  line: number;
  /** The chain bounds its own lifetime — `takeUntil`, `take(1)`, `first()`. */
  guarded: boolean;
  /** The returned `Subscription` is kept: assigned, pushed, or `.add`ed. */
  retained: boolean;
}

/**
 * Operators that end a subscription without anyone calling `unsubscribe`.
 *
 * `takeUntilDestroyed` and `toSignal` tie it to the injection context;
 * `take`/`first` complete after n values; `takeUntil` and `takeWhile` complete
 * on a signal. Any of them means the code has said how this ends.
 */
const LIFETIME_OPERATORS = new Set([
  'takeUntil',
  'takeUntilDestroyed',
  'takeWhile',
  'take',
  'first',
  'toSignal',
  'toPromise',
]);

/** An observed HTTP call with a URL we could read without guessing. */
export interface HttpCall {
  method: string;
  /** The URL as declared, with interpolated segments replaced by `{}`. */
  url: string;
  line: number;
}

export class AngularFacts {
  /** Component selector → the class that declares it, for the template pass. */
  private readonly selectors = new Map<string, string>();
  /** Route fqn → the file that first declared it, for the collision diagnostic. */
  private readonly routeDeclaredIn = new Map<string, string>();
  /** Template file → the component classes that name it, for the template pass. */
  private readonly templates: Array<{
    templatePath: string;
    componentFqn: string;
    inline: string | null;
    line: number;
  }> = [];

  constructor(
    private readonly repoRoot: string,
    private readonly emitter: FactEmitter,
    private readonly resolver: Resolver,
  ) {}

  /**
   * Read a class's decorators. Called before the class node is emitted, because
   * `selector` and `standalone` belong on that node.
   */
  readClass(path: string, source: ts.SourceFile, declaration: ts.ClassDeclaration): AngularClass {
    const result: AngularClass = {
      stereotype: null,
      attrs: {},
      decorators: [],
      metadata: null,
    };

    for (const decorator of ts.getDecorators(declaration) ?? []) {
      const call = ts.isCallExpression(decorator.expression) ? decorator.expression : null;
      const identifier = call === null ? decorator.expression : call.expression;
      const line = lineOf(source, decorator);

      const resolved = this.resolver.resolve(identifier);
      if (resolved === null) {
        this.emitter.diagnostic(
          'warn',
          `decorator "${identifier.getText(source)}" resolved to nothing; ` +
            `no annotated_with edge recorded`,
          path,
          line,
        );
        continue;
      }
      result.decorators.push({
        ref: resolved.ref,
        external: resolved.external,
        resolution: resolved.resolution,
        line,
      });

      const name = exportedName(resolved.ref.fqn);
      if (!isAngular(resolved.ref.fqn) || !CLASS_DECORATORS.has(name)) continue;

      result.stereotype = name;
      result.attrs['angular'] = name;
      const metadata =
        call !== null && call.arguments.length > 0 && ts.isObjectLiteralExpression(call.arguments[0]!)
          ? (call.arguments[0] as ts.ObjectLiteralExpression)
          : null;
      result.metadata = metadata;
      if (metadata === null) continue;

      const selector = stringProp(metadata, 'selector');
      if (selector !== null) result.attrs['selector'] = selector;
      const providedIn = stringProp(metadata, 'providedIn');
      if (providedIn !== null) result.attrs['providedIn'] = providedIn;
      const standalone = booleanProp(metadata, 'standalone');
      if (standalone !== null) result.attrs['standalone'] = standalone;
      const templateUrl = stringProp(metadata, 'templateUrl');
      if (templateUrl !== null) result.attrs['templateUrl'] = templateUrl;
    }

    return result;
  }

  /**
   * `annotated_with` edges, emitted once the class node exists.
   *
   * The `kind` on the far side is the one subtlety. A TypeScript decorator is a
   * *function*, not a type, so a locally declared `@Page` already has a `method`
   * node of its own — pointing at it as an `annotation` would mint a second node
   * with the same fqn and split the graph in two. Only a decorator from outside
   * the source set becomes an `annotation` stub, which is honest: we know it
   * decorates and we never read what it does.
   */
  emitDecorators(path: string, classFqn: string, info: AngularClass): void {
    for (const decorator of info.decorators) {
      this.emitter.edge({
        kind: 'annotated_with',
        src: { kind: 'class', fqn: classFqn },
        dst: decorator.external
          ? { kind: 'annotation', fqn: decorator.ref.fqn }
          : decorator.ref,
        file: path,
        line: decorator.line,
        attrs: { resolution: decorator.resolution },
      });
    }
  }

  /**
   * Register what a component renders, for the template pass to resolve. Kept
   * until every file has been read, because a selector used in one directory is
   * usually declared in another.
   */
  registerTemplate(
    path: string,
    source: ts.SourceFile,
    classFqn: string,
    info: AngularClass,
  ): void {
    if (info.stereotype !== 'Component' || info.metadata === null) return;

    const selector = info.attrs['selector'];
    if (typeof selector === 'string') this.selectors.set(selector, classFqn);

    const templateUrl = stringProp(info.metadata, 'templateUrl');
    if (templateUrl !== null) {
      const resolved = relative(this.repoRoot, join(this.repoRoot, dirname(path), templateUrl))
        .split(sep)
        .join('/');
      this.templates.push({
        templatePath: resolved,
        componentFqn: classFqn,
        inline: null,
        line: lineOf(source, info.metadata),
      });
      return;
    }

    const inline = stringProp(info.metadata, 'template');
    if (inline !== null) {
      this.templates.push({
        templatePath: path,
        componentFqn: classFqn,
        inline,
        line: lineOf(source, info.metadata),
      });
    }
  }

  /**
   * `imports` / `declarations` / `exports` / `providers` from an `@NgModule` or
   * a standalone component, as class-to-class edges.
   *
   * These are the edges that make a lazy-loaded feature boundary visible, and
   * `attrs.ngModule` records which array an entry came from — being declared by
   * a module and being imported into one are different relationships, and a
   * report that flattens them loses the distinction that matters.
   */
  emitModuleMetadata(path: string, source: ts.SourceFile, classFqn: string, info: AngularClass): void {
    if (info.metadata === null) return;
    for (const role of MODULE_ARRAYS) {
      const array = arrayProp(info.metadata, role);
      if (array === null) continue;
      for (const element of array.elements) {
        // `provide:`/`useClass:` objects configure DI at runtime; ADR-0016 says
        // a factory is not a fact. A bare class reference is.
        const target = ts.isObjectLiteralExpression(element)
          ? (propertyValue(element, 'useClass') ?? propertyValue(element, 'provide'))
          : element;
        if (target === undefined || target === null) continue;
        if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target)) continue;

        const line = lineOf(source, element);
        const resolved = this.resolver.resolve(target);
        if (resolved === null) {
          this.emitter.diagnostic(
            'warn',
            `"${target.getText(source)}" in ${role} resolved to nothing; no imports edge recorded`,
            path,
            line,
          );
          continue;
        }
        this.emitter.edge({
          kind: 'imports',
          src: { kind: 'class', fqn: classFqn },
          dst: resolved.ref,
          file: path,
          line,
          attrs: { ngModule: role, resolution: resolved.resolution },
        });
      }
    }
  }

  /**
   * Dependency injection: constructor parameters, `@Inject(TOKEN)`, and
   * `inject(TOKEN)` calls.
   *
   * The refusal that matters is at the bottom. `inject(API_BASE)` where
   * `API_BASE` is an `InjectionToken` resolves to a *value*, not to a class we
   * could draw an edge to. Angular will hand the component a string at runtime;
   * what it is a string of, we do not know, and an `injects` edge into the
   * token's declaration would claim a dependency on a constant.
   */
  emitInjections(
    path: string,
    source: ts.SourceFile,
    owner: NodeRef,
    declaration: ts.ClassDeclaration,
  ): void {
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          const line = lineOf(source, parameter);
          const injectDecorator = parameterInject(parameter);
          if (injectDecorator !== null) {
            this.emitInjection(path, source, owner, injectDecorator, line, 'inject-decorator');
          } else if (parameter.type !== undefined) {
            this.emitInjection(path, source, owner, parameter.type, line, 'constructor');
          }
        }
      }
      this.emitInjectCalls(path, source, owner, member);
    }
  }

  /**
   * `inject(Foo)` outside a class — a functional route guard, a resolver, a
   * provider factory. Standalone Angular writes as much DI this way as through
   * constructors, and a DI graph that only reads constructors misses it.
   */
  emitInjectCalls(path: string, source: ts.SourceFile, owner: NodeRef, scope: ts.Node): void {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'inject' &&
        node.arguments.length > 0
      ) {
        const callee = this.resolver.resolve(node.expression);
        if (callee !== null && isAngular(callee.ref.fqn)) {
          this.emitInjection(
            path,
            source,
            owner,
            node.arguments[0]!,
            lineOf(source, node),
            'inject-function',
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }

  private emitInjection(
    path: string,
    source: ts.SourceFile,
    owner: NodeRef,
    target: ts.Node,
    line: number,
    via: string,
  ): void {
    const resolved = this.resolver.resolve(target);
    if (resolved === null) {
      this.emitter.diagnostic(
        'warn',
        `injected "${target.getText(source)}" resolved to nothing; no injects edge recorded`,
        path,
        line,
      );
      return;
    }
    if (resolved.value) {
      this.emitter.diagnostic(
        'info',
        `"${target.getText(source)}" is an injection token, not a class; ` +
          `no injects edge recorded — what it provides is decided at runtime`,
        path,
        line,
      );
      return;
    }
    this.emitter.edge({
      kind: 'injects',
      src: owner,
      dst: resolved.ref,
      file: path,
      line,
      attrs: { via, resolution: resolved.resolution },
    });
  }

  /**
   * Call sites layer 4 needs, recorded on the enclosing member rather than as
   * edges into something we did not resolve.
   *
   * A `.subscribe(...)` tells us a call to a member named `subscribe` happened
   * at a line — and on a repository with no `node_modules`, nothing tells us the
   * receiver is an rxjs `Observable`. Emitting a `calls` edge to
   * `rxjs:Observable#subscribe()` would be asserting a type we never saw, so
   * the observation stays on the member node where it is true: a line number in
   * a file. `src/analysis/rxjs-findings.ts` reads it from there.
   *
   * The same reasoning applies to `this.http.get('/api/orders')`. The URL is
   * observed; which endpoint serves it is an inference, and inferences are made
   * by the linker in the core, against endpoints this process has never seen.
   */
  callSites(source: ts.SourceFile, member: ts.Node): { subscribes: Subscribe[]; http: HttpCall[] } {
    const subscribes: Subscribe[] = [];
    const http: HttpCall[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (name === 'subscribe') {
          subscribes.push({
            line: lineOf(source, node.expression.name),
            guarded: isGuarded(node.expression.expression),
            retained: isRetained(node),
          });
        }
        const verb = HTTP_METHODS.get(name);
        if (verb !== undefined && node.arguments.length > 0 && looksLikeHttpClient(node.expression)) {
          const url = literalUrl(node.arguments[0]!);
          const line = lineOf(source, node.expression.name);
          if (url === null) {
            this.emitter.diagnostic(
              'info',
              `${verb} request to a computed URL (${node.arguments[0]!.getText(source)}); ` +
                `no endpoint can be matched to it`,
              relative(this.repoRoot, source.fileName).split(sep).join('/'),
              line,
            );
          } else {
            http.push({ method: verb, url, line });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(member);

    return { subscribes, http };
  }

  /**
   * Route tables: an array literal typed `Routes`, or one handed to
   * `RouterModule.forRoot`/`forChild`.
   *
   * `declares_route` runs from whatever declared the table; `handles` runs from
   * the component that serves the path to the route, mirroring exactly how a
   * Spring `@GetMapping` method `handles` an endpoint. Reading an Angular route
   * table next to a Spring controller is the point of having one vocabulary.
   */
  emitRoutes(
    path: string,
    source: ts.SourceFile,
    ownerRef: NodeRef,
    array: ts.ArrayLiteralExpression,
    parents: readonly string[] = [],
  ): void {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const line = lineOf(source, element);

      const pathValue = propertyValue(element, 'path');
      if (pathValue !== undefined && !ts.isStringLiteralLike(pathValue)) {
        this.emitter.diagnostic(
          'warn',
          `route path is not a literal (${pathValue.getText(source)}); no route node recorded`,
          path,
          line,
        );
        continue;
      }
      const segment = pathValue === undefined ? '' : pathValue.text;
      const segments = [...parents, segment];
      const fqn = routeFqn(segments);

      const attrs: Record<string, unknown> = {};
      const redirectTo = stringProp(element, 'redirectTo');
      if (redirectTo !== null) attrs['redirectTo'] = redirectTo;

      const lazy = lazyImport(element);
      if (lazy !== null) attrs['lazy'] = true;

      const fresh = this.emitter.node({
        kind: 'route',
        fqn,
        name: routeName(fqn),
        file: path,
        startLine: line,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      });
      // ADR-0017: two declarations of one resolved path merge onto one node, and
      // the merge must not be invisible. Only across files, though — within one
      // table, `{path: 'orders', children: [{path: ''}]}` resolves the parent
      // and its empty child to the same path on purpose, and warning about the
      // commonest idiom in Angular routing would be noise, not evidence.
      if (!fresh) {
        const first = this.routeDeclaredIn.get(fqn);
        if (first !== undefined && first !== path) {
          this.emitter.diagnostic(
            'warn',
            `route "${fqn}" is also declared in ${first}; the two merge onto one node`,
            path,
            line,
          );
        }
      } else {
        this.routeDeclaredIn.set(fqn, path);
      }
      this.emitter.edge({
        kind: 'declares_route',
        src: ownerRef,
        dst: { kind: 'route', fqn },
        file: path,
        line,
      });

      // What serves the path: an eager `component:`, or the class named by a
      // lazy `loadComponent`/`loadChildren`.
      const component = propertyValue(element, 'component');
      if (component !== undefined) {
        this.emitHandles(path, source, component, fqn, line, false);
      } else if (lazy !== null) {
        this.emitLazyHandles(path, source, lazy, fqn, line);
      }

      const children = arrayProp(element, 'children');
      if (children !== null) {
        this.emitRoutes(path, source, ownerRef, children, segments);
      }
    }
  }

  private emitHandles(
    path: string,
    source: ts.SourceFile,
    target: ts.Node,
    routeFqnValue: string,
    line: number,
    lazy: boolean,
  ): void {
    const resolved = this.resolver.resolve(target);
    if (resolved === null) {
      this.emitter.diagnostic(
        'warn',
        `route target "${target.getText(source)}" resolved to nothing; no handles edge recorded`,
        path,
        line,
      );
      return;
    }
    this.emitter.edge({
      kind: 'handles',
      src: resolved.ref,
      dst: { kind: 'route', fqn: routeFqnValue },
      file: path,
      line,
      attrs: { lazy, resolution: resolved.resolution },
    });
  }

  /**
   * `loadComponent: () => import('./x').then(m => m.Y)`.
   *
   * The dynamic import is the lazy-loaded boundary — the thing that decides
   * which code lands in which bundle — so the module specifier is resolved the
   * same way a static import is, and the named export becomes the class.
   */
  private emitLazyHandles(
    path: string,
    source: ts.SourceFile,
    lazy: LazyImport,
    routeFqnValue: string,
    line: number,
  ): void {
    if (lazy.exported === null) {
      this.emitter.diagnostic(
        'warn',
        `lazy route imports "${lazy.specifier}" but names no export; no handles edge recorded`,
        path,
        line,
      );
      return;
    }
    if (!lazy.specifier.startsWith('.')) {
      this.emitter.diagnostic(
        'warn',
        `lazy route imports "${lazy.specifier}", which is outside the source set; ` +
          `no handles edge recorded`,
        path,
        line,
      );
      return;
    }
    const target = relative(this.repoRoot, join(this.repoRoot, dirname(path), lazy.specifier))
      .split(sep)
      .join('/');
    this.emitter.edge({
      kind: 'handles',
      src: { kind: 'class', fqn: typeFqn(modulePath(target), lazy.exported) },
      dst: { kind: 'route', fqn: routeFqnValue },
      file: path,
      line,
      attrs: { lazy: true, resolution: 'import' },
    });
  }

  /**
   * The template pass, run after every source file has been read.
   *
   * A tag that matches no known component selector produces nothing at all —
   * it is a native element, or a directive from a library we never parsed, and
   * either way there is no edge to draw. Only element selectors are matched:
   * an attribute selector (`[appHighlight]`) is a directive, and matching those
   * needs the attribute-level parse ADR-0016 chose not to buy.
   */
  emitTemplateEdges(readTemplate: (path: string) => string | null): void {
    for (const template of this.templates) {
      const text = template.inline ?? readTemplate(template.templatePath);
      if (text === null) {
        this.emitter.diagnostic(
          'warn',
          `templateUrl points at "${template.templatePath}", which could not be read`,
          template.templatePath,
        );
        continue;
      }

      const edges: EdgeSpec[] = [];
      let parsed;
      try {
        parsed = parseTemplateText(text, template.templatePath);
      } catch (err) {
        this.emitter.diagnostic(
          'error',
          `template could not be parsed: ${(err as Error).message}`,
          template.templatePath,
        );
        continue;
      }
      if (parsed === null) continue;

      for (const { tag, line } of parsed) {
        const target = this.selectors.get(tag);
        if (target === undefined) continue;
        edges.push({
          kind: 'imports',
          src: { kind: 'class', fqn: template.componentFqn },
          dst: { kind: 'class', fqn: target },
          file: template.templatePath,
          // An inline template's offsets are relative to the string, so the
          // line of the metadata object is the honest citation for it.
          line: template.inline === null ? line : template.line,
          attrs: { template: true, selector: tag },
        });
      }

      // Sorted so that two elements on one line cannot reorder between runs.
      edges.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.dst.fqn < b.dst.fqn ? -1 : 1));
      for (const edge of edges) this.emitter.edge(edge);
    }
  }
}

interface LazyImport {
  specifier: string;
  exported: string | null;
}

/** `() => import('./x').then(m => m.Y)`, and the `loadChildren` variants. */
function lazyImport(route: ts.ObjectLiteralExpression): LazyImport | null {
  for (const key of ['loadComponent', 'loadChildren']) {
    const value = propertyValue(route, key);
    if (value === undefined) continue;

    let specifier: string | null = null;
    let exported: string | null = null;
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(node.parent)) {
        const arg = node.parent.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg)) specifier = arg.text;
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        // The `m.OrderRowComponent` of `.then((m) => m.OrderRowComponent)`.
        if (node.name.text !== 'then') exported = node.name.text;
      }
      ts.forEachChild(node, visit);
    };
    visit(value);

    if (specifier !== null) return { specifier, exported };
  }
  return null;
}

/**
 * Whether anything in the chain feeding `.subscribe()` bounds its lifetime.
 *
 * The whole receiver expression is searched rather than only the `pipe()`
 * arguments, because the operator may be applied several links up
 * (`this.form.valueChanges.pipe(takeUntil(this.destroy$)).pipe(map(…))`) or by
 * a helper the chain was handed. Searching wide means occasionally calling a
 * subscription guarded when the operator was somewhere unrelated — which
 * suppresses a finding rather than fabricating one, and that is the direction
 * to be wrong in.
 */
function isGuarded(receiver: ts.Node): boolean {
  let guarded = false;
  const visit = (node: ts.Node): void => {
    if (guarded) return;
    if (ts.isIdentifier(node) && LIFETIME_OPERATORS.has(node.text)) {
      guarded = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(receiver);
  return guarded;
}

/**
 * Whether the `Subscription` the call returns is kept.
 *
 * `this.sub = x.subscribe(…)`, `this.subs.push(x.subscribe(…))` and
 * `this.subs.add(x.subscribe(…))` are the three idioms for holding a handle to
 * tear down later. Holding one is not proof anything tears it down, which is
 * why layer 4 also checks for `ngOnDestroy` — but not holding one is proof
 * nothing can.
 */
function isRetained(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (parent === undefined) return false;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.right === call;
  }
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    return (method === 'push' || method === 'add') && parent.arguments.includes(call);
  }
  return false;
}

/** `@Inject(TOKEN) foo: unknown` — the token, when one is named. */
function parameterInject(parameter: ts.ParameterDeclaration): ts.Node | null {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const callee = decorator.expression.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'Inject') continue;
    const arg = decorator.expression.arguments[0];
    if (arg !== undefined) return arg;
  }
  return null;
}

/**
 * Whether a `.get(...)` is plausibly `HttpClient`'s.
 *
 * Deliberately shallow: the receiver must be a property access whose name looks
 * like an HTTP client field. Everything this admits is still checked against a
 * real endpoint by the linker, and everything it rejects simply produces no
 * inference — which is the direction to be wrong in.
 */
function looksLikeHttpClient(access: ts.PropertyAccessExpression): boolean {
  const receiver = access.expression;
  const name = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver)
      ? receiver.text
      : null;
  return name !== null && /^(http|httpClient|_http)$/i.test(name);
}

/**
 * A URL we can read without guessing.
 *
 * A plain string literal is itself; a template literal keeps its literal
 * segments and replaces each `${…}` with `{}`, which is what the linker matches
 * against a Spring `{id}`. Anything else — a concatenation, a variable, a call
 * — returns null, and the caller records a diagnostic instead of an edge.
 */
function literalUrl(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let url = node.head.text;
    for (const span of node.templateSpans) {
      url += `{}${span.literal.text}`;
    }
    return url;
  }
  return null;
}

/** Element tags in a template, with the line each opens on. */
function parseTemplateText(
  text: string,
  path: string,
): Array<{ tag: string; line: number }> | null {
  const parsed = angularCompiler?.parseTemplate(text, path, { preserveWhitespaces: true });
  if (parsed === undefined) return null;
  if (parsed.errors !== null && parsed.errors !== undefined && parsed.errors.length > 0) {
    // A template that does not parse is a template we say nothing about.
    return null;
  }

  const found: Array<{ tag: string; line: number }> = [];
  const visit = (nodes: unknown[]): void => {
    for (const node of nodes) {
      const element = node as {
        name?: string;
        children?: unknown[];
        cases?: Array<{ children?: unknown[] }>;
        branches?: Array<{ children?: unknown[] }>;
        startSourceSpan?: { start: { line: number } };
      };
      if (typeof element.name === 'string' && element.startSourceSpan !== undefined) {
        found.push({ tag: element.name, line: element.startSourceSpan.start.line + 1 });
      }
      if (Array.isArray(element.children)) visit(element.children);
      // `@if`/`@for`/`@switch` blocks hold their content in branches and cases.
      for (const branch of element.branches ?? []) visit(branch.children ?? []);
      for (const singleCase of element.cases ?? []) visit(singleCase.children ?? []);
    }
  };
  visit(parsed.nodes as unknown[]);
  return found;
}

/**
 * `@angular/compiler`, loaded lazily.
 *
 * It is ESM-only and it is only needed by repositories that have templates, so
 * a repository of plain TypeScript never pays for loading it. Set by
 * `loadTemplateParser` before the template pass runs.
 */
let angularCompiler: { parseTemplate: TemplateParser } | undefined;

type TemplateParser = (
  text: string,
  path: string,
  options?: { preserveWhitespaces?: boolean },
) => { nodes: unknown[]; errors?: unknown[] | null };

export async function loadTemplateParser(): Promise<boolean> {
  if (angularCompiler !== undefined) return true;
  try {
    const compiler = (await import('@angular/compiler')) as unknown as {
      parseTemplate: TemplateParser;
    };
    angularCompiler = { parseTemplate: compiler.parseTemplate };
    return true;
  } catch {
    return false;
  }
}

function isAngular(fqn: string): boolean {
  return ANGULAR_PACKAGES.some(
    (pkg) => fqn.startsWith(`${pkg}:`) || fqn.startsWith(`${pkg}/`),
  );
}

/** `Component` from `@angular/core:Component`. */
function exportedName(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf(':') + 1);
}

function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
    if (text === name) return property.initializer;
  }
  return undefined;
}

function stringProp(object: ts.ObjectLiteralExpression, name: string): string | null {
  const value = propertyValue(object, name);
  return value !== undefined && ts.isStringLiteralLike(value) && !ts.isTemplateExpression(value)
    ? value.text
    : null;
}

function booleanProp(object: ts.ObjectLiteralExpression, name: string): boolean | null {
  const value = propertyValue(object, name);
  if (value === undefined) return null;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function arrayProp(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ArrayLiteralExpression | null {
  const value = propertyValue(object, name);
  return value !== undefined && ts.isArrayLiteralExpression(value) ? value : null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
