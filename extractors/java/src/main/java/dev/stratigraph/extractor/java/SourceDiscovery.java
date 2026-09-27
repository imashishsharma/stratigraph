package dev.stratigraph.extractor.java;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Finding the Java in a repository, per ADR-0006.
 *
 * The rule that matters: **no layout is assumed**. We walk for {@code .java}
 * files rather than globbing {@code src/main/java}, because the repositories
 * this tool exists for keep their sources under {@code src/}, {@code source/},
 * {@code WebContent/WEB-INF/src}, or the repository root. A build file supplies
 * a module's identity where one exists and nothing else; **no build file at all
 * is a normal case**, not an error.
 */
final class SourceDiscovery {

    /** Recognised because they name a module, not because we intend to run them. */
    private static final List<String> BUILD_FILES =
            List.of("pom.xml", "build.gradle", "build.gradle.kts", "build.xml");

    /**
     * XML that configures a framework rather than describing the build. We do
     * not parse these in M1 and must say so rather than under-report — a legacy
     * Spring MVC application can define most of its wiring in one of them.
     */
    private static final List<String> CONFIG_XML_SUFFIXES =
            List.of("web.xml", "applicationContext.xml", "-servlet.xml", ".hbm.xml", "orm.xml");

    private final Path repoRoot;
    private final Set<String> excludedDirectories;
    private final List<String> includePrefixes;

    SourceDiscovery(Path repoRoot, Set<String> excludedDirectories, List<String> includePrefixes) {
        this.repoRoot = repoRoot;
        this.excludedDirectories = excludedDirectories;
        this.includePrefixes = includePrefixes;
    }

    static final class Result {
        /** Every Java source found, sorted, so output is deterministic. */
        final List<Path> sources = new ArrayList<>();
        /** Module root directory → module identity. Sorted by path depth, deepest first. */
        final Map<Path, ModuleId> modules = new LinkedHashMap<>();
        /** Framework XML we deliberately did not parse. */
        final List<Path> unparsedConfig = new ArrayList<>();
    }

    static final class ModuleId {
        final String fqn;
        final String name;
        /** Facts from the build file (ADR-0040): root, buildFile, packaging, deployability. */
        final Map<String, Object> attrs;

        ModuleId(String fqn, String name, Map<String, Object> attrs) {
            this.fqn = fqn;
            this.name = name;
            this.attrs = attrs;
        }
    }

    Result discover() throws IOException {
        List<Path> buildFiles = new ArrayList<>();
        Result result = new Result();

        Files.walkFileTree(repoRoot, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (dir.equals(repoRoot)) {
                    return FileVisitResult.CONTINUE;
                }
                String name = dir.getFileName().toString();
                if (excludedDirectories.contains(name)) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String name = file.getFileName().toString();
                // `.kts` is deliberately absent: `build.gradle.kts` is matched
                // by BUILD_FILES below as a module's identity, and a build
                // script declares no domain type worth walking for.
                if ((name.endsWith(".java") || name.endsWith(".kt")) && included(file)) {
                    result.sources.add(file);
                } else if (BUILD_FILES.contains(name)) {
                    buildFiles.add(file);
                } else if (isFrameworkConfig(name)) {
                    result.unparsedConfig.add(file);
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) {
                // An unreadable file is not a reason to abandon the repository.
                return FileVisitResult.CONTINUE;
            }
        });

        result.sources.sort(Comparator.naturalOrder());
        result.unparsedConfig.sort(Comparator.naturalOrder());

        // Deepest first, so a nested module wins over the aggregator above it.
        Map<Path, ModuleId> byDepth = new TreeMap<>(
                Comparator.comparingInt(Path::getNameCount).reversed().thenComparing(Comparator.naturalOrder()));
        for (Path buildFile : buildFiles) {
            Path moduleRoot = buildFile.getParent();
            byDepth.computeIfAbsent(moduleRoot, root -> identify(buildFile, root));
        }
        // No build file anywhere: the repository is one module named for its directory.
        if (byDepth.isEmpty()) {
            String name = repoRoot.getFileName() == null ? "." : repoRoot.getFileName().toString();
            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("root", ".");
            byDepth.put(repoRoot, new ModuleId(name, name, attrs));
        }
        result.modules.putAll(byDepth);
        return result;
    }

    /** The module a source file belongs to: the nearest module root above it. */
    ModuleId moduleOf(Result discovery, Path source) {
        for (Map.Entry<Path, ModuleId> entry : discovery.modules.entrySet()) {
            if (source.startsWith(entry.getKey())) {
                return entry.getValue();
            }
        }
        // Sources above every build file still belong somewhere.
        return discovery.modules.values().iterator().next();
    }

    private boolean included(Path file) {
        if (includePrefixes.isEmpty()) {
            return true;
        }
        String relative = relative(file);
        return includePrefixes.stream().anyMatch(relative::startsWith);
    }

    String relative(Path file) {
        return repoRoot.relativize(file).toString().replace('\\', '/');
    }

    private static boolean isFrameworkConfig(String fileName) {
        return CONFIG_XML_SUFFIXES.stream().anyMatch(fileName::endsWith);
    }

    /**
     * Module identity, and what the build file proves about it (ADR-0040).
     *
     * A POM is read as plain XML for its coordinates. We deliberately do not use
     * OpenRewrite's {@code MavenParser}, which resolves parent POMs over the
     * network — extraction is offline (ADR-0006). A groupId inherited from a
     * parent is read from the {@code <parent>} block, which is where it sits in
     * the file we can actually see.
     */
    private ModuleId identify(Path buildFile, Path moduleRoot) {
        String directory = moduleRoot.getFileName() == null
                ? "."
                : moduleRoot.getFileName().toString();
        Map<String, Object> attrs = new LinkedHashMap<>();
        String root = relative(moduleRoot);
        attrs.put("root", root.isEmpty() ? "." : root);
        String buildPath = relative(buildFile);
        attrs.put("buildFile", buildPath);

        String fileName = buildFile.getFileName().toString();
        if (fileName.startsWith("build.gradle")) {
            try {
                putProof(attrs, buildPath, BuildFiles.readGradle(buildFile));
            } catch (Exception e) {
                // An unreadable script costs us the proof, not the module.
            }
            return new ModuleId(directory, directory, attrs);
        }
        if (!fileName.equals("pom.xml")) {
            return new ModuleId(directory, directory, attrs);
        }

        try {
            BuildFiles.Pom pom = BuildFiles.readPom(buildFile);
            if (pom.packaging != null) {
                attrs.put("packaging", pom.packaging);
            }
            if (!pom.modules.isEmpty()) {
                attrs.put("modules", pom.modules);
            }
            putProof(attrs, buildPath, pom.proof);
            String groupId = pom.groupId != null ? pom.groupId : pom.parentGroupId;
            if (pom.artifactId == null) {
                return new ModuleId(directory, directory, attrs);
            }
            return new ModuleId(groupId == null ? pom.artifactId : groupId + ":" + pom.artifactId,
                    pom.artifactId, attrs);
        } catch (Exception e) {
            // An unreadable POM costs us a module name, not the analysis.
            return new ModuleId(directory, directory, attrs);
        }
    }

    private static void putProof(Map<String, Object> attrs, String buildPath, BuildFiles.Proof proof) {
        if (proof == null) {
            return;
        }
        attrs.put("deployable", proof.kind());
        attrs.put("deployableFile", buildPath);
        attrs.put("deployableLine", proof.line());
        attrs.put("deployableRule", proof.rule());
    }
}
