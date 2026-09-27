package dev.stratigraph.extractor.java;

import org.xml.sax.Attributes;
import org.xml.sax.Locator;
import org.xml.sax.helpers.DefaultHandler;

import javax.xml.parsers.SAXParser;
import javax.xml.parsers.SAXParserFactory;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a build file says about its module, read as text (ADR-0006, ADR-0040).
 *
 * Two questions only: what the module is called, and whether the build file
 * proves it produces something that runs. Neither answer comes from running the
 * build: a POM is read as XML, a Gradle script as lines, and anything decided by
 * build logic we would have to execute — a plugin applied from
 * {@code subprojects {}}, a version-catalog alias, a parent POM's
 * {@code <build><plugins>} — is left unread rather than guessed.
 */
final class BuildFiles {

    private BuildFiles() {
    }

    /** A deployability proof: which kind, and the line and rule that read it. */
    record Proof(String kind, int line, String rule) {
    }

    /** What a POM declares about its own project. */
    static final class Pom {
        String groupId;
        String parentGroupId;
        String artifactId;
        String packaging;
        final List<String> modules = new ArrayList<>();
        Proof proof;
    }

    /**
     * Read a POM with line numbers. SAX rather than DOM because a citation
     * needs the line, and DOM discards it.
     */
    static Pom readPom(Path pom) throws Exception {
        SAXParserFactory factory = SAXParserFactory.newInstance();
        // A POM is data. Do not let it reach out to a DTD or an entity.
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setXIncludeAware(false);
        SAXParser parser = factory.newSAXParser();

        Pom result = new Pom();
        int[] packagingLine = {0};
        try (InputStream in = Files.newInputStream(pom)) {
            parser.parse(in, new DefaultHandler() {
                private final Deque<String> path = new ArrayDeque<>();
                private final StringBuilder text = new StringBuilder();
                private Locator locator;
                private int textLine;

                @Override
                public void setDocumentLocator(Locator locator) {
                    this.locator = locator;
                }

                @Override
                public void startElement(String uri, String localName, String qName, Attributes attributes) {
                    path.addLast(localName(qName));
                    text.setLength(0);
                    textLine = locator == null ? 0 : locator.getLineNumber();
                }

                @Override
                public void characters(char[] ch, int start, int length) {
                    text.append(ch, start, length);
                }

                @Override
                public void endElement(String uri, String localName, String qName) {
                    String at = String.join("/", path);
                    String value = text.toString().trim();
                    switch (at) {
                        case "project/groupId" -> result.groupId = value;
                        case "project/parent/groupId" -> result.parentGroupId = value;
                        case "project/artifactId" -> result.artifactId = value;
                        case "project/packaging" -> {
                            result.packaging = value;
                            packagingLine[0] = textLine;
                        }
                        case "project/modules/module" -> result.modules.add(value);
                        // Only the project's own <build><plugins>. <pluginManagement>
                        // configures children and applies nothing; a <profile> is
                        // switched on by a build we do not run.
                        case "project/build/plugins/plugin/artifactId" -> {
                            if (value.equals("spring-boot-maven-plugin") && result.proof == null) {
                                result.proof = new Proof("spring-boot", textLine,
                                        "maven:build/plugins/spring-boot-maven-plugin");
                            }
                        }
                        default -> {
                        }
                    }
                    path.removeLast();
                    text.setLength(0);
                }
            });
        }

        if ("pom".equals(result.packaging)) {
            // A parent, an aggregator or a BOM produces no artifact that runs,
            // whatever plugins it declares for its children.
            result.proof = null;
        } else if ("war".equals(result.packaging) && result.proof == null) {
            result.proof = new Proof("war", packagingLine[0], "maven:packaging=war");
        }
        return result;
    }

    private static String localName(String qName) {
        int colon = qName.indexOf(':');
        return colon == -1 ? qName : qName.substring(colon + 1);
    }

    // ----------------------------------------------------------------- Gradle

