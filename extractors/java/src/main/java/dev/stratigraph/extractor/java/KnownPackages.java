package dev.stratigraph.extractor.java;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Complete top-level type listings of common framework packages (ADR-0038),
 * generated from the published jars by {@code scripts/gen-known-packages.sh}.
 *
 * Unlike {@link FrameworkAnnotations}, which lists what a package is known to
 * declare, a listing here is the package's whole content: a name absent from
 * it is a name that package does not declare, which is what lets a wildcard
 * import of that package be ruled out as a competing source.
 */
final class KnownPackages {

    private static final Map<String, Set<String>> LISTINGS = load();

    private KnownPackages() {
    }

    static boolean isListed(String pkg) {
        return LISTINGS.containsKey(pkg);
    }

    static boolean declares(String pkg, String simpleName) {
        Set<String> names = LISTINGS.get(pkg);
        return names != null && names.contains(simpleName);
    }

    private static Map<String, Set<String>> load() {
        Map<String, Set<String>> listings = new HashMap<>();
        try (InputStream in = KnownPackages.class.getResourceAsStream("known-packages.txt")) {
            if (in == null) {
                return listings;
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            for (String line = reader.readLine(); line != null; line = reader.readLine()) {
                if (line.isBlank() || line.startsWith("#")) {
                    continue;
                }
                String[] parts = line.trim().split("\\s+");
                Set<String> names = new HashSet<>();
                for (int i = 1; i < parts.length; i++) {
                    names.add(parts[i]);
                }
                listings.put(parts[0], names);
            }
        } catch (IOException e) {
            throw new IllegalStateException("known-packages.txt is unreadable", e);
        }
        return listings;
    }
}
