package dev.stratigraph.extractor.java;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Operations declared in OpenAPI specifications in the repository (ADR-0044).
 *
 * An API-first Spring application generates its controller interfaces from a
 * spec at build time; the routes are in the spec, and the committed controller
 * only overrides the generated methods, which are named after each
 * operation's {@code operationId}. This reads the spec's {@code paths} — a
 * file in the repository, cited at the line of each operation — so the
 * extractor can join an override to the route it serves.
 */
final class OpenApiSpecs {

    record Operation(String method, String path, String operationId, String file, int line) {}

    private static final Set<String> VERBS = Set.of("get", "post", "put", "delete", "patch", "head", "options");
    private static final Pattern SPEC_NAME = Pattern.compile("(?i).*(openapi|swagger|api)[\\w.-]*\\.(ya?ml|json)$");

    private final Map<String, List<Operation>> byOperationId = new HashMap<>();

    static OpenApiSpecs discover(Path repoRoot, Set<String> excludedDirectories) {
        OpenApiSpecs specs = new OpenApiSpecs();
        try {
            Files.walkFileTree(repoRoot, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String name = dir.getFileName() == null ? "" : dir.getFileName().toString();
                    boolean test = dir.toString().replace('\\', '/').contains("/src/test/");
                    return !dir.equals(repoRoot) && (excludedDirectories.contains(name) || test || name.startsWith("."))
                            ? FileVisitResult.SKIP_SUBTREE
                            : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (attrs.size() < 5_000_000 && SPEC_NAME.matcher(file.getFileName().toString()).matches()) {
                        specs.read(repoRoot, file);
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException ignored) {
            // A walk that fails part-way reads what it reached.
        }
        return specs;
    }

    List<Operation> operations(String operationId) {
        return byOperationId.getOrDefault(operationId, List.of());
    }

    boolean isEmpty() {
        return byOperationId.isEmpty();
    }

    private void read(Path repoRoot, Path file) {
        String text;
        try {
            text = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return;
        }
        String head = text.substring(0, Math.min(text.length(), 2048));
        if (!head.contains("openapi") && !head.contains("swagger")) {
            return;
        }
        String relative = repoRoot.relativize(file).toString().replace('\\', '/');
        if (relative.endsWith(".json")) {
            readJson(relative, text);
        } else {
            readYaml(relative, text);
        }
    }

    /** The `paths` block of a YAML spec, by indentation. */
    private void readYaml(String file, String text) {
        String[] lines = text.split("\n", -1);
        int pathsIndent = -1;
        int pathIndent = -1;
        int methodIndent = -1;
        String path = null;
        String method = null;
        int methodLine = 0;
        Pattern key = Pattern.compile("^(\\s*)(['\"]?)([^'\"#]+?)\\2\\s*:\\s*(.*)$");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            if (line.isBlank() || line.trim().startsWith("#")) {
                continue;
            }
            Matcher m = key.matcher(line);
            if (!m.matches()) {
                continue;
            }
            int indent = m.group(1).length();
            String name = m.group(3).trim();
            String value = m.group(4).trim();
            if (pathsIndent < 0) {
                if (indent == 0 && name.equals("paths")) {
                    pathsIndent = 0;
                }
                continue;
            }
            if (indent <= pathsIndent) {
                break; // the next top-level key: paths are over
            }
            if (pathIndent < 0) {
                pathIndent = indent;
            }
            if (indent == pathIndent) {
                path = name.startsWith("/") ? name : null;
                method = null;
                methodIndent = -1;
                continue;
            }
            if (path == null) {
                continue;
            }
            if (methodIndent < 0 || indent <= methodIndent) {
                if (VERBS.contains(name.toLowerCase(Locale.ROOT))) {
                    methodIndent = indent;
                    method = name.toUpperCase(Locale.ROOT);
                    methodLine = i + 1;
                } else if (indent <= methodIndent) {
                    method = null;
                }
                continue;
            }
            if (method != null && name.equals("operationId") && !value.isEmpty()) {
                add(new Operation(method, path, value.replaceAll("^['\"]|['\"]$", ""), file, methodLine));
            }
        }
    }

    private void readJson(String file, String text) {
        JsonNode root;
        try {
            root = new ObjectMapper().readTree(text);
        } catch (IOException e) {
            return;
        }
        JsonNode paths = root.path("paths");
        for (Iterator<Map.Entry<String, JsonNode>> it = paths.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            for (Iterator<Map.Entry<String, JsonNode>> ops = entry.getValue().fields(); ops.hasNext(); ) {
                Map.Entry<String, JsonNode> op = ops.next();
                String id = op.getValue().path("operationId").asText("");
                if (VERBS.contains(op.getKey()) && !id.isEmpty()) {
                    int at = text.indexOf("\"" + id + "\"");
                    int line = at < 0 ? 1 : (int) text.substring(0, at).chars().filter(c -> c == '\n').count() + 1;
                    add(new Operation(op.getKey().toUpperCase(Locale.ROOT), entry.getKey(), id, file, line));
                }
            }
        }
    }

    private void add(Operation operation) {
        byOperationId.computeIfAbsent(operation.operationId(), k -> new ArrayList<>()).add(operation);
    }
}
