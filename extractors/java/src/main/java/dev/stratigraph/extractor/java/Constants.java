package dev.stratigraph.extractor.java;

import org.openrewrite.SourceFile;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.tree.Expression;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaSourceFile;
import org.openrewrite.java.tree.JavaType;
import org.openrewrite.java.tree.Statement;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Compile-time constants declared in the parsed source set (ADR-0043).
 *
 * {@code @Path(JaxrsResource.ACCOUNTS_PATH)} names a path as surely as
 * {@code @Path("/1.0/kb/accounts")} does when {@code ACCOUNTS_PATH} is a
 * {@code static final String} whose initializer is itself made of literals
 * and such constants — the compiler folds it to the same string. Only that
 * case is evaluated: a constant from a jar, or one computed by a method call,
 * yields nothing, exactly as an unreadable literal always has.
 */
final class Constants {

    /** {@code ownerFqn#NAME} → initializer, for static final fields and interface fields. */
    private static final Map<String, Expression> INITIALIZERS = new HashMap<>();

    private Constants() {
    }

    static void collect(List<SourceFile> parsed) {
        INITIALIZERS.clear();
        for (SourceFile sourceFile : parsed) {
            if (!(sourceFile instanceof JavaSourceFile)) {
                continue;
            }
            new JavaIsoVisitor<Void>() {
                @Override
                public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration declaration, Void unused) {
                    if (declaration.getType() != null) {
                        boolean iface = declaration.getKind() == J.ClassDeclaration.Kind.Type.Interface;
                        String owner = Fqn.type(declaration.getType());
                        for (Statement statement : declaration.getBody().getStatements()) {
                            if (!(statement instanceof J.VariableDeclarations)) {
                                continue;
                            }
                            J.VariableDeclarations field = (J.VariableDeclarations) statement;
                            boolean constant = iface
                                    || (field.hasModifier(J.Modifier.Type.Static)
                                        && field.hasModifier(J.Modifier.Type.Final));
                            if (!constant) {
                                continue;
                            }
                            for (J.VariableDeclarations.NamedVariable variable : field.getVariables()) {
                                if (variable.getInitializer() != null) {
                                    INITIALIZERS.put(owner + "#" + variable.getSimpleName(), variable.getInitializer());
                                }
                            }
                        }
                    }
                    return super.visitClassDeclaration(declaration, unused);
                }
            }.visit((JavaSourceFile) sourceFile, null);
        }
    }

    /**
     * The string value of an expression made of literals, concatenation and
     * source-set constants; null for anything else.
     */
    static String evaluate(Expression expression) {
        return evaluate(expression, new HashSet<>());
    }

    private static String evaluate(Expression expression, Set<String> visiting) {
        if (expression instanceof J.Literal) {
            Object value = ((J.Literal) expression).getValue();
            return value instanceof String || value instanceof Character || value instanceof Number
                    ? String.valueOf(value)
                    : null;
        }
        if (expression instanceof J.Binary
                && ((J.Binary) expression).getOperator() == J.Binary.Type.Addition) {
            String left = evaluate(((J.Binary) expression).getLeft(), visiting);
            String right = evaluate(((J.Binary) expression).getRight(), visiting);
            return left == null || right == null ? null : left + right;
        }
        if (expression instanceof J.Parentheses) {
            Object tree = ((J.Parentheses<?>) expression).getTree();
            return tree instanceof Expression ? evaluate((Expression) tree, visiting) : null;
        }
        JavaType.Variable field = null;
        if (expression instanceof J.Identifier) {
            field = ((J.Identifier) expression).getFieldType();
        } else if (expression instanceof J.FieldAccess) {
            field = ((J.FieldAccess) expression).getName().getFieldType();
        }
        if (field == null || !(field.getOwner() instanceof JavaType.FullyQualified)) {
            return null;
        }
        String key = Fqn.type((JavaType.FullyQualified) field.getOwner()) + "#" + field.getName();
        Expression initializer = INITIALIZERS.get(key);
        if (initializer == null || !visiting.add(key)) {
            return null;
        }
        try {
            return evaluate(initializer, visiting);
        } finally {
            visiting.remove(key);
        }
    }
}
