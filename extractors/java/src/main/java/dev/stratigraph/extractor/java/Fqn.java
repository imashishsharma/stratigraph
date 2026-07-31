package dev.stratigraph.extractor.java;

import org.openrewrite.java.tree.JavaType;

import java.util.ArrayList;
import java.util.List;
import java.util.StringJoiner;

/**
 * Node identity, exactly as ADR-0007 specifies it.
 *
 * Every later milestone joins on these strings, and the fact store enforces
 * {@code UNIQUE (run_id, kind, fqn)}, so this class is the single place the
 * scheme is implemented. Nothing else in the extractor should be concatenating
 * a {@code #} or a {@code $}.
 */
final class Fqn {

    /** The default package is a real package on old codebases, and gets a real node. */
    static final String DEFAULT_PACKAGE = "<default>";

    /** Rendered when a type could not be attributed. Honest, and rare. */
    static final String UNKNOWN = "<unknown>";

    private Fqn() {
    }

    static String pkg(String packageName) {
        return packageName == null || packageName.isEmpty() ? DEFAULT_PACKAGE : packageName;
    }

    /** The last dotted segment, for a node's display name. */
    static String simpleName(String fullyQualified) {
        int dot = fullyQualified.lastIndexOf('.');
        return dot == -1 ? fullyQualified : fullyQualified.substring(dot + 1);
    }

    /**
     * A type's fqn is its JVM binary name — OpenRewrite already reports nested
     * types as {@code Outer$Inner}, which is what ADR-0007 asks for.
     */
    static String type(JavaType.FullyQualified type) {
        return type == null ? UNKNOWN : type.getFullyQualifiedName();
    }

    /**
     * {@code owner#name(paramType,paramType)}, parameters erased and fully
     * qualified with no spaces.
     *
     * OpenRewrite names a constructor {@code <constructor>}; ADR-0007 says
     * {@code <init>}, which is its JVM name and what a stack trace prints.
     */
    static String method(JavaType.Method method) {
        if (method == null) {
            return UNKNOWN;
        }
        String name = "<constructor>".equals(method.getName()) ? "<init>" : method.getName();
        StringJoiner params = new StringJoiner(",", "(", ")");
        for (JavaType parameter : method.getParameterTypes()) {
            params.add(erase(parameter));
        }
        return type(method.getDeclaringType()) + "#" + name + params;
    }

    static String field(String ownerFqn, String fieldName) {
        return ownerFqn + "#" + fieldName;
    }

    /** {@code GET /api/orders/{id}} — framework-neutral by design. */
    static String endpoint(String httpMethod, String path) {
        return httpMethod + " " + path;
    }

    /** SQL identifiers are conventionally case-insensitive; the declared spelling is kept as the node's name. */
    static String table(String tableName) {
        return tableName.toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * Erasure to the form used inside a method signature.
     *
     * A generic parameter erases to its bound, matching how the JVM itself
     * distinguishes overloads — which is the property that makes the fqn stable
     * under the partial type information source-only parsing gives us.
     */
    static String erase(JavaType type) {
        if (type == null) {
            return UNKNOWN;
        }
        if (type instanceof JavaType.Primitive) {
            return ((JavaType.Primitive) type).getKeyword();
        }
        if (type instanceof JavaType.Array) {
            return erase(((JavaType.Array) type).getElemType()) + "[]";
        }
        if (type instanceof JavaType.Parameterized) {
            return type(((JavaType.Parameterized) type).getType());
        }
        if (type instanceof JavaType.GenericTypeVariable) {
            JavaType.GenericTypeVariable generic = (JavaType.GenericTypeVariable) type;
            return generic.getBounds().isEmpty()
                    ? "java.lang.Object"
                    : erase(generic.getBounds().get(0));
        }
        if (type instanceof JavaType.FullyQualified) {
            return ((JavaType.FullyQualified) type).getFullyQualifiedName();
        }
        return UNKNOWN;
    }

    /**
     * The type arguments of a parameterised type, erased individually.
     *
     * {@link #erase} throws these away, and has to: an fqn appears in a method
     * signature and must be stable, so {@code List<Pet>} and {@code List<Vet>}
     * have to erase to the same string or one overload becomes two nodes.
     *
     * They are still facts — OpenRewrite attributed them from the source — and
     * they are the difference between "this entity has a to-many relationship"
     * and "this entity has a to-many relationship *with Pet*". Emitted
     * alongside the erased type rather than inside it, so nothing about node
     * identity changes.
     *
     * Empty for a type that is not parameterised, and for any argument that
     * was never attributed — a partially readable argument list is reported as
     * the part that was read, never padded with guesses.
     */
    static List<String> typeArguments(JavaType type) {
        if (!(type instanceof JavaType.Parameterized)) {
            return List.of();
        }
        List<String> arguments = new ArrayList<>();
        for (JavaType argument : ((JavaType.Parameterized) type).getTypeParameters()) {
            String erased = erase(argument);
            if (!UNKNOWN.equals(erased)) {
                arguments.add(erased);
            }
        }
        return arguments;
    }

    /** True when a type is missing or was never attributed — never emit an edge to one. */
    static boolean unresolved(JavaType type) {
        return type == null || type instanceof JavaType.Unknown || UNKNOWN.equals(erase(type));
    }
}
