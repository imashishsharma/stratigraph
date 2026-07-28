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
    void doesNotInventAnEdgeForAnUnresolvableSupertypeOrCall(@TempDir Path repo) throws Exception {
        // `Missing` is imported from a jar that does not exist. A classpath
        // would resolve it; we have none, and must not pretend otherwise.
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

        assertFalse(has(facts, "edge", node -> "extends".equals(node.path("kind").asText())),
                "emitted an extends edge to a type it could not resolve");
        assertFalse(has(facts, "edge", node -> "calls".equals(node.path("kind").asText())),
                "emitted a calls edge to a method on a type it could not resolve");

        // The `imports` edge to com.nowhere.Missing *is* emitted, and should be:
        // the file literally says `import com.nowhere.Missing`, so the fully
        // qualified name is a fact the parser read, not one we inferred. The
        // distinction this test is drawing is between reading a name and
        // resolving a type.
        assertTrue(has(facts, "edge", node ->
                        "imports".equals(node.path("kind").asText())
                                && "com.nowhere.Missing".equals(node.path("dst").path("fqn").asText())),
                "dropped an import whose fully qualified name the source states outright");

        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("supertype")
                                && node.path("level").asText().equals("info")),
                "did not report the unresolved supertype");
        assertTrue(has(facts, "diagnostic", node ->
                        node.path("message").asText().contains("call site")),
                "did not report the unresolved call site");

        // The class itself is still a fact -- we read that file.
        assertTrue(has(facts, "node", node -> "app.Repo".equals(node.path("fqn").asText())));
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
