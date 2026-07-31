package dev.stratigraph.extractor.java;

import dev.stratigraph.extractor.java.FactEmitter.NodeRef;
import org.openrewrite.ExecutionContext;
import org.openrewrite.InMemoryExecutionContext;
import org.openrewrite.tree.ParseError;
import org.openrewrite.SourceFile;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.JavaParser;
import org.openrewrite.java.UpdateSourcePositions;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaType;
import org.openrewrite.java.tree.Statement;
import org.openrewrite.java.tree.TypeTree;
import org.openrewrite.java.tree.TypeUtils;
import org.openrewrite.marker.Range;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Walks the parsed source set and emits facts.
 *
 * The rule this class exists to honour: nothing is emitted that the parser did
 * not attribute. An unresolved supertype, an unresolved invocation target or an
 * unresolved annotation produces silence and, where the omission is
 * interesting, a diagnostic — never a guess.
 */
final class JavaFactExtractor {

    private final Path repoRoot;
    private final FactEmitter emitter;
    private final SourceDiscovery discovery;

    /** Type fqn → the file that declared it, so a second declaration can be reported. */
    private final Map<String, String> declaredIn = new LinkedHashMap<>();

    JavaFactExtractor(Path repoRoot, FactEmitter emitter, SourceDiscovery discovery) {
        this.repoRoot = repoRoot;
        this.emitter = emitter;
        this.discovery = discovery;
    }

    void run(SourceDiscovery.Result found) throws IOException {
        for (Path source : found.sources) {
            emitter.file(discovery.relative(source), "java", countLines(source));
        }

        // Framework XML we did not read. Saying so is the difference between
        // "this application has no bean wiring" and "we did not look".
        for (Path config : found.unparsedConfig) {
            emitter.diagnostic(
                    "info",
                    "XML configuration not parsed — bean wiring, servlet mappings and O/R "
                            + "mappings defined here are absent from the graph",
                    discovery.relative(config),
                    null);
        }

        for (Map.Entry<Path, SourceDiscovery.ModuleId> module : found.modules.entrySet()) {
            emitter.node("module", module.getValue().fqn, module.getValue().name,
                    null, null, null, null, null);
        }

        if (found.sources.isEmpty()) {
            return;
        }

        ExecutionContext ctx = new InMemoryExecutionContext(throwable ->
                emitter.diagnostic("warn", "parser: " + throwable, null, null));

        // One pass over every source with a shared type cache, so first-party
        // types resolve across module boundaries even though nothing was built
        // (ADR-0006). Types from jars we never read stay unattributed.
        List<SourceFile> parsed = JavaParser.fromJavaVersion()
                .logCompilationWarningsAndErrors(false)
                .build()
                .parse(found.sources, repoRoot, ctx)
                .toList();

        for (SourceFile sourceFile : parsed) {
            String path = sourceFile.getSourcePath().toString().replace('\\', '/');

            if (sourceFile instanceof ParseError) {
                // Partial results beat no results: one file of unparseable Java
                // must not cost us the map of the other 99,000 lines.
                emitter.diagnostic("error", "could not be parsed as Java", path, null);
                continue;
            }
            if (!(sourceFile instanceof J.CompilationUnit)) {
                continue;
            }

            // The position visitor is stateful, so it needs to be fresh per
            // file. Sharing one leaves every file after the first with no line
            // numbers, which is a silent loss of the provenance every fact
            // is supposed to carry.
            J.CompilationUnit cu = (J.CompilationUnit)
                    new UpdateSourcePositions().getVisitor().visit(sourceFile, ctx);
            if (cu == null) {
                continue;
            }

            SourceDiscovery.ModuleId module =
                    discovery.moduleOf(found, repoRoot.resolve(sourceFile.getSourcePath()));
            visit(cu, path, module);
        }
    }

