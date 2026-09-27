package dev.stratigraph.extractor.java;

import dev.stratigraph.extractor.java.FactEmitter.NodeRef;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The persistence model of the whole build, resolved once every file has been
 * read (ADR-0036).
 *
 * Which table an entity lives in is not a fact of its own file. A subclass in
 * single-table inheritance lives in its root's table; a default-named entity's
 * table is its entity name put through the physical naming strategy, which
 * Spring Boot sets and a module's configuration can override. So the visitor
 * records what each file says, and this class decides the tables at the end,
 * citing the rule it applied on every edge it writes.
 */
final class Persistence {

    /** What one {@code @Entity} class declares about itself. */
    static final class EntityInfo {
        final String fqn;
        final String simpleName;
        final String path;
        final Integer line;
        final Path moduleDir;
        /** {@code @Entity(name = ...)}, or null. */
        String entityName;
        /** {@code @Table(name = ...)}, or null. */
        String tableName;
        Integer tableLine;
        String schema;
        /** {@code @Inheritance(strategy = ...)} on this class, or null. */
        String inheritance;
        /** Resolved direct superclass, or null. */
        String superclass;

        EntityInfo(String fqn, String simpleName, String path, Integer line, Path moduleDir) {
            this.fqn = fqn;
            this.simpleName = simpleName;
            this.path = path;
            this.line = line;
            this.moduleDir = moduleDir;
        }
    }

    /** A Spring Data repository interface and the entity its type argument names. */
    record RepositoryInfo(String fqn, String entityFqn, String path, Integer line) {}

    /** A query string, from {@code @Query} or a JDBC call, and where it was written. */
    record QueryInfo(String methodFqn, String sql, boolean nativeSql, String source, String path, Integer line) {}

    private final Map<String, EntityInfo> entities = new LinkedHashMap<>();
    private final List<RepositoryInfo> repositories = new ArrayList<>();
    private final List<QueryInfo> queries = new ArrayList<>();
    private final Map<Path, Naming> namingByModule = new LinkedHashMap<>();

    void entity(EntityInfo info) {
        entities.putIfAbsent(info.fqn, info);
    }

    void repository(RepositoryInfo info) {
        repositories.add(info);
    }

    void query(QueryInfo info) {
        queries.add(info);
    }

    // ------------------------------------------------------------- naming

    /**
     * The physical naming strategy a module's entities are named by, and the
     * file that says so.
     *
     * Spring Boot's default is {@code CamelCaseToUnderscoresNamingStrategy}
     * (lower snake case); plain Hibernate/JPA uses the logical name as written.
     * A module is a Spring Boot module when its build file names Spring Boot.
     * {@code spring.jpa.hibernate.naming.physical-strategy} in its application
     * configuration overrides either; a strategy class we do not know is
     * recorded as unknown, and default-named entities under it get no table.
     */
    record Naming(String strategy, String source) {
        static final String SNAKE = "spring-boot-snake-case";
        static final String AS_WRITTEN = "as-written";
        static final String UNKNOWN = "unknown";
    }

    private static final Pattern PHYSICAL_STRATEGY = Pattern.compile(
            "(?:physical[-_]strategy|physical_naming_strategy|physical-naming-strategy)\\s*[:=]\\s*['\"]?([\\w.$]+)");

    Naming naming(Path moduleDir, Path repoRoot) {
        return namingByModule.computeIfAbsent(moduleDir, dir -> detectNaming(dir, repoRoot));
    }

    private static Naming detectNaming(Path moduleDir, Path repoRoot) {
        Path resources = moduleDir.resolve("src/main/resources");
        if (Files.isDirectory(resources)) {
            try (var files = Files.list(resources)) {
                for (Path config : files.sorted().toList()) {
                    String name = config.getFileName().toString();
                    if (!name.matches("application[-\\w]*\\.(properties|ya?ml)")) {
                        continue;
                    }
                    List<String> lines = Files.readAllLines(config, StandardCharsets.UTF_8);
                    for (int i = 0; i < lines.size(); i++) {
                        Matcher m = PHYSICAL_STRATEGY.matcher(lines.get(i));
                        if (m.find()) {
                            String cls = m.group(1);
                            String where = relative(repoRoot, config) + ":" + (i + 1);
                            if (cls.endsWith("PhysicalNamingStrategyStandardImpl")) {
                                return new Naming(Naming.AS_WRITTEN, where);
                            }
                            if (cls.endsWith("CamelCaseToUnderscoresNamingStrategy")
                                    || cls.endsWith("SpringPhysicalNamingStrategy")) {
                                return new Naming(Naming.SNAKE, where);
                            }
                            return new Naming(Naming.UNKNOWN, where + " (" + cls + ")");
                        }
                    }
                }
            } catch (IOException ignored) {
                // Unreadable configuration states nothing; fall through to the build.
            }
        }
        for (Path dir = moduleDir; dir != null && dir.startsWith(repoRoot); dir = dir.getParent()) {
            for (String build : List.of("pom.xml", "build.gradle", "build.gradle.kts")) {
                Path file = dir.resolve(build);
                if (!Files.isRegularFile(file)) {
                    continue;
                }
                try {
                    List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
                    for (int i = 0; i < lines.size(); i++) {
                        String text = lines.get(i);
                        if (text.contains("spring-boot") || text.contains("org.springframework.boot")) {
                            return new Naming(Naming.SNAKE, relative(repoRoot, file) + ":" + (i + 1));
                        }
                    }
                } catch (IOException ignored) {
                    // As above.
                }
            }
        }
        return new Naming(Naming.AS_WRITTEN, "no Spring Boot build and no naming override");
    }

