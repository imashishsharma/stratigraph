package dev.stratigraph.extractor.java;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The Gradle shapes a deployability proof takes (ADR-0040), and the ones that
 * must not count. The fixtures cover the common case; these cover the spellings.
 */
class BuildFilesTest {

    @TempDir
    Path dir;

    private BuildFiles.Proof gradle(String script) throws Exception {
        Path file = dir.resolve("build.gradle");
        Files.writeString(file, script);
        return BuildFiles.readGradle(file);
    }

    @Test
    void readsTheWarPluginInEverySpelling() throws Exception {
        assertEquals("war", gradle("plugins {\n    id 'war'\n}\n").kind());
        assertEquals("war", gradle("plugins {\n    war\n}\n").kind());
        assertEquals("war", gradle("plugins { id(\"war\") }\n").kind());
        assertEquals("war", gradle("apply plugin: 'war'\n").kind());
    }

    @Test
    void citesTheLineThePluginIsAppliedOn() throws Exception {
        BuildFiles.Proof proof = gradle("// a comment\nplugins {\n    id 'java'\n    id 'org.springframework.boot' version '3.3.0'\n}\n");
        assertEquals("spring-boot", proof.kind());
        assertEquals(4, proof.line());
        assertEquals("gradle:plugins org.springframework.boot", proof.rule());
    }

    @Test
    void refusesWhatBuildLogicDecides() throws Exception {
        assertNull(gradle("plugins {\n    id 'org.springframework.boot' version '3.3.0' apply false\n}\n"));
        assertNull(gradle("subprojects {\n    apply plugin: 'org.springframework.boot'\n}\n"));
        assertNull(gradle("allprojects {\n    plugins { id 'war' }\n}\n"));
        assertNull(gradle("// plugins { id 'war' }\n/* apply plugin: 'war' */\n"));
    }

    @Test
    void theBootPluginOutranksWar() throws Exception {
        assertEquals("spring-boot", gradle("plugins {\n    id 'war'\n    id 'org.springframework.boot'\n}\n").kind());
    }
}