    private void visit(J.CompilationUnit cu, String path, SourceDiscovery.ModuleId module) {
        // Prefer the attributed package over the printed declaration: it is the
        // same string, but it comes from the type system rather than from
        // re-reading source text.
        String packageName = Fqn.pkg(cu.getClasses().isEmpty() || cu.getClasses().get(0).getType() == null
                ? declaredPackage(cu)
                : cu.getClasses().get(0).getType().getPackageName());

        emitter.node("package", packageName, Fqn.simpleName(packageName),
                new NodeRef("module", module.fqn), null, null, null, null);

        // Declarations before references, so a node is described before
        // anything points at it and the store never has to upgrade a stub for a
        // type this same file went on to declare.
        DeclarationVisitor declarations =
                new DeclarationVisitor(path, packageName, new TypeResolver(cu, packageName));
        declarations.visit(cu, null);
        declarations.reportUnresolvedCalls();

        // Imports belong to the compilation unit, and the store has no node for
        // one. They are attributed to the first top-level type declared in the
        // file: every type in a file shares its package, so the package-level
        // graph is identical either way.
        String importOwner = cu.getClasses().isEmpty()
                ? null
                : Fqn.type(cu.getClasses().get(0).getType());
        if (importOwner != null && !Fqn.UNKNOWN.equals(importOwner)) {
            emitImports(cu, path, importOwner);
        }
    }

    /** Fallback for a compilation unit that declares no type we could attribute. */
    private static String declaredPackage(J.CompilationUnit cu) {
        return cu.getPackageDeclaration() == null
                ? null
                : writtenName(cu.getPackageDeclaration().getExpression());
    }

    /**
     * A type name exactly as the source spells it, read off the tree rather than
     * printed.
     *
     * Printing needs a cursor that can reach the enclosing source file, which
     * makes it awkward to call from a helper and fragile when it is. Walking
     * the name nodes is both simpler and exact — and "exactly as written" is
     * what {@link TypeResolver} needs, since the whole point is to tell
     * `Service` from `org.springframework.stereotype.Service`.
     */
    static String writtenName(Object tree) {
        if (tree instanceof J.Identifier) {
            return ((J.Identifier) tree).getSimpleName();
        }
        if (tree instanceof J.FieldAccess) {
            J.FieldAccess access = (J.FieldAccess) tree;
            String target = writtenName(access.getTarget());
            return target.isEmpty() ? access.getSimpleName() : target + "." + access.getSimpleName();
        }
        if (tree instanceof J.ParameterizedType) {
            return writtenName(((J.ParameterizedType) tree).getClazz());
        }
        if (tree instanceof J.ArrayType) {
            return writtenName(((J.ArrayType) tree).getElementType());
        }
        if (tree instanceof J.AnnotatedType) {
            return writtenName(((J.AnnotatedType) tree).getTypeExpression());
        }
        return "";
    }

    private void emitImports(J.CompilationUnit cu, String path, String owner) {
        Set<String> seen = new LinkedHashSet<>();
        for (J.Import anImport : cu.getImports()) {
            // A wildcard import names no type, so there is no edge to draw. The
            // information loss shows up where it matters -- annotation
            // resolution, ADR-0005 -- as a diagnostic rather than a guess.
            if ("*".equals(anImport.getClassName()) || anImport.isStatic()) {
                continue;
            }
            String target = anImport.getTypeName();
            if (target.equals(owner) || !seen.add(target)) {
                continue;
            }
            emitter.edge("imports",
                    new NodeRef("class", owner),
                    new NodeRef("class", target),
                    path, line(anImport), null);
        }
    }

    /** Emits the declarations in one compilation unit. */
    private final class DeclarationVisitor extends JavaIsoVisitor<Void> {
        private final String path;
        private final String packageName;
        private final TypeResolver resolver;
        private int unresolvedCalls;

        /** Class-level context a method needs: its stereotype and its base path. */
        private final Map<String, ClassContext> contexts = new LinkedHashMap<>();

        DeclarationVisitor(String path, String packageName, TypeResolver resolver) {
            this.path = path;
            this.packageName = packageName;
            this.resolver = resolver;
        }

