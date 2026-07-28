package dev.stratigraph.extractor.java;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The known-annotation table. Data, not logic, and in one file — ADR-0005 says
 * it will lag new framework releases and that this is the acceptable cost of
 * never guessing what an unrecognised annotation means.
 *
 * Two things it deliberately spans:
 *
 * - **Both namespaces.** `javax.*` and `jakarta.*`. The repositories this tool
 *   targets are mostly still on `javax`, and treating that as the legacy
 *   afterthought gets the common case wrong.
 * - **Both eras of Spring web.** `@RequestMapping(method = RequestMethod.GET)`
 *   predates `@GetMapping` by a decade and is what a Spring MVC application
 *   actually looks like.
 *
 * Not covered, and not pretended otherwise: meta-annotations. A team's custom
 * `@ApplicationService` meta-annotated `@Service` is unrecognisable from source
 * alone, so it produces no stereotype fact (ADR-0005 rule 5).
 */
final class FrameworkAnnotations {

    private FrameworkAnnotations() {
    }

    /** `javax.foo` and `jakarta.foo` are the same annotation to us. */
    private static List<String> bothNamespaces(String suffix) {
        return List.of("javax." + suffix, "jakarta." + suffix);
    }

    private static final String SPRING_STEREOTYPE = "org.springframework.stereotype.";
    private static final String SPRING_WEB = "org.springframework.web.bind.annotation.";

    // ------------------------------------------------------------- stereotypes

    /** Annotation fqn → the stereotype it declares. */
    static final Map<String, String> STEREOTYPES = new HashMap<>();

    static {
        STEREOTYPES.put(SPRING_STEREOTYPE + "Component", "component");
        STEREOTYPES.put(SPRING_STEREOTYPE + "Service", "service");
        STEREOTYPES.put(SPRING_STEREOTYPE + "Repository", "repository");
        STEREOTYPES.put(SPRING_STEREOTYPE + "Controller", "controller");
        STEREOTYPES.put(SPRING_WEB + "RestController", "rest-controller");
        STEREOTYPES.put("org.springframework.context.annotation.Configuration", "configuration");
        for (String ejb : List.of("ejb.Stateless", "ejb.Stateful", "ejb.Singleton")) {
            for (String fqn : bothNamespaces(ejb)) {
                STEREOTYPES.put(fqn, "ejb");
            }
        }
    }

    // ----------------------------------------------------------- injection

    /** Annotations that mark an injection site outright, wherever they appear. */
    static final Set<String> INJECTION_MARKERS = new HashSet<>();

    static {
        INJECTION_MARKERS.add("org.springframework.beans.factory.annotation.Autowired");
        INJECTION_MARKERS.addAll(bothNamespaces("inject.Inject"));
        INJECTION_MARKERS.addAll(bothNamespaces("annotation.Resource"));
    }

    // ------------------------------------------------------------- endpoints

    /** Spring's shorthand mappings: annotation fqn → HTTP method. */
    static final Map<String, String> SPRING_METHOD_MAPPINGS = new HashMap<>();

    static {
        SPRING_METHOD_MAPPINGS.put(SPRING_WEB + "GetMapping", "GET");
        SPRING_METHOD_MAPPINGS.put(SPRING_WEB + "PostMapping", "POST");
        SPRING_METHOD_MAPPINGS.put(SPRING_WEB + "PutMapping", "PUT");
        SPRING_METHOD_MAPPINGS.put(SPRING_WEB + "DeleteMapping", "DELETE");
        SPRING_METHOD_MAPPINGS.put(SPRING_WEB + "PatchMapping", "PATCH");
    }

    /** The general form, and the only one a pre-Boot application has. */
    static final String SPRING_REQUEST_MAPPING = SPRING_WEB + "RequestMapping";

    /** JAX-RS: annotation fqn → HTTP method. Common in non-Spring enterprise Java. */
    static final Map<String, String> JAXRS_METHODS = new HashMap<>();

    static {
        for (String verb : List.of("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH")) {
            for (String fqn : bothNamespaces("ws.rs." + verb)) {
                JAXRS_METHODS.put(fqn, verb);
            }
        }
    }

    static final Set<String> JAXRS_PATH = new HashSet<>(bothNamespaces("ws.rs.Path"));

    // --------------------------------------------------------------- JPA

    static final Set<String> JPA_ENTITY = new HashSet<>(bothNamespaces("persistence.Entity"));
    static final Set<String> JPA_TABLE = new HashSet<>(bothNamespaces("persistence.Table"));
    static final Set<String> JPA_COLUMN = new HashSet<>(bothNamespaces("persistence.Column"));
    static final Set<String> JPA_ID = new HashSet<>(bothNamespaces("persistence.Id"));

    /** True when the extractor understands what this annotation means. */
    static boolean isKnown(String fqn) {
        return STEREOTYPES.containsKey(fqn)
                || INJECTION_MARKERS.contains(fqn)
                || SPRING_METHOD_MAPPINGS.containsKey(fqn)
                || SPRING_REQUEST_MAPPING.equals(fqn)
                || JAXRS_METHODS.containsKey(fqn)
                || JAXRS_PATH.contains(fqn)
                || Arrays.asList(JPA_ENTITY, JPA_TABLE, JPA_COLUMN, JPA_ID).stream()
                        .anyMatch(set -> set.contains(fqn));
    }
}
