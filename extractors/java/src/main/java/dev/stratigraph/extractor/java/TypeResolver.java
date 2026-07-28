package dev.stratigraph.extractor.java;

import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaType;

import java.util.HashMap;
import java.util.Map;

/**
 * Resolving a type name written in source to a fully qualified name, using only
 * what the parser saw: the name itself, the compilation unit's imports, and its
 * package. This is ADR-0005's mechanism, and it is the reason the extractor is
 * useful on a repository whose dependencies cannot be resolved.
 *
 * Every answer records *how* it was reached, so a fact can say whether it came
 * from type attribution or from reading an import. Both are facts. Neither is a
 * guess — and the one case where neither applies returns
 * {@link Resolution#AMBIGUOUS} rather than something plausible.
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
        /** A wildcard import makes the name unresolvable from source. Emit nothing. */
        AMBIGUOUS("ambiguous");

        final String wireName;

        Resolution(String wireName) {
            this.wireName = wireName;
        }
    }

    static final class Resolved {
        final String fqn;
        final Resolution resolution;

        private Resolved(String fqn, Resolution resolution) {
            this.fqn = fqn;
            this.resolution = resolution;
        }

        boolean isResolved() {
            return resolution != Resolution.AMBIGUOUS;
        }

        static final Resolved AMBIGUOUS = new Resolved(null, Resolution.AMBIGUOUS);
    }

    private final Map<String, String> singleTypeImports = new HashMap<>();
    private final boolean hasWildcardImport;
    private final String packageName;

    TypeResolver(J.CompilationUnit cu, String packageName) {
        this.packageName = packageName;
        boolean wildcard = false;
        for (J.Import anImport : cu.getImports()) {
            if (anImport.isStatic()) {
                continue;
            }
            if ("*".equals(anImport.getClassName())) {
                wildcard = true;
            } else {
                singleTypeImports.put(simpleName(anImport.getClassName()), anImport.getTypeName());
            }
        }
        this.hasWildcardImport = wildcard;
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
                    Resolution.CLASSPATH);
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
                        Resolution.IMPORT);
            }
            return new Resolved(name, Resolution.FQN);
        }

        String imported = singleTypeImports.get(name);
        if (imported != null) {
            return new Resolved(imported, Resolution.IMPORT);
        }

        // ADR-0005 rule 4. `import org.springframework.web.bind.annotation.*`
        // means an unqualified name could come from there or from this package,
        // and nothing in the file says which. We do not guess.
        if (hasWildcardImport) {
            return Resolved.AMBIGUOUS;
        }

        if (Fqn.DEFAULT_PACKAGE.equals(packageName)) {
            return new Resolved(name, Resolution.SAME_PACKAGE);
        }
        return new Resolved(packageName + "." + name, Resolution.SAME_PACKAGE);
    }

    /** True when this file's imports leave unqualified names undecidable. */
    boolean hasWildcardImport() {
        return hasWildcardImport;
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
        int dot = className.lastIndexOf('.');
        return dot == -1 ? className : className.substring(dot + 1);
    }
}
