package dev.stratigraph.extractor.java;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fixture contract: for each tiny hand-written repository, the extractor
 * must emit exactly the facts in its {@code expected-facts.ndjson}.
 *
 * Exact, not "contains" — CLAUDE.md asks for exact assertions because the
 * failures that matter here are facts appearing that should not (a guessed
 * edge) as much as facts going missing. A subset assertion catches only half of
 * that.
 *
 * The golden can be regenerated with {@code -Dstratigraph.updateGoldens=true},
 * but a regenerated golden is only worth having if a human reads the diff.
 */
class ExtractorGoldenTest {

    /** Fixtures live in the repository root, two levels above this Maven module. */
    private static final Path FIXTURES = Path.of("..", "..", "fixtures").toAbsolutePath().normalize();

    @ParameterizedTest
    @ValueSource(strings = {"tiny-java", "tiny-spring"})
    void emitsExactlyTheExpectedFacts(String fixture) throws Exception {
        Path repo = FIXTURES.resolve(fixture);
        assertTrue(Files.isDirectory(repo), "fixture not found: " + repo);

        List<String> actual = extract(repo);
        Path golden = repo.resolve("expected-facts.ndjson");

        if (Boolean.getBoolean("stratigraph.updateGoldens")) {
            Files.write(golden, actual);
            return;
        }

        assertTrue(Files.exists(golden),
                "no golden for " + fixture + "; regenerate with -Dstratigraph.updateGoldens=true");
        assertEquals(
                String.join("\n", Files.readAllLines(golden)),
                String.join("\n", actual),
                "extracted facts differ from " + golden);
    }

    /**
     * Run the extractor and capture its fact stream.
     *
     * The repository path in the `meta` fact is absolute and therefore
     * machine-specific, so it is replaced with a placeholder. Nothing else is
     * normalised: line numbers, ordering and fqns are all part of the contract.
     */
    private static List<String> extract(Path repo) throws Exception {
        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();

        int status = Main.run(
                new String[]{"--repo", repo.toString()},
                new PrintStream(stdout, true, StandardCharsets.UTF_8),
                new PrintStream(stderr, true, StandardCharsets.UTF_8));
        assertEquals(0, status, "extractor failed: " + stderr.toString(StandardCharsets.UTF_8));

        return stdout.toString(StandardCharsets.UTF_8)
                .lines()
                .map(line -> line.replace(repo.toString().replace("\\", "\\\\"), "<repo>"))
                .toList();
    }
}