    /** Hibernate 6's {@code CamelCaseToUnderscoresNamingStrategy}, character for character. */
    static String snakeCase(String name) {
        StringBuilder builder = new StringBuilder(name.replace('.', '_'));
        for (int i = 1; i < builder.length() - 1; i++) {
            if (underscoreRequired(builder.charAt(i - 1), builder.charAt(i), builder.charAt(i + 1))) {
                builder.insert(i++, '_');
            }
        }
        return builder.toString().toLowerCase(Locale.ROOT);
    }

    private static boolean underscoreRequired(char before, char current, char after) {
        return (Character.isLowerCase(before) || Character.isDigit(before))
                && Character.isUpperCase(current)
                && (Character.isLowerCase(after) || Character.isDigit(after));
    }

    /** A quoted identifier is used exactly; anything else goes through the strategy. */
    static String physical(String logical, String strategy) {
        if (logical.length() > 1 && (logical.startsWith("`") || logical.startsWith("\""))) {
            return logical.substring(1, logical.length() - 1);
        }
        return Naming.SNAKE.equals(strategy) ? snakeCase(logical) : logical;
    }

    // -------------------------------------------------------------- tables

    /** Entity fqn → the table it was resolved to, after {@link #finish}. */
    private final Map<String, String> tableOf = new LinkedHashMap<>();
    /** Entity name (for JPQL) → entity fqn. */
    private final Map<String, String> byEntityName = new LinkedHashMap<>();

    /**
     * Resolve every entity's table and write the mapping and table-access facts.
     */
    void finish(FactEmitter emitter, Path repoRoot) {
        for (EntityInfo entity : entities.values()) {
            byEntityName.putIfAbsent(entity.entityName != null ? entity.entityName : entity.simpleName, entity.fqn);
        }

        for (EntityInfo entity : entities.values()) {
            Naming naming = naming(entity.moduleDir, repoRoot);
            EntityInfo root = rootOf(entity);
            String strategy = inheritanceOf(root);
            boolean sharesRoot = root != entity && "SINGLE_TABLE".equals(strategy);
            EntityInfo owner = sharesRoot ? root : entity;

            Map<String, Object> attrs = new LinkedHashMap<>();
            String logical;
            if (owner.tableName != null && !owner.tableName.isBlank()) {
                logical = owner.tableName;
                attrs.put("naming", "explicit");
            } else {
                logical = owner.entityName != null ? owner.entityName : owner.simpleName;
                attrs.put("naming", owner.entityName != null ? "entity-name" : "class-name");
                if (Naming.UNKNOWN.equals(naming.strategy)) {
                    emitter.diagnostic("info",
                            entity.fqn + " has no explicit @Table name and its module sets a physical "
                                    + "naming strategy stratigraph does not know (" + naming.source
                                    + "), so its table was not recorded",
                            entity.path, entity.line);
                    continue;
                }
            }
            String physical = physical(logical, naming.strategy);
            String table = owner.schema == null || owner.schema.isBlank()
                    ? physical
                    : physical(owner.schema, naming.strategy) + "." + physical;
            attrs.put("strategy", naming.strategy);
            attrs.put("strategySource", naming.source);
            if (root != entity || entities.values().stream().anyMatch(e -> e != entity && rootOf(e) == entity)) {
                attrs.put("inheritance", strategy);
                if (sharesRoot) {
                    attrs.put("root", root.fqn);
                }
            }

            tableOf.put(entity.fqn, table);
            emitter.node("table", Fqn.table(table), table, null, null, null, null, null);
            emitter.edge("maps_to", new NodeRef("class", entity.fqn), new NodeRef("table", Fqn.table(table)),
                    entity.path, owner == entity && entity.tableLine != null ? entity.tableLine : entity.line,
                    attrs);
        }

        for (RepositoryInfo repository : repositories) {
            String table = tableOf.get(repository.entityFqn);
            if (table == null) {
                continue;
            }
            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("via", "spring-data");
            attrs.put("entity", repository.entityFqn);
            emitter.edge("reads_table", new NodeRef("interface", repository.fqn),
                    new NodeRef("table", Fqn.table(table)), repository.path, repository.line, attrs);
            emitter.edge("writes_table", new NodeRef("interface", repository.fqn),
                    new NodeRef("table", Fqn.table(table)), repository.path, repository.line, attrs);
        }

        for (QueryInfo query : queries) {
            Set<String> read = new LinkedHashSet<>();
            Set<String> written = new LinkedHashSet<>();
            if (query.nativeSql) {
                Sql.tables(query.sql, false, read, written);
            } else {
                Set<String> readEntities = new LinkedHashSet<>();
                Set<String> writtenEntities = new LinkedHashSet<>();
                Sql.tables(query.sql, true, readEntities, writtenEntities);
                for (String name : readEntities) {
                    String table = tableOf.get(byEntityName.get(name));
                    if (table != null) read.add(table);
                }
                for (String name : writtenEntities) {
                    String table = tableOf.get(byEntityName.get(name));
                    if (table != null) written.add(table);
                }
            }
            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("via", query.source);
            for (String table : read) {
                emitter.node("table", Fqn.table(table), table, null, null, null, null, null);
                emitter.edge("reads_table", new NodeRef("method", query.methodFqn),
                        new NodeRef("table", Fqn.table(table)), query.path, query.line, attrs);
            }
            for (String table : written) {
                emitter.node("table", Fqn.table(table), table, null, null, null, null, null);
                emitter.edge("writes_table", new NodeRef("method", query.methodFqn),
                        new NodeRef("table", Fqn.table(table)), query.path, query.line, attrs);
            }
        }
    }