    private static final Pattern BOOT_ID =
            Pattern.compile("\\bid\\s*\\(?\\s*[\"']org\\.springframework\\.boot[\"']");
    private static final Pattern WAR_ID = Pattern.compile("\\bid\\s*\\(?\\s*[\"']war[\"']");
    /** Kotlin DSL's built-in accessor: a bare {@code war} line inside {@code plugins {}}. */
    private static final Pattern WAR_ACCESSOR = Pattern.compile("^\\s*`?war`?\\s*$");
    private static final Pattern APPLY_BOOT = Pattern.compile(
            "\\bapply\\s*\\(?\\s*plugin\\s*[:=]\\s*[\"']org\\.springframework\\.boot[\"']");
    private static final Pattern APPLY_WAR =
            Pattern.compile("\\bapply\\s*\\(?\\s*plugin\\s*[:=]\\s*[\"']war[\"']");
    private static final Pattern APPLY_FALSE = Pattern.compile("\\bapply\\s*\\(?\\s*false\\b");
    private static final Pattern BLOCK_NAME = Pattern.compile("([A-Za-z_][\\w.]*)\\s*(\\(.*\\))?\\s*$");

    /**
     * Whether a Gradle build script applies the Boot or the war plugin to its
     * own project.
     *
     * Only the script's top-level {@code plugins {}} block and top-level
     * {@code apply plugin:} lines count. {@code apply false} applies nothing,
     * and a plugin applied from inside {@code subprojects {}} or
     * {@code allprojects {}} reaches a child through build logic — which child,
     * and whether, is the build's to decide, not ours.
     */
    static Proof readGradle(Path script) throws IOException {
        List<String> lines = Files.readAllLines(script, StandardCharsets.UTF_8);
        Deque<String> blocks = new ArrayDeque<>();
        boolean inBlockComment = false;
        Proof boot = null;
        Proof war = null;

        for (int n = 0; n < lines.size(); n++) {
            String line = lines.get(n);
            StringBuilder code = new StringBuilder();
            // Strip comments; strings are left alone, which is good enough for
            // the shapes of line a plugin declaration takes.
            for (int i = 0; i < line.length(); i++) {
                if (inBlockComment) {
                    if (line.startsWith("*/", i)) {
                        inBlockComment = false;
                        i++;
                    }
                    continue;
                }
                if (line.startsWith("/*", i)) {
                    inBlockComment = true;
                    i++;
                    continue;
                }
                if (line.startsWith("//", i)) {
                    break;
                }
                code.append(line.charAt(i));
            }
            String text = code.toString();

            // The block context in force where each statement on the line starts.
            StringBuilder segment = new StringBuilder();
            for (int i = 0; i <= text.length(); i++) {
                char c = i < text.length() ? text.charAt(i) : '\n';
                if (c == '{' || c == '}' || c == ';' || c == '\n') {
                    String statement = segment.toString();
                    String kind = pluginIn(statement, blocks);
                    if ("spring-boot".equals(kind) && boot == null) {
                        boot = new Proof("spring-boot", n + 1, ruleFor(blocks, "org.springframework.boot"));
                    } else if ("war".equals(kind) && war == null) {
                        war = new Proof("war", n + 1, ruleFor(blocks, "war"));
                    }
                    if (c == '{') {
                        Matcher name = BLOCK_NAME.matcher(statement.trim());
                        blocks.addLast(name.find() ? name.group(1) : "");
                    } else if (c == '}' && !blocks.isEmpty()) {
                        blocks.removeLast();
                    }
                    segment.setLength(0);
                } else {
                    segment.append(c);
                }
            }
        }
        return boot != null ? boot : war;
    }

    /** The plugin a statement applies to this project, or null. */
    private static String pluginIn(String statement, Deque<String> blocks) {
        boolean topLevel = blocks.isEmpty();
        boolean inPlugins = blocks.size() == 1 && "plugins".equals(blocks.peekLast());
        if (APPLY_FALSE.matcher(statement).find()) {
            return null;
        }
        if (inPlugins) {
            if (BOOT_ID.matcher(statement).find()) return "spring-boot";
            if (WAR_ID.matcher(statement).find() || WAR_ACCESSOR.matcher(statement).find()) return "war";
        }
        if (topLevel) {
            if (APPLY_BOOT.matcher(statement).find()) return "spring-boot";
            if (APPLY_WAR.matcher(statement).find()) return "war";
        }
        return null;
    }

    private static String ruleFor(Deque<String> blocks, String plugin) {
        return blocks.isEmpty() ? "gradle:apply plugin " + plugin : "gradle:plugins " + plugin;
    }
}
