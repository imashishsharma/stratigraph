package dev.stratigraph.extractor.java;

import org.junit.jupiter.api.Test;
import org.openrewrite.ExecutionContext;
import org.openrewrite.InMemoryExecutionContext;
import org.openrewrite.SourceFile;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaType;
import org.openrewrite.java.tree.TypeUtils;
import org.openrewrite.kotlin.KotlinParser;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The assumptions Kotlin support rests on, pinned.
 *
 * Started as a spike answering one question — does OpenRewrite's Kotlin LST
 * present the same {@code J} nodes {@code JavaFactExtractor} already walks? It
 * does, which is why Kotlin cost a parser branch rather than a second extractor
 * (ADR-0029).
 *
 * It is kept because every assertion here is a property of `rewrite-kotlin`
 * rather than of this project, and a version bump can take any of them away.
 * The last three in particular are quirks that already cost real behaviour
 * once: they are the difference between annotations resolving to
 * `org.springframework.stereotype.Service` and to whatever package the file
 * happened to be in.
 */
class KotlinSpikeTest {

    private static List<SourceFile> parse(String... sources) {
        ExecutionContext ctx = new InMemoryExecutionContext(Throwable::printStackTrace);
        return KotlinParser.builder().build().parse(ctx, sources).toList();
    }

    @Test
    void kotlinParsesIntoSomethingWithASourcePath() {
        List<SourceFile> parsed = parse("class Greeter { fun greet(): String = \"hi\" }");

        assertEquals(1, parsed.size());
        assertFalse(parsed.get(0) instanceof org.openrewrite.tree.ParseError,
                "the parser reported a ParseError rather than an LST");
    }

    /** The load-bearing question: does a JavaIsoVisitor see Kotlin declarations? */
    @Test
    void aJavaVisitorSeesKotlinClassesAndMethods() {
        List<SourceFile> parsed = parse(
                "package com.example\n"
                        + "class OrderService {\n"
                        + "    fun place(id: String): String = id\n"
                        + "}\n");

        List<String> classes = new ArrayList<>();
        List<String> methods = new ArrayList<>();

        new JavaIsoVisitor<Integer>() {
            @Override
            public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration cd, Integer p) {
                classes.add(cd.getSimpleName());
                return super.visitClassDeclaration(cd, p);
            }

            @Override
            public J.MethodDeclaration visitMethodDeclaration(J.MethodDeclaration md, Integer p) {
                methods.add(md.getSimpleName());
                return super.visitMethodDeclaration(md, p);
            }
        }.visit(parsed.get(0), 0);

        assertEquals(List.of("OrderService"), classes, "no Kotlin class reached the visitor");
        assertEquals(List.of("place"), methods, "no Kotlin function reached the visitor");
    }

    /**
     * The second load-bearing question. Facts are only emitted for what the
     * parser attributed (ADR-0005): without type attribution the extractor
     * emits silence, so a Kotlin LST with no types would be worthless here even
     * if the shapes match.
     */
    @Test
    void kotlinTypesAreAttributed() {
        List<SourceFile> parsed = parse(
                "package com.example\n"
                        + "class Repo\n"
                        + "class OrderService(val repo: Repo)\n");

        List<String> resolved = new ArrayList<>();
        new JavaIsoVisitor<Integer>() {
            @Override
            public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration cd, Integer p) {
                JavaType.FullyQualified type = cd.getType();
                if (type != null) resolved.add(type.getFullyQualifiedName());
                return super.visitClassDeclaration(cd, p);
            }
        }.visit(parsed.get(0), 0);

        assertTrue(resolved.contains("com.example.OrderService"),
                "class types were not attributed, got: " + resolved);
    }

    /** Whether an annotation — the whole Spring story — survives into the LST. */
    @Test
    void annotationsAreVisibleAndAttributed() {
        List<SourceFile> parsed = parse(
                "package com.example\n"
                        + "annotation class Service\n"
                        + "@Service\n"
                        + "class OrderService\n");

        List<String> annotations = new ArrayList<>();
        new JavaIsoVisitor<Integer>() {
            @Override
            public J.Annotation visitAnnotation(J.Annotation annotation, Integer p) {
                JavaType.FullyQualified type = TypeUtils.asFullyQualified(annotation.getType());
                annotations.add(type == null ? "(unattributed)" : type.getFullyQualifiedName());
                return super.visitAnnotation(annotation, p);
            }
        }.visit(parsed.get(0), 0);

        assertNotNull(annotations);
        assertTrue(annotations.contains("com.example.Service"),
                "annotation type not attributed, got: " + annotations);
    }

    /**
     * A Kotlin compilation unit is a {@code JavaSourceFile} and <b>not</b> a
     * {@code J.CompilationUnit}.
     *
     * The extractor gated on the latter, so every Kotlin file was walked past
     * in silence — a file fact with no declarations under it. Narrowing that
     * type again would reintroduce exactly that.
     */
    @Test
    void aKotlinUnitIsAJavaSourceFileButNotACompilationUnit() {
        SourceFile parsed = parse("package com.example\nclass A\n").get(0);

        assertTrue(parsed instanceof org.openrewrite.java.tree.JavaSourceFile,
                "the extractor reads packages, imports and classes through this interface");
        assertFalse(parsed instanceof J.CompilationUnit,
                "if this ever becomes true, the narrower gate would have been safe after all");
    }

    /**
     * Three {@code J.Import} accessors mean something else on a Kotlin unit.
     *
     * `isStatic()` is the expensive one: Kotlin has no static imports, the Java
     * path skips static imports because they name members rather than types,
     * and applying that here discarded every import in the file — which is what
     * resolves `@Service` to Spring rather than to the local package.
     */
    @Test
    void kotlinImportAccessorsDoNotMeanWhatTheyDoInJava() {
        SourceFile parsed = parse(
                "package com.example\nimport org.springframework.stereotype.Service\nclass A\n")
                .get(0);
        J.Import first = ((org.openrewrite.java.tree.JavaSourceFile) parsed).getImports().get(0);

        assertTrue(first.isStatic(), "a Kotlin import still reports itself as static");
        assertEquals("org.springframework.stereotype", first.getTypeName(),
                "getTypeName() gives the package, not the type");
        assertEquals("Service", first.getClassName(),
                "getClassName() gives the simple name, so the \"*\" wildcard test never fires");

        // Which leaves the qualified id as the only thing that means the same
        // in both languages, and therefore what TypeResolver reads.
        assertEquals("org.springframework.stereotype.Service",
                first.getQualid().printTrimmed().trim());
    }
}
