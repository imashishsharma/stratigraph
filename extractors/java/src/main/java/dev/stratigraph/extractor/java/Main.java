package dev.stratigraph.extractor.java;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Entry point for the Java extractor.
 *
 * A separate process that emits NDJSON facts on stdout and human-readable
 * progress on stderr (ADR-0001, ADR-0003). The core never links against this;
 * all it ever sees is the stream.
 */
public final class Main {

    static final String EXTRACTOR = "java";
    static final String VERSION = "1.0.1";

    /** Mirrors the core's default excludes, so both sides skip the same trees. */
    private static final List<String> DEFAULT_EXCLUDES =
            List.of("node_modules", "target", "build", "dist", ".git", ".idea", ".gradle");

    public static void main(String[] args) {
        try {
            System.exit(run(args, System.out, System.err));
        } catch (Exception e) {
            System.err.println("error: " + e);
            System.exit(1);
        }
    }

    static int run(String[] args, PrintStream stdout, PrintStream stderr) throws Exception {
        Path repo = null;
        Set<String> excludes = new LinkedHashSet<>(DEFAULT_EXCLUDES);
        List<String> includes = new ArrayList<>();

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--repo":
                    repo = Path.of(requireValue(args, ++i, "--repo"));
                    break;
                case "--exclude":
                    excludes.add(requireValue(args, ++i, "--exclude"));
                    break;
                case "--include":
                    includes.add(requireValue(args, ++i, "--include"));
                    break;
                case "--no-default-excludes":
                    excludes.removeAll(DEFAULT_EXCLUDES);
                    break;
                case "--version":
                    stderr.println(EXTRACTOR + " extractor " + VERSION);
                    return 0;
                case "--help":
                    usage(stderr);
                    return 0;
                default:
                    stderr.println("error: unknown argument " + args[i]);
                    usage(stderr);
                    return 2;
            }
        }

        if (repo == null) {
            stderr.println("error: --repo is required");
            usage(stderr);
            return 2;
        }
        repo = repo.toAbsolutePath().normalize();
        if (!Files.isDirectory(repo)) {
            stderr.println("error: not a directory: " + repo);
            return 2;
        }

        // Explicit UTF-8: the fact stream must not depend on the platform
        // encoding of whatever machine the extractor happens to run on.
        PrintStream facts = new PrintStream(stdout, true, StandardCharsets.UTF_8);

        FactEmitter emitter = new FactEmitter(facts);
        emitter.meta(EXTRACTOR, VERSION, repo.toString());

        SourceDiscovery discovery = new SourceDiscovery(repo, excludes, includes);
        SourceDiscovery.Result found = discovery.discover();
        stderr.println("discovered " + found.sources.size() + " java sources in "
                + found.modules.size() + " module(s)");

        new JavaFactExtractor(repo, emitter, discovery).run(found);
        facts.flush();
        stderr.println(emitter.summary());
        return 0;
    }

    private static String requireValue(String[] args, int index, String flag) {
        if (index >= args.length) {
            throw new IllegalArgumentException(flag + " requires a value");
        }
        return args[index];
    }

    private static void usage(PrintStream stderr) {
        stderr.println("usage: java -jar stratigraph-java-extractor.jar --repo <path> "
                + "[--include <prefix>]... [--exclude <dir>]... [--no-default-excludes]");
        stderr.println("emits NDJSON facts on stdout; progress and diagnostics on stderr");
    }

    private Main() {
    }
}
