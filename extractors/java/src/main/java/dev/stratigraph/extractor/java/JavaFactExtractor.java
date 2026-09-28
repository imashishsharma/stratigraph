package dev.stratigraph.extractor.java;

import dev.stratigraph.extractor.java.FactEmitter.NodeRef;
import org.openrewrite.ExecutionContext;
import org.openrewrite.InMemoryExecutionContext;
import org.openrewrite.tree.ParseError;
import org.openrewrite.SourceFile;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.JavaParser;
import org.openrewrite.kotlin.KotlinParser;
import org.openrewrite.java.UpdateSourcePositions;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaSourceFile;
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

    /** Entities, repositories and queries, resolved after every file is read (ADR-0036). */
    private final Persistence persistence = new Persistence();

    /** The build module directory of the file being visited. */
    private Path currentModuleDir;

    /**
     * Constructor injections of classes with no stereotype, held until the end
     * of the run: they are injections only if some {@code @Bean} method
     * constructs the class, which may be in any file (ADR-0043).
     */
    private final Map<String, List<Runnable>> pendingBeanInjections = new LinkedHashMap<>();

    /** OpenAPI operations declared in the repository, for API-first controllers (ADR-0044). */
    private OpenApiSpecs specs;

    /** Spec files already announced with a `file` fact. */
    private final Set<String> specFilesEmitted = new LinkedHashSet<>();

    /** Classes a {@code @Bean} method returns or constructs. */
    private final Set<String> beanClasses = new LinkedHashSet<>();

    /** Dependency jars for type attribution; empty is source-only (ADR-0006, ADR-0039). */
    private List<Path> classpath = List.of();

    JavaFactExtractor withClasspath(List<Path> jars) {
        this.classpath = List.copyOf(jars);
        return this;
    }

    /** Package fqn → module fqn → where it was first declared there, for ADR-0041. */
    private final Map<String, Map<String, Object[]>> packageModules = new LinkedHashMap<>();

    JavaFactExtractor(Path repoRoot, FactEmitter emitter, SourceDiscovery discovery) {
        this.repoRoot = repoRoot;
        this.emitter = emitter;
        this.discovery = discovery;
    }

    void run(SourceDiscovery.Result found) throws IOException {
        for (Path source : found.sources) {
            emitter.file(discovery.relative(source), languageOf(source), countLines(source));
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
                    null, null, null, null, module.getValue().attrs);
        }

        if (found.sources.isEmpty()) {
            return;
        }

        ExecutionContext ctx = new InMemoryExecutionContext(throwable ->
                emitter.diagnostic("warn", "parser: " + throwable, null, null));

        // One pass over every source with a shared type cache, so first-party
        // types resolve across module boundaries even though nothing was built
        // (ADR-0006). Types from jars we never read stay unattributed.
        //
        // Java and Kotlin are parsed by different parsers and then walked by the
        // same visitor: OpenRewrite's Kotlin LST is built out of the same `J`
        // elements, so a class is a `J.ClassDeclaration` whichever language
        // declared it (ADR-0029). What the two parsers do not share is the type
        // cache, so a Kotlin class extending a Java one in the same repository
        // resolves only as far as each parser saw — stated in the diagnostics
        // rather than papered over.
        List<Path> javaSources = new ArrayList<>();
        List<Path> kotlinSources = new ArrayList<>();
        for (Path source : found.sources) {
            (isKotlin(source) ? kotlinSources : javaSources).add(source);
        }

        List<SourceFile> parsed = new ArrayList<>();
        if (!javaSources.isEmpty()) {
            parsed.addAll(JavaParser.fromJavaVersion()
                    .logCompilationWarningsAndErrors(false)
                    .classpath(classpath)
                    .build()
                    .parse(javaSources, repoRoot, ctx)
                    .toList());
        }
        if (!kotlinSources.isEmpty()) {
            parsed.addAll(KotlinParser.builder()
                    .logCompilationWarningsAndErrors(false)
                    .classpath(classpath)
                    .build()
                    .parse(kotlinSources, repoRoot, ctx)
                    .toList());
        }

        // ADR-0023 condition 3 needs every declared type's simple name, nested
        // types included, before any resolution happens. A file that failed to
        // parse contributes nothing here; it reports its own error below, so
        // the loss is visible rather than silent.
        Map<String, String> declaredTypeNames = declaredTypeNames(parsed);
        Set<String> declaredPackages = declaredPackages(parsed);
        Constants.collect(parsed);
        specs = OpenApiSpecs.discover(repoRoot,
                Set.of("node_modules", "target", "build", "dist", ".git", ".idea", ".gradle"));
        META.clear();
        META.putAll(metaAnnotations(parsed, declaredTypeNames, declaredPackages));

        for (SourceFile sourceFile : parsed) {
            String path = sourceFile.getSourcePath().toString().replace('\\', '/');

            if (sourceFile instanceof ParseError) {
                // Partial results beat no results: one file of unparseable Java
                // must not cost us the map of the other 99,000 lines.
                emitter.diagnostic("error",
                        "could not be parsed as " + (path.endsWith(".kt") ? "Kotlin" : "Java"),
                        path, null);
                continue;
            }
            // JavaSourceFile, not J.CompilationUnit: Kotlin parses to a
            // K.CompilationUnit, which is not a J.CompilationUnit but is a
            // JavaSourceFile — the interface carrying the package declaration,
            // the imports and the classes, which is everything read below. Kept
            // as the narrower type this walked every Kotlin file straight past
            // and emitted a file fact with no declarations under it (ADR-0029).
            if (!(sourceFile instanceof JavaSourceFile)) {
                continue;
            }

            // The position visitor is stateful, so it needs to be fresh per
            // file. Sharing one leaves every file after the first with no line
            // numbers, which is a silent loss of the provenance every fact
            // is supposed to carry.
            JavaSourceFile cu = (JavaSourceFile)
                    new UpdateSourcePositions().getVisitor().visit(sourceFile, ctx);
            if (cu == null) {
                continue;
            }

            Path absolute = repoRoot.resolve(sourceFile.getSourcePath());
            SourceDiscovery.ModuleId module = discovery.moduleOf(found, absolute);
            currentModuleDir = moduleDirOf(found, absolute);
            visit(cu, path, module, declaredTypeNames, declaredPackages);
        }

        persistence.finish(emitter, repoRoot);
        for (String bean : beanClasses) {
            for (Runnable injection : pendingBeanInjections.getOrDefault(bean, List.of())) {
                injection.run();
            }
        }
    }

    /** Same walk as {@link SourceDiscovery#moduleOf}, answering with the directory. */
    private Path moduleDirOf(SourceDiscovery.Result found, Path source) {
        for (Path dir : found.modules.keySet()) {
            if (source.startsWith(dir)) {
                return dir;
            }
        }
        return found.modules.isEmpty() ? repoRoot : found.modules.keySet().iterator().next();
    }

    /**
     * First-party annotation type → the annotations on its declaration
     * (ADR-0043). {@code @AnonymousGetMapping} declared with
     * {@code @RequestMapping(method = GET)} is a GET mapping wherever it is
     * used; an annotation declared with {@code @Component} is a stereotype.
     */
    private static final Map<String, List<ResolvedAnnotation>> META = new java.util.HashMap<>();

    private static Map<String, List<ResolvedAnnotation>> metaAnnotations(
            List<SourceFile> parsed, Map<String, String> declaredTypeNames, Set<String> declaredPackages) {
        Map<String, List<ResolvedAnnotation>> meta = new java.util.HashMap<>();
        for (SourceFile sourceFile : parsed) {
            if (!(sourceFile instanceof JavaSourceFile)) {
                continue;
            }
            JavaSourceFile cu = (JavaSourceFile) sourceFile;
            String packageName = Fqn.pkg(cu.getClasses().isEmpty() || cu.getClasses().get(0).getType() == null
                    ? declaredPackage(cu)
                    : cu.getClasses().get(0).getType().getPackageName());
            String path = sourceFile.getSourcePath().toString().replace('\\', '/');
            TypeResolver resolver = new TypeResolver(cu, packageName, declaredTypeNames, declaredPackages,
                    path.endsWith(".kt"));
            new JavaIsoVisitor<Void>() {
                @Override
                public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration declaration, Void unused) {
                    if (declaration.getKind() == J.ClassDeclaration.Kind.Type.Annotation
                            && declaration.getType() != null) {
                        List<ResolvedAnnotation> on = new ArrayList<>();
                        for (J.Annotation annotation : declaration.getLeadingAnnotations()) {
                            TypeResolver.Resolved answer = resolver.resolve(
                                    annotation.getType(), writtenName(annotation.getAnnotationType()));
                            if (answer.isResolved()) {
                                on.add(new ResolvedAnnotation(answer.fqn, annotation));
                            }
                        }
                        meta.put(Fqn.type(declaration.getType()), on);
                    }
                    return super.visitClassDeclaration(declaration, unused);
                }
            }.visit(cu, null);
        }
        return meta;
    }

    /** The annotations an annotation carries, transitively, a few levels deep. */
    private static List<ResolvedAnnotation> metaOf(String fqn) {
        List<ResolvedAnnotation> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        List<String> frontier = List.of(fqn);
        for (int depth = 0; depth < 3 && !frontier.isEmpty(); depth++) {
            List<String> next = new ArrayList<>();
            for (String current : frontier) {
                for (ResolvedAnnotation annotation : META.getOrDefault(current, List.of())) {
                    if (seen.add(annotation.fqn)) {
                        out.add(annotation);
                        next.add(annotation.fqn);
                    }
                }
            }
            frontier = next;
        }
        return out;
    }

    /** Every package the parsed source set declares a type in (ADR-0038). */
    private static Set<String> declaredPackages(List<SourceFile> parsed) {
        Set<String> packages = new LinkedHashSet<>();
        for (SourceFile sourceFile : parsed) {
            if (sourceFile instanceof JavaSourceFile) {
                J.Package declared = ((JavaSourceFile) sourceFile).getPackageDeclaration();
                if (declared != null) {
                    packages.add(declared.getExpression().printTrimmed().replaceAll("\\s", ""));
                }
            }
        }
        return packages;
    }

    /** Every type simple name the parsed source set declares, mapped to one file declaring it. */
    private static Map<String, String> declaredTypeNames(List<SourceFile> parsed) {
        Map<String, String> names = new LinkedHashMap<>();
        for (SourceFile sourceFile : parsed) {
            if (!(sourceFile instanceof JavaSourceFile)) {
                continue;
            }
            String path = sourceFile.getSourcePath().toString().replace('\\', '/');
            new JavaIsoVisitor<Void>() {
                @Override
                public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration declaration, Void unused) {
                    names.putIfAbsent(declaration.getSimpleName(), path);
                    return super.visitClassDeclaration(declaration, unused);
                }
            }.visit((JavaSourceFile) sourceFile, null);
        }
        return names;
    }

    private void visit(JavaSourceFile cu, String path, SourceDiscovery.ModuleId module,
                       Map<String, String> declaredTypeNames, Set<String> declaredPackages) {
        // Prefer the attributed package over the printed declaration: it is the
        // same string, but it comes from the type system rather than from
        // re-reading source text.
        String packageName = Fqn.pkg(cu.getClasses().isEmpty() || cu.getClasses().get(0).getType() == null
                ? declaredPackage(cu)
                : cu.getClasses().get(0).getType().getPackageName());

        emitter.node("package", packageName, Fqn.simpleName(packageName),
                new NodeRef("module", module.fqn), null, null, null, null);
        recordPackageMembership(packageName, module, path,
                cu.getPackageDeclaration() == null ? null : line(cu.getPackageDeclaration()));

        // Declarations before references, so a node is described before
        // anything points at it and the store never has to upgrade a stub for a
        // type this same file went on to declare.
        DeclarationVisitor declarations =
                new DeclarationVisitor(path, packageName,
                        new TypeResolver(cu, packageName, declaredTypeNames, declaredPackages, path.endsWith(".kt")));
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

    /**
     * A package declared in more than one module is split (ADR-0041). The
     * package node was emitted once, with the first module as its parent; from
     * the second module on, each module's membership is a `contains` edge cited
     * at the first package declaration seen in that module, and the split is
     * reported. An unsplit package gets no edge: its `parent` says everything.
     */
    private void recordPackageMembership(String packageName, SourceDiscovery.ModuleId module,
                                         String path, Integer line) {
        Map<String, Object[]> modules = packageModules.computeIfAbsent(packageName, k -> new LinkedHashMap<>());
        if (modules.containsKey(module.fqn)) {
            return;
        }
        modules.put(module.fqn, new Object[]{path, line});
        if (modules.size() < 2) {
            return;
        }
        // The first module's membership was implicit until now.
        List<String> toEmit = modules.size() == 2 ? List.copyOf(modules.keySet()) : List.of(module.fqn);
        for (String moduleFqn : toEmit) {
            Object[] at = modules.get(moduleFqn);
            emitter.edge("contains", new NodeRef("module", moduleFqn), new NodeRef("package", packageName),
                    (String) at[0], (Integer) at[1], null);
        }
        emitter.diagnostic("info",
                "package " + packageName + " is split across modules " + String.join(", ", modules.keySet())
                        + "; each module's half is recorded with a contains edge",
                path, line);
    }

    /** Fallback for a compilation unit that declares no type we could attribute. */
    private static String declaredPackage(JavaSourceFile cu) {
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

    private void emitImports(JavaSourceFile cu, String path, String owner) {
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
            // A Kotlin `object : T { }` expression parses as a class with no
            // name. It is not a declared type and has no identity of its own.
            if (declaration.getSimpleName().isBlank()) {
                return super.visitClassDeclaration(declaration, unused);
            }
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

            recordPersistence(context, declaration);
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
                    // ADR-0023: the refusal states which condition failed, so
                    // the report can say what would resolve it.
                    emitter.diagnostic("warn",
                            "@" + asWritten + " cannot be resolved to a fully qualified name: "
                                    + answer.whyAmbiguous() + ", so no stereotype, endpoint "
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
         * What this type says about persistence, recorded for the whole-build
         * pass in {@link Persistence} (ADR-0036): an {@code @Entity}'s names,
         * schema, inheritance strategy and superclass, or a Spring Data
         * repository's entity type argument. No table is decided here.
         */
        private void recordPersistence(ClassContext context, J.ClassDeclaration declaration) {
            if (context.hasAny(FrameworkAnnotations.JPA_ENTITY)) {
                Persistence.EntityInfo info = new Persistence.EntityInfo(
                        context.fqn, declaration.getSimpleName(), path, line(declaration), currentModuleDir);
                ResolvedAnnotation entity = context.first(FrameworkAnnotations.JPA_ENTITY);
                info.entityName = new AnnotationArgs(entity.node).string("name");
                ResolvedAnnotation table = context.first(FrameworkAnnotations.JPA_TABLE);
                if (table != null) {
                    AnnotationArgs args = new AnnotationArgs(table.node);
                    info.tableName = args.string("name");
                    info.schema = args.string("schema");
                    info.tableLine = line(table.node);
                }
                ResolvedAnnotation inheritance = context.first(FrameworkAnnotations.JPA_INHERITANCE);
                if (inheritance != null) {
                    List<String> strategy = new AnnotationArgs(inheritance.node).enumNames("strategy");
                    info.inheritance = strategy.isEmpty() ? "SINGLE_TABLE" : strategy.get(0);
                }
                if (declaration.getExtends() != null) {
                    TypeResolver.Resolved parent = resolver.resolve(
                            declaration.getExtends().getType(), writtenName(declaration.getExtends()));
                    if (parent.isResolved()) {
                        info.superclass = parent.fqn;
                    }
                }
                persistence.entity(info);
            }

            if (declaration.getKind() == J.ClassDeclaration.Kind.Type.Interface
                    && declaration.getImplements() != null) {
                for (TypeTree supertype : declaration.getImplements()) {
                    if (!(supertype instanceof J.ParameterizedType)) {
                        continue;
                    }
                    J.ParameterizedType parameterized = (J.ParameterizedType) supertype;
                    TypeResolver.Resolved raw = resolver.resolve(
                            parameterized.getClazz().getType(), writtenName((TypeTree) parameterized.getClazz()));
                    if (!raw.isResolved() || !FrameworkAnnotations.SPRING_DATA_REPOSITORIES.contains(raw.fqn)
                            || parameterized.getTypeParameters() == null
                            || parameterized.getTypeParameters().isEmpty()
                            || !(parameterized.getTypeParameters().get(0) instanceof TypeTree)) {
                        continue;
                    }
                    TypeTree entityType = (TypeTree) parameterized.getTypeParameters().get(0);
                    TypeResolver.Resolved entity = resolver.resolve(entityType.getType(), writtenName(entityType));
                    if (entity.isResolved()) {
                        persistence.repository(new Persistence.RepositoryInfo(
                                context.fqn, entity.fqn, path, line(supertype)));
                    }
                }
            }
        }

        /** A Spring Data {@code @Query}: the string, and whether it is native SQL or JPQL. */
        private void recordQuery(List<ResolvedAnnotation> annotations, JavaType.Method type) {
            for (ResolvedAnnotation annotation : annotations) {
                if (!FrameworkAnnotations.SPRING_DATA_QUERY.equals(annotation.fqn)) {
                    continue;
                }
                AnnotationArgs args = new AnnotationArgs(annotation.node);
                String query = args.string("value");
                if (query == null || query.isBlank()) {
                    continue;
                }
                boolean nativeSql = args.bool("nativeQuery");
                persistence.query(new Persistence.QueryInfo(Fqn.method(type), query, nativeSql,
                        nativeSql ? "native-query" : "jpql-query", path, line(annotation.node)));
            }
        }

        /**
         * A literal SQL string passed to a JDBC-style method ({@code jdbc.query("SELECT ...")}).
         *
         * Recognised by the literal, not by the receiver's type: without a
         * classpath {@code JdbcTemplate} is unattributed, but a first argument
         * that is a literal beginning with a SQL verb, passed to one of the
         * JDBC method names, is SQL whichever library receives it.
         */
        private void recordJdbc(J.MethodInvocation invocation) {
            if (!FrameworkAnnotations.JDBC_SQL_METHODS.contains(invocation.getSimpleName())
                    || invocation.getArguments().isEmpty()) {
                return;
            }
            String sql = AnnotationArgs.literal(invocation.getArguments().get(0));
            if (sql == null || !Persistence.Sql.looksLikeSql(sql)) {
                return;
            }
            J.MethodDeclaration enclosing = getCursor().firstEnclosing(J.MethodDeclaration.class);
            if (enclosing == null || enclosing.getMethodType() == null) {
                return;
            }
            persistence.query(new Persistence.QueryInfo(Fqn.method(enclosing.getMethodType()), sql, true,
                    "sql-literal", path, line(invocation)));
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

            emitLombokInjection(context, self, declaration, constructors);

            for (J.MethodDeclaration constructor : constructors) {
                boolean marked = resolveAll(constructor.getLeadingAnnotations())
                        .stream().anyMatch(a -> FrameworkAnnotations.INJECTION_MARKERS.contains(a.fqn));
                boolean soleConstructorOfABean =
                        context.stereotype() != null && constructors.size() == 1;
                if (!marked && !soleConstructorOfABean) {
                    // Perhaps a bean all the same, if a @Bean method constructs
                    // it: resolve now, emit at the end only if one does.
                    if (constructors.size() == 1) {
                        List<Runnable> pending = pendingBeanInjections.computeIfAbsent(context.fqn, k -> new ArrayList<>());
                        deferred = pending;
                        try {
                            for (Statement parameter : constructor.getParameters()) {
                                if (parameter instanceof J.VariableDeclarations) {
                                    J.VariableDeclarations declared = (J.VariableDeclarations) parameter;
                                    emitInjection(self, declared.getTypeExpression(), "bean-constructor",
                                            declared.getVariables().isEmpty()
                                                    ? null
                                                    : declared.getVariables().get(0).getSimpleName(),
                                            line(constructor));
                                }
                            }
                        } finally {
                            deferred = null;
                        }
                    }
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

        /**
         * Lombok writes the constructor a bean is injected through
         * (ADR-0039). {@code @RequiredArgsConstructor} takes every final or
         * {@code @NonNull} instance field without an initializer;
         * {@code @AllArgsConstructor} takes every instance field. Only for a
         * stereotyped class with no hand-written constructor — the same
         * sole-constructor rule Spring applies, with Lombok's constructor as
         * the sole one.
         */
        private void emitLombokInjection(ClassContext context, NodeRef self, J.ClassDeclaration declaration,
                                         List<J.MethodDeclaration> constructors) {
            if (context.stereotype() == null || !constructors.isEmpty()) {
                return;
            }
            boolean required = context.hasAny(Set.of(FrameworkAnnotations.LOMBOK_REQUIRED_ARGS));
            boolean all = context.hasAny(Set.of(FrameworkAnnotations.LOMBOK_ALL_ARGS));
            if (!required && !all) {
                return;
            }
            for (Statement statement : declaration.getBody().getStatements()) {
                if (!(statement instanceof J.VariableDeclarations)) {
                    continue;
                }
                J.VariableDeclarations field = (J.VariableDeclarations) statement;
                List<String> modifiers = modifiers(field.getModifiers());
                if (modifiers.contains("static")) {
                    continue;
                }
                boolean nonNull = resolveAll(field.getLeadingAnnotations()).stream()
                        .anyMatch(a -> FrameworkAnnotations.LOMBOK_NON_NULL.equals(a.fqn));
                for (J.VariableDeclarations.NamedVariable variable : field.getVariables()) {
                    boolean initialised = variable.getInitializer() != null;
                    boolean takes = all
                            ? !(modifiers.contains("final") && initialised)
                            : (modifiers.contains("final") || nonNull) && !initialised;
                    if (takes) {
                        emitInjection(self, field.getTypeExpression(),
                                all ? "lombok-all-args" : "lombok-required-args",
                                variable.getSimpleName(), line(field));
                    }
                }
            }
        }

        /** A {@code @Bean} method's parameters are injected into its configuration class (ADR-0039). */
        private void emitBeanMethodInjection(ClassContext owner, List<ResolvedAnnotation> annotations,
                                             J.MethodDeclaration declaration) {
            if (owner == null || annotations.stream()
                    .noneMatch(a -> FrameworkAnnotations.SPRING_BEAN.equals(a.fqn))) {
                return;
            }
            // What the method builds is a bean: its declared return type, and
            // every class it constructs (ADR-0043).
            if (declaration.getReturnTypeExpression() != null) {
                TypeResolver.Resolved returned = resolver.resolve(
                        declaration.getReturnTypeExpression().getType(), writtenName(declaration.getReturnTypeExpression()));
                if (returned.isResolved()) {
                    beanClasses.add(returned.fqn);
                }
            }
            if (declaration.getBody() != null) {
                new JavaIsoVisitor<Void>() {
                    @Override
                    public J.NewClass visitNewClass(J.NewClass created, Void unused) {
                        if (created.getClazz() instanceof TypeTree) {
                            TypeTree clazz = (TypeTree) created.getClazz();
                            TypeResolver.Resolved built = resolver.resolve(clazz.getType(), writtenName(clazz));
                            if (built.isResolved()) {
                                beanClasses.add(built.fqn);
                            }
                        }
                        return super.visitNewClass(created, unused);
                    }
                }.visit(declaration.getBody(), null);
            }
            for (Statement parameter : declaration.getParameters()) {
                if (parameter instanceof J.VariableDeclarations) {
                    J.VariableDeclarations declared = (J.VariableDeclarations) parameter;
                    emitInjection(new NodeRef(owner.kind, owner.fqn), declared.getTypeExpression(),
                            "bean-method", declaration.getSimpleName(), line(declaration));
                }
            }
        }

        /** When set, injections are collected here instead of emitted. */
        private List<Runnable> deferred;

        private void emitInjection(NodeRef target, TypeTree declaredType, String via, String member, Integer line) {
            if (declaredType == null) {
                return;
            }
            String asWritten = writtenName(declaredType);
            TypeResolver.Resolved answer = resolver.resolve(declaredType.getType(), asWritten);
            String file = path;
            Runnable emit;
            if (!answer.isResolved()) {
                // Counted, so coverage can say how many injection points were
                // resolved out of how many were seen (ADR-0039).
                String message = "injection point " + target.fqn() + (member == null ? "" : "." + member)
                        + " (" + via + "): its type " + asWritten + " cannot be resolved: "
                        + answer.whyAmbiguous() + "; no injects edge recorded";
                emit = () -> emitter.diagnostic("info", message, file, line);
            } else {
                Map<String, Object> attrs = new LinkedHashMap<>();
                attrs.put("via", via);
                if (member != null) {
                    attrs.put("member", member);
                }
                attrs.put("resolution", answer.resolution.wireName);
                NodeRef dst = new NodeRef(nodeKindFor(declaredType.getType()), answer.fqn);
                emit = () -> emitter.edge("injects", target, dst, file, line, attrs);
            }
            if (deferred != null) {
                deferred.add(emit);
            } else {
                emit.run();
            }
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
            emitBeanMethodInjection(owner, annotations, declaration);
            recordQuery(annotations, type);
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
            emitSpecEndpoints(owner, method, basePaths, declaration);

            for (ResolvedAnnotation annotation : annotations) {
                AnnotationArgs args = new AnnotationArgs(annotation.node);

                String shorthand = FrameworkAnnotations.SPRING_METHOD_MAPPINGS.get(annotation.fqn);
                if (shorthand != null) {
                    List<String> paths = new ArrayList<>(args.strings("value"));
                    paths.addAll(args.strings("path"));
                    emitEndpoint(method, basePaths, paths, List.of(shorthand),
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

                // A first-party annotation declared with a mapping (ADR-0043):
                // the verb comes from the declaration, the path from the use.
                List<String> metaVerbs = new ArrayList<>();
                List<String> metaPaths = new ArrayList<>();
                for (ResolvedAnnotation meta : metaOf(annotation.fqn)) {
                    AnnotationArgs metaArgs = new AnnotationArgs(meta.node);
                    String verb = FrameworkAnnotations.SPRING_METHOD_MAPPINGS.get(meta.fqn);
                    if (verb != null) {
                        metaVerbs.add(verb);
                    } else if (FrameworkAnnotations.SPRING_REQUEST_MAPPING.equals(meta.fqn)) {
                        List<String> named = metaArgs.enumNames("method");
                        metaVerbs.addAll(named.isEmpty() ? List.of("ANY") : named);
                    } else {
                        continue;
                    }
                    metaPaths.addAll(metaArgs.strings("value"));
                    metaPaths.addAll(metaArgs.strings("path"));
                }
                if (!metaVerbs.isEmpty()) {
                    List<String> paths = new ArrayList<>(args.strings("value"));
                    paths.addAll(args.strings("path"));
                    emitEndpoint(method, basePaths, paths.isEmpty() ? metaPaths : paths, metaVerbs,
                            "spring-mvc", line(annotation.node));
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

        /**
         * ADR-0044: a controller method that overrides a generated API
         * interface and is named for an OpenAPI operation serves that
         * operation. The endpoint is cited at the spec; the handler at the
         * method. Only for a controller-stereotyped class, and only for an
         * {@code @Override}, so an unrelated method of the same name is not
         * joined to a route.
         */
        private void emitSpecEndpoints(ClassContext owner, NodeRef method, List<String> basePaths,
                                       J.MethodDeclaration declaration) {
            if (specs == null || specs.isEmpty()) {
                return;
            }
            String stereotype = owner.stereotype();
            if (!"controller".equals(stereotype) && !"rest-controller".equals(stereotype)) {
                return;
            }
            boolean overrides = declaration.getLeadingAnnotations().stream()
                    .anyMatch(a -> "Override".equals(writtenName(a.getAnnotationType()))
                            || "java.lang.Override".equals(writtenName(a.getAnnotationType())));
            if (!overrides) {
                return;
            }
            List<String> bases = basePaths.isEmpty() ? List.of("") : basePaths;
            for (OpenApiSpecs.Operation operation : specs.operations(declaration.getSimpleName())) {
                if (specFilesEmitted.add(operation.file())) {
                    emitter.file(operation.file(), "openapi", countLines(repoRoot.resolve(operation.file())));
                }
                for (String base : bases) {
                    String full = Fqn.pathTemplate(joinPath(base, operation.path()));
                    String fqn = Fqn.endpoint(operation.method(), full);
                    Map<String, Object> attrs = new LinkedHashMap<>();
                    attrs.put("method", operation.method());
                    attrs.put("path", full);
                    attrs.put("framework", "openapi");
                    attrs.put("operationId", operation.operationId());
                    emitter.node("endpoint", fqn, full, null, operation.file(), operation.line(), null, attrs);
                    emitter.edge("handles", method, new NodeRef("endpoint", fqn), path, line(declaration), null);
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
                    String full = Fqn.pathTemplate(joinPath(base, suffix));
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
            boolean embedded = first(annotations, FrameworkAnnotations.JPA_EMBEDDED) != null;
            ResolvedAnnotation inverse = first(annotations, FrameworkAnnotations.JPA_MAPPED_BY);
            String mappedBy = inverse == null ? null : new AnnotationArgs(inverse.node).string("mappedBy");

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
                if (embedded) {
                    attrs.put("embedded", true);
                }
                // The inverse side of a bidirectional association: the owning
                // side's field is the one that holds the key (ADR-0036).
                if (mappedBy != null && !mappedBy.isBlank()) {
                    attrs.put("mappedBy", mappedBy);
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
            recordJdbc(invocation);
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
                                + "fully qualified name: " + answer.whyAmbiguous(),
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
            // A first-party annotation declared with a stereotype (ADR-0043).
            for (ResolvedAnnotation annotation : annotations) {
                for (ResolvedAnnotation meta : metaOf(annotation.fqn)) {
                    String stereotype = FrameworkAnnotations.STEREOTYPES.get(meta.fqn);
                    if (stereotype != null) {
                        return stereotype;
                    }
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

    static boolean isKotlin(Path file) {
        String name = file.getFileName().toString();
        // `.kts` is a build script, not a source set. It is discovered as a
        // build file for a module's identity and never parsed as a declaration
        // site — a `build.gradle.kts` declares no domain type.
        return name.endsWith(".kt");
    }

    /**
     * The language recorded on a `file` fact.
     *
     * Per file rather than per run: one jar parses both, and a repository that
     * is 90% Java with a Kotlin test module should say so in the store rather
     * than flatten to whichever ran first.
     */
    private static String languageOf(Path file) {
        return isKotlin(file) ? "kotlin" : "java";
    }
}