        @Override
        public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration declaration, Void unused) {
            JavaType.FullyQualified type = declaration.getType();
            if (type == null) {
                emitter.diagnostic("warn",
                        "type of " + declaration.getSimpleName() + " could not be attributed",
                        path, line(declaration));
                return super.visitClassDeclaration(declaration, unused);
            }

            String fqn = Fqn.type(type);
            String kind = nodeKind(declaration.getKind());

            String previous = declaredIn.put(fqn, path);
            if (previous != null && !previous.equals(path)) {
                // Type fqns carry no module (ADR-0007), so vendored or forked
                // copies collide on one node. The node merges; this makes the
                // merge visible rather than silent.
                emitter.diagnostic("warn",
                        fqn + " is declared in more than one file, and the two merge into one node "
                                + "(also declared in " + previous + ")",
                        path, line(declaration));
            }

            Map<String, Object> attrs = new LinkedHashMap<>();
            if (declaration.getKind() == J.ClassDeclaration.Kind.Type.Record) {
                attrs.put("declaration", "record");
            }
            List<String> modifiers = modifiers(declaration.getModifiers());
            if (!modifiers.isEmpty()) {
                attrs.put("modifiers", modifiers);
            }

            emitter.node(kind, fqn, declaration.getSimpleName(),
                    enclosingRef(), path, line(declaration), endLine(declaration), attrs);

            if (declaration.getExtends() != null) {
                emitSupertype("extends", kind, fqn, declaration.getExtends());
            }
            if (declaration.getImplements() != null) {
                // OpenRewrite files an interface's supertypes under
                // `getImplements()`, but Java spells that relationship
                // `extends` and so must we: "interface A implements B" is a
                // sentence about the source that the source does not say.
                String supertypeKind =
                        declaration.getKind() == J.ClassDeclaration.Kind.Type.Interface
                                ? "extends"
                                : "implements";
                for (TypeTree implemented : declaration.getImplements()) {
                    emitSupertype(supertypeKind, kind, fqn, implemented);
                }
            }

            NodeRef self = new NodeRef(kind, fqn);
            List<ResolvedAnnotation> annotations =
                    emitAnnotations(declaration.getLeadingAnnotations(), self);

            ClassContext context = new ClassContext(kind, fqn, annotations, declaration);
            contexts.put(fqn, context);

            emitEntityMapping(context, self, declaration);
            emitConstructorInjection(context, self, declaration);

            return super.visitClassDeclaration(declaration, unused);
        }

        /**
         * Resolve every annotation on a declaration and record the ones we can
         * name. ADR-0005 in one method.
         */
        private List<ResolvedAnnotation> emitAnnotations(List<J.Annotation> annotations, NodeRef target) {
            List<ResolvedAnnotation> resolved = new ArrayList<>();
            for (J.Annotation annotation : annotations) {
                String asWritten = writtenName(annotation.getAnnotationType());
                TypeResolver.Resolved answer = resolver.resolve(annotation.getType(), asWritten);

                if (!answer.isResolved()) {
                    // ADR-0005 rule 4. Emitting no fact *and* no diagnostic
                    // would under-report endpoints as if the codebase had
                    // fewer, which reads the same as a clean bill of health.
                    emitter.diagnostic("warn",
                            "@" + asWritten + " cannot be resolved to a fully qualified name: a "
                                    + "wildcard import makes it ambiguous, so no stereotype, endpoint "
                                    + "or mapping facts are recorded for it",
                            path, line(annotation));
                    continue;
                }

                Map<String, Object> attrs = new LinkedHashMap<>();
                attrs.put("resolution", answer.resolution.wireName);
                emitter.edge("annotated_with", target,
                        new NodeRef("annotation", answer.fqn),
                        path, line(annotation), attrs);

                resolved.add(new ResolvedAnnotation(answer.fqn, annotation));
            }
            return resolved;
        }

        /**
         * `@Entity` plus `@Table(name = ...)` maps a type to a table.
         *
         * Only with an explicit name. An `@Entity` with no `@Table` gets its
         * table name from the persistence provider's naming strategy at
         * runtime -- `Order` becomes `order`, `orders` or `ORDER` depending on
         * configuration we cannot see -- so the honest output is a diagnostic
         * rather than a plausible table.
         */
        private void emitEntityMapping(ClassContext context, NodeRef self, J.ClassDeclaration declaration) {
            if (!context.hasAny(FrameworkAnnotations.JPA_ENTITY)) {
                return;
            }
            ResolvedAnnotation table = context.first(FrameworkAnnotations.JPA_TABLE);
            String name = table == null ? null : new AnnotationArgs(table.node).string("name");
            if (name == null || name.isBlank()) {
                emitter.diagnostic("info",
                        context.fqn + " is an entity with no explicit @Table(name=...); its table "
                                + "name comes from the persistence provider's naming strategy and "
                                + "was not recorded",
                        path, line(declaration));
                return;
            }
            emitter.node("table", Fqn.table(name), name, null, null, null, null, null);
            emitter.edge("maps_to", self, new NodeRef("table", Fqn.table(name)),
                    path, line(table.node), null);
        }

