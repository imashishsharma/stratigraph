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
        DeclarationVisitor declarations = new DeclarationVisitor(path, packageName);
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
        if (cu.getPackageDeclaration() == null) {
            return null;
        }
        return cu.getPackageDeclaration().getExpression().print(new org.openrewrite.Cursor(null, cu)).trim();
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
        private int unresolvedCalls;

        DeclarationVisitor(String path, String packageName) {
            this.path = path;
            this.packageName = packageName;
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
                for (TypeTree implemented : declaration.getImplements()) {
                    emitSupertype("implements", kind, fqn, implemented);
                }
            }
            return super.visitClassDeclaration(declaration, unused);
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

            emitter.node("method", Fqn.method(type),
                    declaration.isConstructor() ? "<init>" : declaration.getSimpleName(),
                    new NodeRef(nodeKindOf(type.getDeclaringType()), Fqn.type(type.getDeclaringType())),
                    path, line(declaration), endLine(declaration), attrs);
            return super.visitMethodDeclaration(declaration, unused);
        }

        @Override
        public J.VariableDeclarations visitVariableDeclarations(J.VariableDeclarations declaration, Void unused) {
            J.ClassDeclaration owner = fieldOwner();
            if (owner == null || owner.getType() == null) {
                return super.visitVariableDeclarations(declaration, unused);
            }
            String ownerFqn = Fqn.type(owner.getType());
            String ownerKind = nodeKind(owner.getKind());

            for (J.VariableDeclarations.NamedVariable variable : declaration.getVariables()) {
                Map<String, Object> attrs = new LinkedHashMap<>();
                String fieldType = Fqn.erase(declaration.getType());
                if (!Fqn.UNKNOWN.equals(fieldType)) {
                    attrs.put("type", fieldType);
                }
                List<String> modifiers = modifiers(declaration.getModifiers());
                if (!modifiers.isEmpty()) {
                    attrs.put("modifiers", modifiers);
                }
                emitter.node("field", Fqn.field(ownerFqn, variable.getSimpleName()),
                        variable.getSimpleName(),
                        new NodeRef(ownerKind, ownerFqn),
                        path, line(declaration), null, attrs);
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

        private void emitSupertype(String edgeKind, String ownerKind, String ownerFqn, TypeTree supertype) {
            if (Fqn.unresolved(supertype.getType())) {
                // A supertype from a jar we never read. Recording an edge to a
                // name we cannot resolve would be exactly the confident guess
                // this project forbids.
                emitter.diagnostic("info",
                        "supertype of " + ownerFqn + " could not be resolved from source: "
                                + supertype.printTrimmed(getCursor()),
                        path, line(supertype));
                return;
            }
            JavaType.FullyQualified resolved = TypeUtils.asFullyQualified(supertype.getType());
            if (resolved == null) {
                return;
            }
            emitter.edge(edgeKind,
                    new NodeRef(ownerKind, ownerFqn),
                    new NodeRef(nodeKindOf(resolved), Fqn.type(resolved)),
                    path, line(supertype), null);
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
