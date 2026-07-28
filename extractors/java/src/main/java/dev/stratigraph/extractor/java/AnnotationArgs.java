package dev.stratigraph.extractor.java;

import org.openrewrite.java.tree.Expression;
import org.openrewrite.java.tree.J;

import java.util.ArrayList;
import java.util.List;

/**
 * Reading the arguments of an annotation as the source wrote them.
 *
 * Annotations accept the same value in several shapes — {@code @GetMapping("/x")},
 * {@code @RequestMapping(value = "/x")} and {@code @RequestMapping({"/x", "/y"})}
 * all name a path — and a legacy codebase uses all of them. Everything here
 * reads literals only: an argument that is a constant reference
 * ({@code @RequestMapping(Paths.ORDERS)}) has a value we cannot see without
 * resolving it, so it yields nothing rather than the text of the expression.
 */
final class AnnotationArgs {

    private final List<Expression> arguments;

    AnnotationArgs(J.Annotation annotation) {
        this.arguments = annotation.getArguments() == null ? List.of() : annotation.getArguments();
    }

    /** String literals for a named element, or for the implicit `value`. */
    List<String> strings(String element) {
        List<String> out = new ArrayList<>();
        for (Expression argument : arguments) {
            if (argument instanceof J.Assignment) {
                J.Assignment assignment = (J.Assignment) argument;
                if (element.equals(nameOf(assignment.getVariable()))) {
                    collectStrings(assignment.getAssignment(), out);
                }
            } else if ("value".equals(element)) {
                // A single unnamed argument is the `value` element.
                collectStrings(argument, out);
            }
        }
        return out;
    }

    /** The first string literal for an element, or null. */
    String string(String element) {
        List<String> values = strings(element);
        return values.isEmpty() ? null : values.get(0);
    }

    /**
     * Enum constant names for an element — {@code method = RequestMethod.GET}
     * yields {@code [GET]}. Only the constant's own name is taken; which enum it
     * belongs to is not something we can confirm without the classpath, and it
     * is not something the caller needs.
     */
    List<String> enumNames(String element) {
        List<String> out = new ArrayList<>();
        for (Expression argument : arguments) {
            if (argument instanceof J.Assignment) {
                J.Assignment assignment = (J.Assignment) argument;
                if (element.equals(nameOf(assignment.getVariable()))) {
                    collectEnums(assignment.getAssignment(), out);
                }
            }
        }
        return out;
    }

    boolean isEmpty() {
        return arguments.isEmpty();
    }

    private static void collectStrings(Expression expression, List<String> out) {
        if (expression instanceof J.Literal) {
            Object value = ((J.Literal) expression).getValue();
            if (value instanceof String) {
                out.add((String) value);
            }
            return;
        }
        if (expression instanceof J.NewArray) {
            List<Expression> initializer = ((J.NewArray) expression).getInitializer();
            if (initializer != null) {
                for (Expression element : initializer) {
                    collectStrings(element, out);
                }
            }
        }
    }

    private static void collectEnums(Expression expression, List<String> out) {
        if (expression instanceof J.FieldAccess) {
            out.add(((J.FieldAccess) expression).getSimpleName());
            return;
        }
        if (expression instanceof J.Identifier) {
            out.add(((J.Identifier) expression).getSimpleName());
            return;
        }
        if (expression instanceof J.NewArray) {
            List<Expression> initializer = ((J.NewArray) expression).getInitializer();
            if (initializer != null) {
                for (Expression element : initializer) {
                    collectEnums(element, out);
                }
            }
        }
    }

    private static String nameOf(Expression variable) {
        return variable instanceof J.Identifier ? ((J.Identifier) variable).getSimpleName() : null;
    }
}