        /**
         * Constructor injection, but only where the source says so.
         *
         * A stereotyped class with exactly one constructor has that
         * constructor's parameters injected -- that is Spring's documented
         * behaviour and it needs no annotation. With several constructors,
         * only an explicitly marked one is an injection point; guessing which
         * of them the container picks is not something source can tell us.
         */
        private void emitConstructorInjection(ClassContext context, NodeRef self, J.ClassDeclaration declaration) {
            List<J.MethodDeclaration> constructors = new ArrayList<>();
            for (Statement statement : declaration.getBody().getStatements()) {
                if (statement instanceof J.MethodDeclaration
                        && ((J.MethodDeclaration) statement).isConstructor()) {
                    constructors.add((J.MethodDeclaration) statement);
                }
            }

            for (J.MethodDeclaration constructor : constructors) {
                boolean marked = resolveAll(constructor.getLeadingAnnotations())
                        .stream().anyMatch(a -> FrameworkAnnotations.INJECTION_MARKERS.contains(a.fqn));
                boolean soleConstructorOfABean =
                        context.stereotype() != null && constructors.size() == 1;
                if (!marked && !soleConstructorOfABean) {
                    continue;
                }
                for (Statement parameter : constructor.getParameters()) {
                    if (parameter instanceof J.VariableDeclarations) {
                        J.VariableDeclarations declared = (J.VariableDeclarations) parameter;
                        emitInjection(self, declared.getTypeExpression(), "constructor",
                                declared.getVariables().isEmpty()
                                        ? null
                                        : declared.getVariables().get(0).getSimpleName(),
                                line(constructor));
                    }
                }
            }
        }

        private void emitInjection(NodeRef target, TypeTree declaredType, String via, String member, Integer line) {
            if (declaredType == null) {
                return;
            }
            String asWritten = writtenName(declaredType);
            TypeResolver.Resolved answer = resolver.resolve(declaredType.getType(), asWritten);
            if (!answer.isResolved()) {
                return;
            }
            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("via", via);
            if (member != null) {
                attrs.put("member", member);
            }
            attrs.put("resolution", answer.resolution.wireName);
            emitter.edge("injects", target,
                    new NodeRef(nodeKindFor(declaredType.getType()), answer.fqn),
                    path, line, attrs);
        }

        private List<ResolvedAnnotation> resolveAll(List<J.Annotation> annotations) {
            List<ResolvedAnnotation> out = new ArrayList<>();
            for (J.Annotation annotation : annotations) {
                String asWritten = writtenName(annotation.getAnnotationType());
                TypeResolver.Resolved answer = resolver.resolve(annotation.getType(), asWritten);
                if (answer.isResolved()) {
                    out.add(new ResolvedAnnotation(answer.fqn, annotation));
                }
            }
            return out;
        }

        @Override
        public J.MethodDeclaration visitMethodDeclaration(J.MethodDeclaration declaration, Void unused) {
            JavaType.Method type = declaration.getMethodType();
            if (type == null) {
                return super.visitMethodDeclaration(declaration, unused);
            }
            Map<String, Object> attrs = new LinkedHashMap<>();
            if (declaration.isConstructor()) {
                attrs.put("constructor", true);
            }
            List<String> modifiers = modifiers(declaration.getModifiers());
            if (!modifiers.isEmpty()) {
                attrs.put("modifiers", modifiers);
            }
            String returns = Fqn.erase(type.getReturnType());
            if (!Fqn.UNKNOWN.equals(returns) && !declaration.isConstructor()) {
                attrs.put("returns", returns);
            }

            NodeRef self = new NodeRef("method", Fqn.method(type));
            emitter.node("method", Fqn.method(type),
                    declaration.isConstructor() ? "<init>" : declaration.getSimpleName(),
                    new NodeRef(nodeKindOf(type.getDeclaringType()), Fqn.type(type.getDeclaringType())),
                    path, line(declaration), endLine(declaration), attrs);

            List<ResolvedAnnotation> annotations =
                    emitAnnotations(declaration.getLeadingAnnotations(), self);
            ClassContext owner = contexts.get(Fqn.type(type.getDeclaringType()));

            emitEndpoints(owner, self, annotations, declaration);
            emitSetterInjection(owner, annotations, declaration);
            return super.visitMethodDeclaration(declaration, unused);
        }

