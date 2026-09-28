package dev.stratigraph.extractor.java;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What the extractor does when it cannot resolve something.
 *
 * This is the behaviour the whole project rests on. Without a classpath
 * (ADR-0006) a real repository is full of references into jars we never read,
 * and it is easy to write an extractor that scores well by emitting a
 * plausible edge anyway. These tests assert the opposite: silence plus a
 * diagnostic, never a guess.
 */
class RefusesToGuessTest {

    @Test
    void namesWhatTheImportStatesAndNothingMore(@TempDir Path repo) throws Exception {
        // `Missing` comes from a jar that does not exist, so the parser cannot
        // attribute it. The import statement still names it outright.
        write(repo, "src/Repo.java", """
                package app;
                import com.nowhere.Missing;
                public class Repo extends Missing {
                    void use(Missing m) {
                        m.doThing();
                    }
                }
                """);

        List<JsonNode> facts = extract(repo);

        // Reading a name and resolving a type are different things, and only
        // the second one needs a classpath. `import com.nowhere.Missing` plus
        // `extends Missing` states the supertype's fully qualified name, so
        // both the import and the extends edge are facts (ADR-0005), each
        // recording how it was reached.
        assertTrue(has(facts, "edge", node ->
                        "imports".equals(node.path("kind").asText())
                                && "com.nowhere.Missing".equals(node.path("dst").path("fqn").asText())),
                "dropped an import whose fully qualified name the source states outright");
        assertTrue(has(facts, "edge", node ->
                        "extends".equals(node.path("kind").asText())
                                && "com.nowhere.Missing".equals(node.path("dst").path("fqn").asText())
                                && "import".equals(node.path("attrs").path("resolution").asText())),
                "dropped a supertype the import names, or failed to record how it was resolved");

        // But `m.doThing()` is a different matter: nothing in the file says what
        // doThing's signature is, so there is no edge to draw.
        assertFalse(has(facts, "edge", node -> "calls".equals(node.path("kind").asText())),
                "emitted a calls edge to a method on a type it could not resolve");
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("call site")),
                "did not report the unresolved call site");

        assertTrue(has(facts, "node", node -> "app.Repo".equals(node.path("fqn").asText())));
    }

    @Test
    void refusesToResolveThroughAWildcardImport(@TempDir Path repo) throws Exception {
        // ADR-0005 rule 4. With a wildcard in scope, `Missing` could come from
        // com.nowhere or from app, and the file does not say which.
        write(repo, "src/Repo.java", """
                package app;
                import com.nowhere.*;
                @Marker
                public class Repo extends Missing {
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertFalse(has(facts, "edge", node -> "extends".equals(node.path("kind").asText())),
                "guessed a supertype through a wildcard import");
        assertFalse(has(facts, "edge", node -> "annotated_with".equals(node.path("kind").asText())),
                "guessed an annotation through a wildcard import");

        // And said so both times, rather than quietly reporting a class with
        // no supertype and no annotations.
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("supertype")
                                && node.path("message").asText().contains("ambiguous")),
                "stayed silent about the unresolvable supertype");
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("@Marker")
                                && node.path("message").asText().contains("wildcard import")),
                "stayed silent about the unresolvable annotation");
    }

    @Test
    void earnsResolutionThroughASingleKnownWildcardImport(@TempDir Path repo) throws Exception {
        // ADR-0023. The known-annotation table places GetMapping in the one
        // wildcard-imported package, and this source set declares no type of
        // that name — so the resolution is earned, not guessed, and its
        // provenance says how it was reached.
        write(repo, "src/ApiController.java", """
                package app;
                import org.springframework.web.bind.annotation.*;
                @RestController
                public class ApiController {
                    @GetMapping("/things")
                    public String things() { return "x"; }
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertTrue(has(facts, "edge", node ->
                        "annotated_with".equals(node.path("kind").asText())
                                && "org.springframework.web.bind.annotation.GetMapping"
                                        .equals(node.path("dst").path("fqn").asText())
                                && "wildcard-import".equals(node.path("attrs").path("resolution").asText())),
                "did not earn a resolution ADR-0023's three conditions allow");
        assertTrue(has(facts, "node", node ->
                        "endpoint".equals(node.path("kind").asText())
                                && "GET /things".equals(node.path("fqn").asText())),
                "resolved the annotation but did not record its endpoint");
        assertFalse(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("@GetMapping")),
                "resolved the annotation and still complained about it");
    }

    @Test
    void discountsAJdkWildcardImportWhenEarningResolution(@TempDir Path repo) throws Exception {
        // ADR-0023's earned extension, reached for after the M7 acceptance run
        // measured it: `import java.util.*;` cannot supply @GetMapping — the
        // JLS reserves java.* packages and anything they do supply is
        // type-attributed before resolution is ever attempted — so it does not
        // compete with the Spring wildcard.
        write(repo, "src/ApiController.java", """
                package app;
                import java.util.*;
                import org.springframework.web.bind.annotation.*;
                @RestController
                public class ApiController {
                    @GetMapping("/things")
                    public List<String> things() { return new ArrayList<>(); }
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertTrue(has(facts, "edge", node ->
                        "annotated_with".equals(node.path("kind").asText())
                                && "org.springframework.web.bind.annotation.GetMapping"
                                        .equals(node.path("dst").path("fqn").asText())
                                && "wildcard-import".equals(node.path("attrs").path("resolution").asText())),
                "let a java.* wildcard import block a resolution it cannot compete for");
        assertTrue(has(facts, "node", node ->
                        "endpoint".equals(node.path("kind").asText())
                                && "GET /things".equals(node.path("fqn").asText())),
                "resolved the annotation but did not record its endpoint");
    }

    @Test
    void refusesWhenTwoWildcardImportsCouldBothSupplyTheName(@TempDir Path repo) throws Exception {
        // ADR-0023 condition 2. The table says Spring declares GetMapping; it
        // cannot say com.other does not, so the ambiguity is real and must
        // survive — and the diagnostic must name the competitors.
        write(repo, "src/TwoWildcards.java", """
                package app;
                import org.springframework.web.bind.annotation.*;
                import com.other.*;
                public class TwoWildcards {
                    @GetMapping("/things")
                    public String things() { return "x"; }
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertFalse(has(facts, "edge", node -> "annotated_with".equals(node.path("kind").asText())),
                "guessed between two wildcard imports");
        assertFalse(has(facts, "node", node -> "endpoint".equals(node.path("kind").asText())),
                "invented an endpoint from an annotation it could not resolve");
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("@GetMapping")
                                && node.path("message").asText().contains("org.springframework.web.bind.annotation.*")
                                && node.path("message").asText().contains("com.other.*")),
                "did not name the competing wildcard imports");
    }

    @Test
    void refusesWhenTheSourceSetDeclaresItsOwnTypeOfThatName(@TempDir Path repo) throws Exception {
        // ADR-0023 condition 3. A repository that declares its own GetMapping
        // is exactly the case the earned resolution must not mis-attribute —
        // even when the declaration sits in another package.
        write(repo, "src/ApiController.java", """
                package app;
                import org.springframework.web.bind.annotation.*;
                public class ApiController {
                    @GetMapping("/things")
                    public String things() { return "x"; }
                }
                """);
        write(repo, "src/homegrown/GetMapping.java", """
                package homegrown;
                public @interface GetMapping {
                    String value() default "";
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertFalse(has(facts, "edge", node ->
                        "annotated_with".equals(node.path("kind").asText())
                                && node.path("dst").path("fqn").asText().startsWith("org.springframework")),
                "attributed a homegrown annotation to Spring");
        assertFalse(has(facts, "node", node -> "endpoint".equals(node.path("kind").asText())),
                "invented an endpoint from an annotation the repository redeclares");
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("@GetMapping")
                                && node.path("message").asText().contains("declares its own type")
                                && node.path("message").asText().contains("GetMapping.java")),
                "did not name the declaration that blocks the resolution");
    }

    @Test
    void aggregatesUnresolvedCallsPerFileRatherThanPerSite(@TempDir Path repo) throws Exception {
        write(repo, "src/Many.java", """
                package app;
                import com.nowhere.Missing;
                public class Many {
                    void go(Missing m) {
                        m.one();
                        m.two();
                        m.three();
                    }
                }
                """);

        List<JsonNode> facts = extract(repo);
        List<JsonNode> callDiagnostics = facts.stream()
                .filter(node -> "diagnostic".equals(node.path("type").asText()))
                .filter(node -> node.path("message").asText().contains("call site"))
                .toList();

        assertEquals(1, callDiagnostics.size(), "should be one diagnostic for the file, not one per site");
        assertTrue(callDiagnostics.get(0).path("message").asText().startsWith("3 call site"),
                "should say how many: " + callDiagnostics.get(0).path("message").asText());
    }

    @Test
    void callsAnInterfaceSupertypeExtendsBecauseTheSourceDoes(@TempDir Path repo) throws Exception {
        // OpenRewrite files an interface's supertypes under getImplements(),
        // which would have us report "interface A implements B" -- a sentence
        // about the source that the source does not say.
        write(repo, "src/A.java", "package p;\npublic interface A extends B {}\n");
        write(repo, "src/B.java", "package p;\npublic interface B {}\n");
        write(repo, "src/C.java", "package p;\npublic class C extends D implements A {}\n");
        write(repo, "src/D.java", "package p;\npublic class D {}\n");

        List<JsonNode> facts = extract(repo);
        List<String> inheritance = facts.stream()
                .filter(node -> "edge".equals(node.path("type").asText()))
                .filter(node -> node.path("kind").asText().matches("extends|implements"))
                .map(node -> node.path("kind").asText() + " "
                        + node.path("src").path("fqn").asText() + " -> "
                        + node.path("dst").path("fqn").asText())
                .sorted()
                .toList();

        assertEquals(
                List.of("extends p.A -> p.B", "extends p.C -> p.D", "implements p.C -> p.A"),
                inheritance);
    }

    @Test
    void resolvesThroughTwoWildcardsWhenTheOtherPackageIsListedAndLacksTheName(@TempDir Path repo) throws Exception {
        // ADR-0038: jackson-annotations' complete listing has no `Entity`, so
        // its wildcard cannot compete with jakarta.persistence.*.
        write(repo, "src/main/java/app/Owner.java", """
                package app;
                import jakarta.persistence.*;
                import com.fasterxml.jackson.annotation.*;
                @Entity
                @Table(name = "owners")
                public class Owner {}
                """);
        List<JsonNode> facts = extract(repo);
        assertTrue(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())
                && "owners".equals(node.path("dst").path("fqn").asText())));
    }

    @Test
    void stillRefusesWhenAnUnlistedPackageCouldCompete(@TempDir Path repo) throws Exception {
        write(repo, "src/main/java/app/Owner.java", """
                package app;
                import jakarta.persistence.*;
                import com.acme.orm.*;
                @Entity
                @Table(name = "owners")
                public class Owner {}
                """);
        List<JsonNode> facts = extract(repo);
        assertFalse(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())));
        assertTrue(has(facts, "diagnostic", node ->
                node.path("message").asText().contains("com.acme.orm.*")));
    }

    @Test
    void aFirstPartyWildcardCannotCompete(@TempDir Path repo) throws Exception {
        write(repo, "src/main/java/app/support/Money.java", """
                package app.support;
                public class Money {}
                """);
        write(repo, "src/main/java/app/Owner.java", """
                package app;
                import jakarta.persistence.*;
                import app.support.*;
                @Entity
                @Table(name = "owners")
                public class Owner { Money balance; }
                """);
        List<JsonNode> facts = extract(repo);
        assertTrue(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())));
    }

    @Test
    void injectsThroughLombokConstructorsAndBeanMethods(@TempDir Path repo) throws Exception {
        // ADR-0039: the constructor Lombok writes is the sole constructor of a
        // bean, so its parameters are injected; a @Bean method's parameters
        // are injected into its configuration class.
        write(repo, "src/main/java/app/Repo.java", """
                package app;
                public interface Repo {}
                """);
        write(repo, "src/main/java/app/Clock.java", """
                package app;
                public class Clock {}
                """);
        write(repo, "src/main/java/app/Service.java", """
                package app;
                import lombok.RequiredArgsConstructor;
                import org.springframework.stereotype.Service;
                @Service
                @RequiredArgsConstructor
                public class OrderService {
                    private final Repo repo;
                    private final Clock clock = new Clock();
                    private String notInjected;
                    private static final String CONSTANT = "x";
                }
                """);
        write(repo, "src/main/java/app/Config.java", """
                package app;
                import org.springframework.context.annotation.Bean;
                import org.springframework.context.annotation.Configuration;
                @Configuration
                public class Config {
                    @Bean
                    Clock clock(Repo repo) { return new Clock(); }
                }
                """);

        List<String> injections = extract(repo).stream()
                .filter(node -> "edge".equals(node.path("type").asText())
                        && "injects".equals(node.path("kind").asText()))
                .map(node -> node.path("src").path("fqn").asText() + " -> "
                        + node.path("dst").path("fqn").asText() + " "
                        + node.path("attrs").path("via").asText())
                .sorted()
                .toList();

        assertEquals(List.of(
                "app.Config -> app.Repo bean-method",
                "app.OrderService -> app.Repo lombok-required-args"), injections);
    }

    @Test
    void doesNotMakeANodeOfAKotlinObjectExpression(@TempDir Path repo) throws Exception {
        write(repo, "src/main/kotlin/app/Uses.kt", """
                package app
                class Uses {
                    val listener = object : Runnable { override fun run() {} }
                }
                """);
        assertFalse(has(extract(repo), "node", node -> node.path("name").asText().isEmpty()),
                "emitted a node with an empty name");
    }

    @Test
    void readsMappingsThroughAFirstPartyMetaAnnotationAndConstantPaths(@TempDir Path repo) throws Exception {
        // ADR-0043: a first-party annotation declared with a Spring mapping is
        // that mapping; a path built from source-set constants is a path.
        write(repo, "src/main/java/app/AnonymousGetMapping.java", """
                package app;
                import org.springframework.web.bind.annotation.RequestMapping;
                import org.springframework.web.bind.annotation.RequestMethod;
                @RequestMapping(method = RequestMethod.GET)
                public @interface AnonymousGetMapping { String[] value() default {}; }
                """);
        write(repo, "src/main/java/app/Paths.java", """
                package app;
                public interface Paths { String PREFIX = "/api"; String USERS = PREFIX + "/users"; }
                """);
        write(repo, "src/main/java/app/UserController.java", """
                package app;
                import org.springframework.web.bind.annotation.RestController;
                import org.springframework.web.bind.annotation.RequestMapping;
                import org.springframework.web.bind.annotation.PostMapping;
                @RestController
                @RequestMapping(Paths.USERS)
                public class UserController {
                    @AnonymousGetMapping("/{id:[0-9]+}") public String get() { return ""; }
                    @PostMapping(path = "/reset") public void reset() {}
                }
                """);
        List<String> endpoints = extract(repo).stream()
                .filter(node -> "node".equals(node.path("type").asText())
                        && "endpoint".equals(node.path("kind").asText()))
                .map(node -> node.path("fqn").asText())
                .sorted()
                .toList();
        assertEquals(List.of("GET /api/users/{id}", "POST /api/users/reset"), endpoints);
    }

    @Test
    void aClassConstructedInABeanMethodIsInjectedThroughItsConstructor(@TempDir Path repo) throws Exception {
        write(repo, "src/main/java/app/Registry.java", "package app; public class Registry {}");
        write(repo, "src/main/java/app/Locator.java", """
                package app;
                public class Locator { public Locator(Registry registry) {} }
                """);
        write(repo, "src/main/java/app/Unused.java", """
                package app;
                public class Unused { public Unused(Registry registry) {} }
                """);
        write(repo, "src/main/java/app/Config.java", """
                package app;
                import org.springframework.context.annotation.Bean;
                import org.springframework.context.annotation.Configuration;
                @Configuration
                public class Config {
                    @Bean Object locator() { return new Locator(new Registry()); }
                }
                """);
        List<String> injections = extract(repo).stream()
                .filter(node -> "edge".equals(node.path("type").asText())
                        && "injects".equals(node.path("kind").asText()))
                .map(node -> node.path("src").path("fqn").asText() + " -> "
                        + node.path("dst").path("fqn").asText())
                .sorted()
                .toList();
        assertEquals(List.of("app.Locator -> app.Registry"), injections);
    }

    @Test
    void joinsAnApiFirstControllerToItsOpenApiOperations(@TempDir Path repo) throws Exception {
        // ADR-0044: the generated interface is not in the source set; the spec
        // is, and the override's name is the operation's operationId.
        write(repo, "src/main/resources/openapi.yml", """
                openapi: 3.0.1
                info:
                  title: x
                paths:
                  /owners:
                    get:
                      operationId: listOwners
                    post:
                      operationId: addOwner
                  /owners/{ownerId}:
                    get:
                      operationId: getOwner
                components: {}
                """);
        write(repo, "src/main/java/app/OwnerController.java", """
                package app;
                import org.springframework.web.bind.annotation.RestController;
                import org.springframework.web.bind.annotation.RequestMapping;
                @RestController
                @RequestMapping("/api")
                public class OwnerController implements OwnersApi {
                    @Override public Object listOwners() { return null; }
                    @Override public Object getOwner(int ownerId) { return null; }
                    public Object addOwner() { return null; }
                }
                """);
        List<String> endpoints = extract(repo).stream()
                .filter(node -> "node".equals(node.path("type").asText())
                        && "endpoint".equals(node.path("kind").asText()))
                .map(node -> node.path("fqn").asText() + " @" + node.path("file").asText() + ":"
                        + node.path("startLine").asInt())
                .sorted()
                .toList();
        // addOwner is not an @Override, so it is not joined to the route.
        assertEquals(List.of(
                "GET /api/owners @src/main/resources/openapi.yml:6",
                "GET /api/owners/{ownerId} @src/main/resources/openapi.yml:11"), endpoints);
    }

    @Test
    void readsAConstantFromANestedClass(@TempDir Path repo) throws Exception {
        write(repo, "src/main/java/app/constant/Constants.java", """
                package app.constant;
                public class Constants {
                    public static class A2A {
                        public static final String ADMIN_PATH = "/v3/admin/ai/a2a";
                    }
                }
                """);
        write(repo, "src/main/java/app/A2aController.java", """
                package app;
                import app.constant.Constants;
                import org.springframework.web.bind.annotation.GetMapping;
                import org.springframework.web.bind.annotation.RequestMapping;
                import org.springframework.web.bind.annotation.RestController;
                @RestController
                @RequestMapping(Constants.A2A.ADMIN_PATH)
                public class A2aController {
                    @GetMapping("/detail") public String detail() { return ""; }
                }
                """);
        assertTrue(has(extract(repo), "node", node -> "GET /v3/admin/ai/a2a/detail".equals(node.path("fqn").asText())));
    }

    @Test
    void willNotNameATableUnderANamingStrategyItDoesNotKnow(@TempDir Path repo) throws Exception {
        // ADR-0036: a default-named entity's table is its name put through the
        // module's physical naming strategy. A custom strategy class could do
        // anything to `Order`; naming a table after it would be a guess.
        write(repo, "pom.xml", "<project><artifactId>app</artifactId></project>");
        write(repo, "src/main/resources/application.properties",
                "spring.jpa.hibernate.naming.physical-strategy=com.acme.PrefixingStrategy\n");
        write(repo, "src/main/java/app/Order.java", """
                package app;
                import javax.persistence.Entity;
                @Entity
                public class Order {}
                """);

        List<JsonNode> facts = extract(repo);

        assertFalse(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())),
                "invented a table name from a naming strategy it cannot read");
        assertFalse(has(facts, "node", node -> "table".equals(node.path("kind").asText())));
        assertTrue(has(facts, "diagnostic", node ->
                node.path("message").asText().contains("com.acme.PrefixingStrategy")));
    }

    @Test
    void namesADefaultTableByTheRuleItCanCite(@TempDir Path repo) throws Exception {
        // Plain JPA with no Spring Boot and no override: the physical name is
        // the logical one as written, and the edge says which rule applied.
        write(repo, "src/Order.java", """
                package app;
                import javax.persistence.Entity;
                @Entity
                public class Order {}
                """);

        List<JsonNode> facts = extract(repo);

        assertTrue(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())
                && "order".equals(node.path("dst").path("fqn").asText())
                && "as-written".equals(node.path("attrs").path("strategy").asText())
                && "class-name".equals(node.path("attrs").path("naming").asText())));
    }

    @Test
    void keepsGoingWhenOneFileWillNotParse(@TempDir Path repo) throws Exception {
        write(repo, "src/Fine.java", """
                package app;
                public class Fine {
                    int answer() { return 42; }
                }
                """);
        write(repo, "src/Broken.java", """
                package app;
                public class Broken {
                    this is not java at all ((( ;
                }
                """);

        List<JsonNode> facts = extract(repo);

        assertTrue(has(facts, "diagnostic", node ->
                        "error".equals(node.path("level").asText())
                                && node.path("file").asText().endsWith("Broken.java")),
                "did not report the unparseable file");
        // Partial results beat no results: the other file is still mapped.
        assertTrue(has(facts, "node", node -> "app.Fine#answer()".equals(node.path("fqn").asText())),
                "lost the parseable file because a sibling did not parse");
    }

    @Test
    void treatsARepositoryWithNoBuildFileAsOneModule(@TempDir Path repo) throws Exception {
        // Legacy layout: sources under src/, no pom, no gradle, no Ant.
        write(repo, "src/legacy/Thing.java", """
                package legacy;
                public class Thing {}
                """);

        List<JsonNode> facts = extract(repo);

        List<JsonNode> modules = facts.stream()
                .filter(node -> "node".equals(node.path("type").asText()))
                .filter(node -> "module".equals(node.path("kind").asText()))
                .toList();
        assertEquals(1, modules.size(), "expected exactly one module");
        assertEquals(repo.getFileName().toString(), modules.get(0).path("fqn").asText());
        assertTrue(has(facts, "node", node -> "legacy.Thing".equals(node.path("fqn").asText())),
                "did not find sources outside a Maven layout");
    }

    @Test
    void reportsFrameworkXmlItDidNotParse(@TempDir Path repo) throws Exception {
        write(repo, "src/App.java", "package app;\npublic class App {}\n");
        write(repo, "WEB-INF/applicationContext.xml",
                "<beans><bean id=\"orderService\" class=\"app.OrderService\"/></beans>\n");

        List<JsonNode> facts = extract(repo);

        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("XML configuration not parsed")
                                && node.path("file").asText().endsWith("applicationContext.xml")),
                "stayed silent about wiring it could not see");
        // And emitted nothing about the bean declared in there.
        assertFalse(has(facts, "node", node -> node.path("fqn").asText().contains("OrderService")),
                "invented a node from XML it never parsed");
    }

    private static void write(Path repo, String relative, String content) throws Exception {
        Path file = repo.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }

    private static boolean has(List<JsonNode> facts, String type, java.util.function.Predicate<JsonNode> test) {
        return facts.stream()
                .filter(node -> type.equals(node.path("type").asText()))
                .anyMatch(test);
    }

    private static List<JsonNode> extract(Path repo) throws Exception {
        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();
        int status = Main.run(new String[]{"--repo", repo.toString()},
                new PrintStream(stdout, true, StandardCharsets.UTF_8),
                new PrintStream(stderr, true, StandardCharsets.UTF_8));
        assertEquals(0, status, stderr.toString(StandardCharsets.UTF_8));

        ObjectMapper mapper = new ObjectMapper();
        List<JsonNode> facts = new ArrayList<>();
        for (String line : stdout.toString(StandardCharsets.UTF_8).split("\n")) {
            if (!line.isBlank()) {
                facts.add(mapper.readTree(line));
            }
        }
        return facts;
    }
}
