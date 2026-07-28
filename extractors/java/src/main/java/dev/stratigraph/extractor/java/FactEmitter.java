package dev.stratigraph.extractor.java;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The extractor's half of the NDJSON protocol (ADR-0003): one JSON object per
 * line on stdout, nothing else on stdout ever.
 *
 * Key order is fixed by using {@link LinkedHashMap} throughout, so the output
 * is byte-stable. That is what lets the fixture tests compare against a golden
 * file rather than against a parsed-and-reordered approximation of one.
 */
final class FactEmitter {

    static final int PROTOCOL_VERSION = 1;

    private final PrintStream out;
    private final ObjectMapper json = new ObjectMapper();

    /** Nodes already declared, so a type referenced twice is emitted once. */
    private final Set<String> emittedNodes = new HashSet<>();

    private int nodes;
    private int edges;
    private int files;
    private int diagnostics;

    FactEmitter(PrintStream out) {
        this.out = out;
    }

    void meta(String extractor, String version, String repoPath) {
        Map<String, Object> fact = fact("meta");
        fact.put("extractor", extractor);
        fact.put("extractorVersion", version);
        fact.put("repoPath", repoPath);
        write(fact);
    }

    void file(String path, String language, int loc) {
        Map<String, Object> fact = fact("file");
        fact.put("path", path);
        fact.put("language", language);
        fact.put("loc", loc);
        write(fact);
        files++;
    }

    /**
     * Declare a node once. Returns false if it was already declared, which lets
     * a caller skip re-walking something it has already described.
     */
    boolean node(
            String kind,
            String fqn,
            String name,
            NodeRef parent,
            String file,
            Integer startLine,
            Integer endLine,
            Map<String, Object> attrs) {
        if (!emittedNodes.add(kind + " " + fqn)) {
            return false;
        }
        Map<String, Object> fact = fact("node");
        fact.put("kind", kind);
        fact.put("fqn", fqn);
        fact.put("name", name);
        if (parent != null) {
            fact.put("parent", parent.toMap());
        }
        putIfPresent(fact, "file", file);
        putIfPresent(fact, "startLine", startLine);
        putIfPresent(fact, "endLine", endLine);
        if (attrs != null && !attrs.isEmpty()) {
            fact.put("attrs", attrs);
        }
        write(fact);
        nodes++;
        return true;
    }

    void edge(
            String kind,
            NodeRef src,
            NodeRef dst,
            String file,
            Integer line,
            Map<String, Object> attrs) {
        Map<String, Object> fact = fact("edge");
        fact.put("kind", kind);
        fact.put("src", src.toMap());
        fact.put("dst", dst.toMap());
        putIfPresent(fact, "file", file);
        putIfPresent(fact, "line", line);
        if (attrs != null && !attrs.isEmpty()) {
            fact.put("attrs", attrs);
        }
        write(fact);
        edges++;
    }

    void diagnostic(String level, String message, String file, Integer line) {
        Map<String, Object> fact = fact("diagnostic");
        fact.put("level", level);
        fact.put("message", message);
        putIfPresent(fact, "file", file);
        putIfPresent(fact, "line", line);
        write(fact);
        diagnostics++;
    }

    /** For the human-readable summary on stderr. stdout stays pure NDJSON. */
    String summary() {
        return files + " files, " + nodes + " nodes, " + edges + " edges, "
                + diagnostics + " diagnostics";
    }

    private static Map<String, Object> fact(String type) {
        Map<String, Object> fact = new LinkedHashMap<>();
        fact.put("v", PROTOCOL_VERSION);
        fact.put("type", type);
        return fact;
    }

    private static void putIfPresent(Map<String, Object> fact, String key, Object value) {
        if (value != null) {
            fact.put(key, value);
        }
    }

    private void write(Map<String, Object> fact) {
        try {
            out.println(json.writeValueAsString(fact));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** How an extractor refers to a node it may not have emitted itself. */
    static final class NodeRef {
        private final String kind;
        private final String fqn;

        NodeRef(String kind, String fqn) {
            this.kind = kind;
            this.fqn = fqn;
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("kind", kind);
            map.put("fqn", fqn);
            return map;
        }
    }
}