        /**
         * HTTP endpoints, from whichever of the three shapes the code uses.
         *
         * The node's identity is framework-neutral (`GET /api/orders/{id}`,
         * ADR-0007) so a Spring MVC application, a Boot application and a
         * JAX-RS application all land in the same table. `attrs.framework`
         * records which one was actually observed.
         */
        private void emitEndpoints(
                ClassContext owner,
                NodeRef method,
                List<ResolvedAnnotation> annotations,
                J.MethodDeclaration declaration) {
            if (owner == null) {
                return;
            }
            List<String> basePaths = owner.basePaths();

            for (ResolvedAnnotation annotation : annotations) {
                AnnotationArgs args = new AnnotationArgs(annotation.node);

                String shorthand = FrameworkAnnotations.SPRING_METHOD_MAPPINGS.get(annotation.fqn);
                if (shorthand != null) {
                    emitEndpoint(method, basePaths, args.strings("value"), List.of(shorthand),
                            "spring-mvc", line(annotation.node));
                    continue;
                }

                if (FrameworkAnnotations.SPRING_REQUEST_MAPPING.equals(annotation.fqn)) {
                    List<String> paths = args.strings("value");
                    if (paths.isEmpty()) {
                        paths = args.strings("path");
                    }
                    // The pre-Boot form. No `method` element means Spring maps
                    // every verb, and saying ANY is what the source supports.
                    List<String> verbs = args.enumNames("method");
                    emitEndpoint(method, basePaths, paths,
                            verbs.isEmpty() ? List.of("ANY") : verbs, "spring-mvc",
                            line(annotation.node));
                    continue;
                }

                String jaxrs = FrameworkAnnotations.JAXRS_METHODS.get(annotation.fqn);
                if (jaxrs != null) {
                    List<String> paths = new ArrayList<>();
                    for (ResolvedAnnotation other : annotations) {
                        if (FrameworkAnnotations.JAXRS_PATH.contains(other.fqn)) {
                            paths.addAll(new AnnotationArgs(other.node).strings("value"));
                        }
                    }
                    emitEndpoint(method, basePaths, paths, List.of(jaxrs), "jaxrs",
                            line(annotation.node));
                }
            }
        }

        private void emitEndpoint(
                NodeRef method,
                List<String> basePaths,
                List<String> paths,
                List<String> verbs,
                String framework,
                Integer line) {
            List<String> bases = basePaths.isEmpty() ? List.of("") : basePaths;
            List<String> suffixes = paths.isEmpty() ? List.of("") : paths;

            for (String base : bases) {
                for (String suffix : suffixes) {
                    String full = joinPath(base, suffix);
                    for (String verb : verbs) {
                        String fqn = Fqn.endpoint(verb, full);
                        Map<String, Object> attrs = new LinkedHashMap<>();
                        attrs.put("method", verb);
                        attrs.put("path", full);
                        attrs.put("framework", framework);
                        emitter.node("endpoint", fqn, full, null, path, line, null, attrs);
                        emitter.edge("handles", method, new NodeRef("endpoint", fqn), path, line, null);
                    }
                }
            }
        }

        /** `@Autowired` on a setter, which is how a lot of pre-constructor-injection code wires up. */
        private void emitSetterInjection(
                ClassContext owner,
                List<ResolvedAnnotation> annotations,
                J.MethodDeclaration declaration) {
            if (owner == null || declaration.isConstructor()) {
                return;
            }
            boolean marked = annotations.stream()
                    .anyMatch(a -> FrameworkAnnotations.INJECTION_MARKERS.contains(a.fqn));
            if (!marked) {
                return;
            }
            for (Statement parameter : declaration.getParameters()) {
                if (parameter instanceof J.VariableDeclarations) {
                    J.VariableDeclarations declared = (J.VariableDeclarations) parameter;
                    emitInjection(new NodeRef(owner.kind, owner.fqn), declared.getTypeExpression(),
                            "setter", declaration.getSimpleName(), line(declaration));
                }
            }
        }

