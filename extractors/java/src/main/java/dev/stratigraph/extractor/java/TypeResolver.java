package dev.stratigraph.extractor.java;

import org.openrewrite.java.tree.Expression;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaSourceFile;
import org.openrewrite.java.tree.JavaType;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Resolving a type name written in source to a fully qualified name, using only
 * what the parser saw: the name itself, the compilation unit's imports, and its
 * package. This is ADR-0005's mechanism, and it is the reason the extractor is
 * useful on a repository whose dependencies cannot be resolved.
 *
 * Every answer records *how* it was reached, so a fact can say whether it came
 * from type attribution or from reading an import. Both are facts. Neither is a
 * guess — and where nothing applies the answer is {@link Resolution#AMBIGUOUS}
 * with the reason spelled out, rather than something plausible.
 */
final class TypeResolver {

    enum Resolution {
        /** The parser attributed the type outright — a real classpath entry, usually the JDK. */
        CLASSPATH("classpath"),
        /** Written fully qualified in place. */
        FQN("fqn"),
        /** Matched a single-type import. */
        IMPORT("import"),
        /** Unqualified, no wildcard in scope, so it can only be this file's own package. */
        SAME_PACKAGE("same-package"),
        /**
         * Earned through a wildcard import under ADR-0023's three conditions:
         * the known-FQN table places the name in the one wildcard-imported
         * package, and the parsed source set declares no type of that name.
         */
        WILDCARD_IMPORT("wildcard-import"),
        /** Unresolvable from source. Emit nothing, and say why. */
        AMBIGUOUS("ambiguous");

        final String wireName;

        Resolution(String wireName) {
            this.wireName = wireName;
        }
    }

    static final class Resolved {
        final String fqn;
        final Resolution resolution;
        private final String reason;

        private Resolved(String fqn, Resolution resolution, String reason) {
            this.fqn = fqn;
            this.resolution = resolution;
            this.reason = reason;
        }

        boolean isResolved() {
            return resolution != Resolution.AMBIGUOUS;
        }

        /** Why the name stayed ambiguous, phrased for a diagnostic. */
        String whyAmbiguous() {
            return reason;
        }

        static final Resolved AMBIGUOUS =
                new Resolved(null, Resolution.AMBIGUOUS, "a wildcard import makes it ambiguous");

        private static Resolved ambiguous(String reason) {
            return new Resolved(null, Resolution.AMBIGUOUS, reason);
        }
    }

    private final Map<String, String> singleTypeImports = new HashMap<>();
    private final List<String> wildcardImports = new ArrayList<>();
    private final String packageName;

    /**
     * Every type simple name declared anywhere in the parsed source set, mapped
     * to one file that declares it — ADR-0023 condition 3. Shared across the
     * run; built once before any resolution happens.
     */
    private final Map<String, String> declaredTypeNames;

    /** Takes a {@link JavaSourceFile} so a Kotlin compilation unit resolves too — ADR-0029. */
    TypeResolver(JavaSourceFile cu, String packageName, Map<String, String> declaredTypeNames,
                 boolean kotlin) {
        this.packageName = packageName;
        this.declaredTypeNames = declaredTypeNames;
        for (J.Import anImport : cu.getImports()) {
            if (kotlin) {
                readKotlinImport(anImport);
                continue;
            }
            if (anImport.isStatic()) {
                continue;
            }
            if ("*".equals(anImport.getClassName())) {
                wildcardImports.add(dotted(anImport.getQualid().getTarget()));
            } else {
                singleTypeImports.put(simpleName(anImport.getClassName()), anImport.getTypeName());
            }
        }
    }

    /**
     * A Kotlin import, read off the qualified id rather than the accessors.
     *
     * Three of `J.Import`'s accessors mean something else on a Kotlin
     * compilation unit, and the first one cost every Spring annotation in a
     * Kotlin file its resolution:
     *
     * <ul>
     *   <li>{@code isStatic()} is <b>true for every Kotlin import</b>. Kotlin
     *       has no static imports; the Java branch above skips static ones
     *       because they name members rather than types, and applying that here
     *       discarded the lot.</li>
     *   <li>{@code getTypeName()} returns the <i>package</i>
     *       ({@code org.springframework.stereotype}), not the type.</li>
     *   <li>{@code getClassName()} returns the simple name, so the {@code "*"}
     *       test for a wildcard never fires.</li>
     * </ul>
     *
     * The qualified id prints the whole dotted name in both languages, so that
     * is what this reads. An aliased import ({@code import a.B as C}) keeps the
     * alias out of the key deliberately — resolution is by the name as written,
     * and an alias is a different name this does not yet follow.
     */
    private void readKotlinImport(J.Import anImport) {
        String dotted = anImport.getQualid().printTrimmed().trim();
        int alias = dotted.indexOf(" as ");
        if (alias != -1) {
            dotted = dotted.substring(0, alias).trim();
        }
        if (dotted.endsWith(".*")) {
            wildcardImports.add(dotted.substring(0, dotted.length() - 2));
        } else if (!dotted.isEmpty()) {
            singleTypeImports.put(simpleName(dotted), dotted);
        }
    }

    /**
     * Resolve a type name exactly as it was written.
     *
     * @param attributed the type the parser assigned, if any — checked first,
     *                   because a resolved classpath beats re-deriving the
     *                   answer from source
     * @param asWritten  the name as it appears in the file
     */
    Resolved resolve(JavaType attributed, String asWritten) {
        if (attributed instanceof JavaType.FullyQualified && !Fqn.unresolved(attributed)) {
            return new Resolved(((JavaType.FullyQualified) attributed).getFullyQualifiedName(),
                    Resolution.CLASSPATH, null);
        }

        // Strip any generic arguments and array brackets; identity is erased.
        String name = erase(asWritten);
        if (name.isEmpty()) {
            return Resolved.AMBIGUOUS;
        }

        // Already fully qualified in place. `org.springframework.stereotype.Service`
        // needs no import and no classpath to be unambiguous.
        if (name.indexOf('.') >= 0) {
            String imported = singleTypeImports.get(rootSegment(name));
            // `Outer.Inner` where Outer was imported: the qualifier is a type,
            // not a package, so the binary name uses `$`.
            if (imported != null) {
                return new Resolved(imported + "$" + name.substring(name.indexOf('.') + 1),
                        Resolution.IMPORT, null);
            }
            return new Resolved(name, Resolution.FQN, null);
        }

        String imported = singleTypeImports.get(name);
        if (imported != null) {
            return new Resolved(imported, Resolution.IMPORT, null);
        }

        // ADR-0005 rule 4: with a wildcard in scope, an unqualified name could
        // come from there or from this package, and the file does not say
        // which. ADR-0023 narrows the refusal — the resolution can be *earned*
        // when exactly one candidate survives on facts alone.
        if (!wildcardImports.isEmpty()) {
            return earnThroughWildcard(name);
        }

        if (Fqn.DEFAULT_PACKAGE.equals(packageName)) {
            return new Resolved(name, Resolution.SAME_PACKAGE, null);
        }
        return new Resolved(packageName + "." + name, Resolution.SAME_PACKAGE, null);
    }

    /**
     * ADR-0023: an unqualified name reached through a wildcard import resolves
     * when three conditions hold together, and stays a diagnostic otherwise.
     * Each refusal states which condition failed, so the report can say what
     * would resolve it instead of one undifferentiated count.
     */
    private Resolved earnThroughWildcard(String name) {
        // A java.* wildcard cannot compete: the JLS reserves java.* packages,
        // the parser always has the JDK on its classpath, and a name one of
        // them could supply would have been type-attributed and never reached
        // this code. Measured at the M7 acceptance run — three of
        // jhipster-sample-app's controllers were refused only because
        // `import java.util.*;` sat beside the Spring wildcard (ADR-0023).
        List<String> candidates = new ArrayList<>();
        for (String pkg : wildcardImports) {
            if (!"java".equals(pkg) && !pkg.startsWith("java.")) {
                candidates.add(pkg);
            }
        }

        if (candidates.isEmpty()) {
            return Resolved.ambiguous("a wildcard import makes it ambiguous — no wildcard-imported "
                    + "package could be shown to declare " + name);
        }

        // Condition 2: a second wildcard-imported package — known or unknown —
        // could supply the same name, and nothing can prove it does not. The
        // table lists what a package does declare, never what it does not.
        if (candidates.size() > 1) {
            List<String> spelled = new ArrayList<>();
            for (String pkg : candidates) {
                spelled.add(pkg + ".*");
            }
            return Resolved.ambiguous("competing wildcard imports ("
                    + String.join(", ", spelled) + ") make it ambiguous — any of them could supply "
                    + name);
        }

        String pkg = candidates.get(0);
        String candidate = pkg + "." + name;

        // Condition 1: the known-FQN table must place the name in the one
        // wildcard-imported package. Both the table entry and the import are
        // facts; their conjunction is not a guess.
        if (!FrameworkAnnotations.isKnown(candidate)) {
            return Resolved.ambiguous("a wildcard import makes it ambiguous — " + name
                    + " is not in the known-annotation table under " + pkg
                    + ", so no package in scope is known to declare it");
        }

        // Condition 3: a first-party type of the same name — in this package,
        // where it would shadow the import, or anywhere a wildcard could
        // reach — makes this repository one of the ones that declares its own.
        String declaredIn = declaredTypeNames.get(name);
        if (declaredIn != null) {
            return Resolved.ambiguous("the source set declares its own type named " + name
                    + " (in " + declaredIn + "), which makes the wildcard import ambiguous");
        }

        return new Resolved(candidate, Resolution.WILDCARD_IMPORT, null);
    }

    private static String erase(String written) {
        String name = written.trim();
        int generic = name.indexOf('<');
        if (generic >= 0) {
            name = name.substring(0, generic);
        }
        return name.replace("[]", "").replace("...", "").trim();
    }

    private static String rootSegment(String dotted) {
        int dot = dotted.indexOf('.');
        return dot == -1 ? dotted : dotted.substring(0, dot);
    }

    private static String simpleName(String className) {
        // OpenRewrite reports a nested import's class name as `Outer.Inner`.
        int dot = className.lastIndexOf(".");
        return dot == -1 ? className : className.substring(dot + 1);
    }

    /** The dotted name an import's qualifier spells, read off the tree. */
    private static String dotted(Expression expression) {
        if (expression instanceof J.Identifier) {
            return ((J.Identifier) expression).getSimpleName();
        }
        if (expression instanceof J.FieldAccess) {
            J.FieldAccess access = (J.FieldAccess) expression;
            return dotted(access.getTarget()) + "." + access.getSimpleName();
        }
        return "";
    }
}
