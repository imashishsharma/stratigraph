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
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Type arguments on a field, recorded beside the erased type.
 *
 * ADR-0007 erases a field's type for the fqn, and has to: an fqn appears in a
 * method signature, so {@code List<Pet>} and {@code List<Vet>} must produce the
 * same string or one overload becomes two nodes. That erasure also throws away
 * the only thing that says what a collection holds, which is the difference
 * between "this entity has a to-many relationship" and "this entity has a
 * to-many relationship with Pet".
 *
 * So the arguments are recorded separately. These tests pin both halves: the
 * fqn stays erased, and the attribute carries what the erasure dropped.
 */
class TypeArgumentTest {

    @Test
    void recordsTheArgumentAnErasedCollectionTypeDropped(@TempDir Path repo) throws Exception {
        write(repo, "src/Order.java", """
                package shop;
                import java.util.List;
                public class Order {
                    private List<OrderLine> lines;
                }
                """);
        write(repo, "src/OrderLine.java", """
                package shop;
                public class OrderLine {}
                """);

        JsonNode lines = field(extract(repo), "shop.Order#lines");

        assertEquals("java.util.List", lines.path("attrs").path("type").asText(),
                "the erased type is what the fqn scheme depends on and must not change");
        assertEquals(List.of("shop.OrderLine"), arguments(lines),
                "dropped the argument, leaving the collection's contents unreadable");
    }

    @Test
    void recordsEveryArgumentOfAMultiArgumentType(@TempDir Path repo) throws Exception {
        write(repo, "src/Holder.java", """
                package shop;
                import java.util.Map;
                public class Holder {
                    private Map<String, Integer> attributes;
                }
                """);

        assertEquals(List.of("java.lang.String", "java.lang.Integer"),
                arguments(field(extract(repo), "shop.Holder#attributes")));
    }

    @Test
    void recordsNothingForAPlainType(@TempDir Path repo) throws Exception {
        write(repo, "src/Plain.java", """
                package shop;
                public class Plain {
                    private String name;
                }
                """);

        JsonNode name = field(extract(repo), "shop.Plain#name");
        assertEquals("java.lang.String", name.path("attrs").path("type").asText());
        assertFalse(name.path("attrs").has("typeArguments"),
                "invented an empty argument list for a type that has none");
    }

    @Test
    void reportsWhatItReadAndNotWhatItCouldNot(@TempDir Path repo) throws Exception {
        // `Missing` comes from a jar nobody read, so the parser cannot attribute
        // it. The list itself is still readable, and reporting one argument out
        // of two is honest in a way that padding it to two never is.
        write(repo, "src/Mixed.java", """
                package shop;
                import java.util.Map;
                import com.nowhere.Missing;
                public class Mixed {
                    private Map<String, Missing> byName;
                }
                """);

        JsonNode byName = field(extract(repo), "shop.Mixed#byName");
        assertEquals("java.util.Map", byName.path("attrs").path("type").asText());
        assertTrue(arguments(byName).contains("java.lang.String"),
                "dropped the argument it could read because another one was unreadable");
        assertFalse(arguments(byName).stream().anyMatch(a -> a.contains("?") || a.isBlank()),
                "emitted a placeholder for a type it never resolved");
    }

    @Test
    void leavesTheMethodFqnErased(@TempDir Path repo) throws Exception {
        // The point of the erasure. Two overloads differing only by type
        // argument are one method to the JVM, and must be one node here.
        write(repo, "src/Repo.java", """
                package shop;
                import java.util.List;
                public class Repo {
                    void save(List<String> names) {}
                }
                """);

        assertTrue(extract(repo).stream().anyMatch(node ->
                        "node".equals(node.path("type").asText())
                                && "shop.Repo#save(java.util.List)".equals(node.path("fqn").asText())),
                "let a type argument into an fqn, which would split overloads into separate nodes");
    }

    private static List<String> arguments(JsonNode field) {
        List<String> found = new ArrayList<>();
        field.path("attrs").path("typeArguments").forEach(node -> found.add(node.asText()));
        return found;
    }

    private static JsonNode field(List<JsonNode> facts, String fqn) {
        Optional<JsonNode> found = facts.stream()
                .filter(node -> "node".equals(node.path("type").asText())
                        && "field".equals(node.path("kind").asText())
                        && fqn.equals(node.path("fqn").asText()))
                .findFirst();
        assertTrue(found.isPresent(), "no field fact for " + fqn);
        return found.get();
    }

    private static void write(Path repo, String relative, String content) throws Exception {
        Path file = repo.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
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