        @Override
        public J.VariableDeclarations visitVariableDeclarations(J.VariableDeclarations declaration, Void unused) {
            J.ClassDeclaration owner = fieldOwner();
            if (owner == null || owner.getType() == null) {
                return super.visitVariableDeclarations(declaration, unused);
            }
            String ownerFqn = Fqn.type(owner.getType());
            String ownerKind = nodeKind(owner.getKind());

            List<ResolvedAnnotation> annotations = resolveAll(declaration.getLeadingAnnotations());
            ResolvedAnnotation column = first(annotations, FrameworkAnnotations.JPA_COLUMN);
            String columnName = column == null ? null : new AnnotationArgs(column.node).string("name");
            boolean isId = first(annotations, FrameworkAnnotations.JPA_ID) != null;

            for (J.VariableDeclarations.NamedVariable variable : declaration.getVariables()) {
                Map<String, Object> attrs = new LinkedHashMap<>();
                String fieldType = Fqn.erase(declaration.getType());
                if (!Fqn.UNKNOWN.equals(fieldType)) {
                    attrs.put("type", fieldType);
                }
                // `List<Pet>` erases to `java.util.List`, which is right for
                // the fqn and useless to anything that wants to know what the
                // collection holds — an ER relationship, most of all. The
                // arguments are attributed facts, so they are kept beside the
                // erased type rather than folded into it.
                List<String> typeArguments = Fqn.typeArguments(declaration.getType());
                if (!typeArguments.isEmpty()) {
                    attrs.put("typeArguments", typeArguments);
                }
                List<String> modifiers = modifiers(declaration.getModifiers());
                if (!modifiers.isEmpty()) {
                    attrs.put("modifiers", modifiers);
                }
                // The column name is a fact only when @Column states it; the
                // default is the provider's naming strategy, same as @Table.
                if (columnName != null && !columnName.isBlank()) {
                    attrs.put("column", columnName);
                }
                if (isId) {
                    attrs.put("id", true);
                }

                NodeRef self = new NodeRef("field",
                        Fqn.field(ownerFqn, variable.getSimpleName()));
                emitter.node("field", Fqn.field(ownerFqn, variable.getSimpleName()),
                        variable.getSimpleName(),
                        new NodeRef(ownerKind, ownerFqn),
                        path, line(declaration), null, attrs);
                emitAnnotations(declaration.getLeadingAnnotations(), self);

                // Field injection: the pre-constructor-injection style that
                // most legacy Spring code is written in.
                if (annotations.stream()
                        .anyMatch(a -> FrameworkAnnotations.INJECTION_MARKERS.contains(a.fqn))) {
                    emitInjection(new NodeRef(ownerKind, ownerFqn), declaration.getTypeExpression(),
                            "field", variable.getSimpleName(), line(declaration));
                }
            }
            return super.visitVariableDeclarations(declaration, unused);
        }

        @Override
        public J.MethodInvocation visitMethodInvocation(J.MethodInvocation invocation, Void unused) {
            emitCall(invocation.getMethodType(), line(invocation));
            return super.visitMethodInvocation(invocation, unused);
        }

        @Override
        public J.NewClass visitNewClass(J.NewClass newClass, Void unused) {
            emitCall(newClass.getMethodType(), line(newClass));
            return super.visitNewClass(newClass, unused);
        }

        @Override
        public J.MemberReference visitMemberReference(J.MemberReference reference, Void unused) {
            // `String::valueOf` is a call site too, and one that a naive
            // extractor misses entirely.
            emitCall(reference.getMethodType(), line(reference));
            return super.visitMemberReference(reference, unused);
        }

        /**
         * Record a call, but only when the parser attributed the target.
         *
         * An unattributed invocation is one whose declaring type came from a
         * jar we never read (ADR-0006). We know the method's *name* and could
         * write an edge to a plausible fqn; that is exactly the confident guess
         * CLAUDE.md forbids, so we count it instead and say how many there were.
         */
        private void emitCall(JavaType.Method target, Integer line) {
            if (target == null || Fqn.unresolved(target.getDeclaringType())) {
                unresolvedCalls++;
                return;
            }
            NodeRef caller = enclosingCallerRef();
            if (caller == null) {
                return;
            }
            emitter.edge("calls", caller,
                    new NodeRef("method", Fqn.method(target)),
                    path, line, null);
        }

