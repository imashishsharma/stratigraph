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
    void willNotNameATableTheSourceDoesNotName(@TempDir Path repo) throws Exception {
        // An @Entity with no @Table gets its table name from the persistence
        // provider's naming strategy at runtime -- `Order` could become
        // `order`, `orders` or `ORDER` depending on configuration we cannot
        // see. Any of those would look right in a report and be a guess.
        write(repo, "src/Order.java", """
                package app;
                import javax.persistence.Entity;
                @Entity
                public class Order {}
                """);

        List<JsonNode> facts = extract(repo);

        assertFalse(has(facts, "edge", node -> "maps_to".equals(node.path("kind").asText())),
                "invented a table name from a naming strategy it cannot see");
        assertFalse(has(facts, "node", node -> "table".equals(node.path("kind").asText())));
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("naming strategy")),
                "stayed silent about the entity whose table it could not name");

        // The entity annotation itself is still recorded -- javax, not jakarta.
        assertTrue(has(facts, "edge", node ->
                        "annotated_with".equals(node.path("kind").asText())
                                && "javax.persistence.Entity".equals(node.path("dst").path("fqn").asText())),
                "missed a javax-namespace annotation");
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