    /** The topmost entity in this entity's superclass chain; itself when it has no entity superclass. */
    private EntityInfo rootOf(EntityInfo entity) {
        EntityInfo current = entity;
        Set<String> seen = new LinkedHashSet<>();
        while (seen.add(current.fqn)) {
            String parent = superEntity(current);
            if (parent == null) {
                return current;
            }
            current = entities.get(parent);
        }
        return current;
    }

    /** The nearest entity among a class's superclasses, skipping non-entities such as mapped superclasses. */
    private String superEntity(EntityInfo entity) {
        return entity.superclass != null && entities.containsKey(entity.superclass) ? entity.superclass : null;
    }

    /** JPA's default is SINGLE_TABLE, stated on the root or nowhere. */
    private static String inheritanceOf(EntityInfo root) {
        return root.inheritance == null ? "SINGLE_TABLE" : root.inheritance;
    }

    private static String relative(Path repoRoot, Path file) {
        return repoRoot.relativize(file).toString().replace('\\', '/');
    }

    /**
     * Table names out of a SQL or JPQL string: after {@code FROM}, {@code JOIN},
     * {@code INTO}, {@code UPDATE} and {@code DELETE FROM}.
     *
     * Deliberately small. A name followed by a dot-path ({@code join o.pets}) is
     * an association navigation, not a table, and is skipped; so is anything in
     * parentheses. Missing a table is a stated limit; inventing one is not.
     */
    static final class Sql {
        private static final Pattern TABLE = Pattern.compile(
                "\\b(from|join|into|update)\\s+([A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)?)",
                Pattern.CASE_INSENSITIVE);
        private static final Pattern VERB = Pattern.compile(
                "^\\s*(select|insert|update|delete|merge|with)\\b", Pattern.CASE_INSENSITIVE);
        private static final Set<String> KEYWORDS = Set.of(
                "select", "where", "set", "values", "on", "as", "lateral", "unnest", "dual", "fetch");

        static boolean looksLikeSql(String text) {
            return VERB.matcher(text).find();
        }

        /**
         * @param jpql true for JPQL, where names are entity names and a dotted
         *             name after {@code JOIN} navigates an association.
         */
        static void tables(String sql, boolean jpql, Set<String> read, Set<String> written) {
            Matcher verb = VERB.matcher(sql);
            String statement = verb.find() ? verb.group(1).toLowerCase(Locale.ROOT) : "select";
            Matcher m = TABLE.matcher(sql);
            while (m.find()) {
                String keyword = m.group(1).toLowerCase(Locale.ROOT);
                String name = m.group(2);
                int end = m.end(2);
                // `join o.pets` — an association navigated from an alias.
                if (jpql && name.contains(".")) {
                    continue;
                }
                // `from unnest(...)`, `join lateral (...)`: a function, not a table.
                if (!keyword.equals("into") && sql.substring(end).trim().startsWith("(")) {
                    continue;
                }
                if (KEYWORDS.contains(name.toLowerCase(Locale.ROOT))) {
                    continue;
                }
                if (end < sql.length() && sql.charAt(end) == '.') {
                    continue;
                }
                boolean write = keyword.equals("into") || keyword.equals("update")
                        || (keyword.equals("from") && statement.equals("delete")
                            && sql.substring(0, m.start()).trim().toLowerCase(Locale.ROOT).endsWith("delete"));
                (write ? written : read).add(name);
            }
        }

    }
}