        /**
         * What a call site belongs to: the enclosing method, or the enclosing
         * type when the call sits in a field initialiser or a static block.
         */
        private NodeRef enclosingCallerRef() {
            J.MethodDeclaration method = getCursor().firstEnclosing(J.MethodDeclaration.class);
            if (method != null && method.getMethodType() != null) {
                return new NodeRef("method", Fqn.method(method.getMethodType()));
            }
            J.ClassDeclaration type = getCursor().firstEnclosing(J.ClassDeclaration.class);
            if (type != null && type.getType() != null) {
                return new NodeRef(nodeKind(type.getKind()), Fqn.type(type.getType()));
            }
            return null;
        }

        /**
         * One diagnostic per file rather than per call site. A large repository
         * has millions of calls into jars it never read; a row each would
         * drown the store and tell the reader nothing a count does not.
         */
        void reportUnresolvedCalls() {
            if (unresolvedCalls > 0) {
                emitter.diagnostic("info",
                        unresolvedCalls + " call site(s) could not be resolved to a declaring type "
                                + "and were not recorded as edges",
                        path, null);
            }
        }

        /**
         * A supertype edge, resolved through imports when the parser could not
         * attribute the type.
         *
         * This matters more than it looks. Without a classpath the supertype of
         * anything interesting in an enterprise codebase — `HttpServlet`,
         * `JpaRepository`, `AbstractController` — is unattributed, and dropping
         * all of them would leave the inheritance graph empty on exactly the
         * repositories this tool is for. `import x.y.Z; class C extends Z` names
         * the supertype outright, which is a fact the parser read (ADR-0005),
         * not a type we inferred.
         */
        private void emitSupertype(String edgeKind, String ownerKind, String ownerFqn, TypeTree supertype) {
            String asWritten = writtenName(supertype);
            TypeResolver.Resolved answer = resolver.resolve(supertype.getType(), asWritten);

            if (!answer.isResolved()) {
                emitter.diagnostic("info",
                        "supertype " + asWritten + " of " + ownerFqn + " cannot be resolved to a "
                                + "fully qualified name: a wildcard import makes it ambiguous",
                        path, line(supertype));
                return;
            }

            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("resolution", answer.resolution.wireName);
            emitter.edge(edgeKind,
                    new NodeRef(ownerKind, ownerFqn),
                    new NodeRef(nodeKindFor(supertype.getType()), answer.fqn),
                    path, line(supertype), attrs);
        }

        /**
         * The enclosing declaration: a type for a nested one, otherwise the
         * package.
         *
         * Searched from the *parent* cursor. `firstEnclosing` starts at the
         * cursor's own value, so asking the current cursor for the enclosing
         * class declaration while visiting a class declaration answers with
         * that same class — which makes every top-level type its own parent.
         */
        private NodeRef enclosingRef() {
            J.ClassDeclaration enclosing =
                    getCursor().getParentTreeCursor().firstEnclosing(J.ClassDeclaration.class);
            if (enclosing != null && enclosing.getType() != null) {
                return new NodeRef(nodeKind(enclosing.getKind()), Fqn.type(enclosing.getType()));
            }
            return new NodeRef("package", packageName);
        }

        /**
         * The class a {@code VariableDeclarations} belongs to, if it is a field.
         * The same node models locals and parameters, which are not facts about
         * structure and are not emitted.
         */
        private J.ClassDeclaration fieldOwner() {
            Object parent = getCursor().getParentTreeCursor().getValue();
            if (!(parent instanceof J.Block)) {
                return null;
            }
            Object grandparent = getCursor().getParentTreeCursor().getParentTreeCursor().getValue();
            return grandparent instanceof J.ClassDeclaration ? (J.ClassDeclaration) grandparent : null;
        }
    }

    /** An annotation we were able to name, paired with the node it was written on. */
    private static final class ResolvedAnnotation {
        final String fqn;
        final J.Annotation node;

        ResolvedAnnotation(String fqn, J.Annotation node) {
            this.fqn = fqn;
            this.node = node;
        }
    }

    /** What a method needs to know about the class it is declared in. */
    private static final class ClassContext {
        final String kind;
        final String fqn;
        private final List<ResolvedAnnotation> annotations;
        private final J.ClassDeclaration declaration;

        ClassContext(String kind, String fqn, List<ResolvedAnnotation> annotations,
                     J.ClassDeclaration declaration) {
            this.kind = kind;
            this.fqn = fqn;
            this.annotations = annotations;
            this.declaration = declaration;
        }

        /** The stereotype this class declares, or null when it declares none we recognise. */
        String stereotype() {
            for (ResolvedAnnotation annotation : annotations) {
                String stereotype = FrameworkAnnotations.STEREOTYPES.get(annotation.fqn);
                if (stereotype != null) {
                    return stereotype;
                }
            }
            return null;
        }

        /** Class-level path prefixes, from Spring's `@RequestMapping` or JAX-RS's `@Path`. */
        List<String> basePaths() {
            List<String> paths = new ArrayList<>();
            for (ResolvedAnnotation annotation : annotations) {
                if (FrameworkAnnotations.SPRING_REQUEST_MAPPING.equals(annotation.fqn)) {
                    AnnotationArgs args = new AnnotationArgs(annotation.node);
                    paths.addAll(args.strings("value"));
                    paths.addAll(args.strings("path"));
                } else if (FrameworkAnnotations.JAXRS_PATH.contains(annotation.fqn)) {
                    paths.addAll(new AnnotationArgs(annotation.node).strings("value"));
                }
            }
            return paths;
        }

        boolean hasAny(java.util.Set<String> fqns) {
            return first(fqns) != null;
        }

        ResolvedAnnotation first(java.util.Set<String> fqns) {
            for (ResolvedAnnotation annotation : annotations) {
                if (fqns.contains(annotation.fqn)) {
                    return annotation;
                }
            }
            return null;
        }

        @SuppressWarnings("unused")
        J.ClassDeclaration declaration() {
            return declaration;
        }
    }

    private static ResolvedAnnotation first(List<ResolvedAnnotation> annotations, Set<String> fqns) {
        for (ResolvedAnnotation annotation : annotations) {
            if (fqns.contains(annotation.fqn)) {
                return annotation;
            }
        }
        return null;
    }

    /**
     * Join a class-level path prefix to a method-level suffix.
     *
     * Purely mechanical string work over two values the source states, which is
     * why the result is still a fact rather than a derivation.
     */
    static String joinPath(String base, String suffix) {
        String joined = base.trim() + "/" + suffix.trim();
        joined = joined.replaceAll("/{2,}", "/");
        if (!joined.startsWith("/")) {
            joined = "/" + joined;
        }
        if (joined.length() > 1 && joined.endsWith("/")) {
            joined = joined.substring(0, joined.length() - 1);
        }
        return joined;
    }

    /** Node kind for a referenced type, falling back to `class` when nothing attributed it. */
    static String nodeKindFor(JavaType type) {
        JavaType.FullyQualified resolved = TypeUtils.asFullyQualified(type);
        return resolved == null ? "class" : nodeKindOf(resolved);
    }

    private static List<String> modifiers(List<J.Modifier> modifiers) {
        List<String> out = new ArrayList<>();
        for (J.Modifier modifier : modifiers) {
            if (modifier.getType() != J.Modifier.Type.LanguageExtension) {
                out.add(modifier.getType().name().toLowerCase(java.util.Locale.ROOT));
            }
        }
        return out;
    }

    /** The fact vocabulary has no `record`; a record is a class that says so in its attrs. */
    private static String nodeKind(J.ClassDeclaration.Kind.Type kind) {
        switch (kind) {
            case Interface:
                return "interface";
            case Enum:
                return "enum";
            case Annotation:
                return "annotation";
            default:
                return "class";
        }
    }

    /**
     * The node kind for a referenced type. Only the parser knows whether it is
     * an interface, and for a type we never parsed it does not know either — in
     * which case `class` is the vocabulary's general term, and the node is a
     * stub anyway.
     */
    static String nodeKindOf(JavaType.FullyQualified type) {
        if (type == null || type.getKind() == null) {
            return "class";
        }
        switch (type.getKind()) {
            case Interface:
                return "interface";
            case Enum:
                return "enum";
            case Annotation:
                return "annotation";
            default:
                return "class";
        }
    }

    static Integer line(J node) {
        return node.getMarkers().findFirst(Range.class)
                .map(range -> range.getStart().getLine())
                .orElse(null);
    }

    static Integer endLine(J node) {
        return node.getMarkers().findFirst(Range.class)
                .map(range -> range.getEnd().getLine())
                .orElse(null);
    }

    private static int countLines(Path file) {
        try (var lines = Files.lines(file)) {
            return (int) lines.count();
        } catch (Exception e) {
            return 0;
        }
    }
}
