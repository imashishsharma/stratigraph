**Target repo:** openrewrite/rewrite-hibernate
**Title:** `TypeAnnotationParameter` turns `@Type(type = "uuid-char")` into uncompilable `@Type(uuid-char.class)`

Related but not the same: #31 (fully-qualified `org.hibernate.type.UUIDCharType` that no longer exists). This report is about short type *names* from Hibernate 5's basic type registry (`uuid-char`; I also checked `uuid-binary` and `text`, which give `@Type(uuid-binary.class)` and `@Type(text.class)`), which are not class names at all. `yes_no`/`true_false` are fine: `MigrateBooleanMappings` turns them into `@Convert`.

## What version of OpenRewrite are you using?

- rewrite-maven-plugin 6.46.1
- rewrite-spring 6.37.1 (pulls in rewrite-hibernate 2.25.0)
- Maven 3.9.12, JDK 17.0.13

These are the latest versions on Maven Central. I could not test rewrite-hibernate 2.27.0 / rewrite-spring 6.41.0 from the Code Genome Project. `TypeAnnotationParameter.java` has not changed since 2026-02-14 (first in v2.18.0), so v2.27.0 and `main` as of 2026-10-20 still have the code path below: https://github.com/openrewrite/rewrite-hibernate/blob/main/src/main/java/org/openrewrite/hibernate/TypeAnnotationParameter.java

## How are you running OpenRewrite?

Maven plugin from the command line, single-module project, no pom changes:

```
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5
```

## Is your project public? If so, can you share a link to it?

Found while upgrading https://github.com/gtiwari333/spring-boot-blog-app at commit `095e50d8dcb9e01dae519dd9f7b5d394d39811c6` (`src/main/java/gt/app/domain/ReceivedFile.java:20`). The minimal reproducer below is a Spring Boot 2.7.18 project with `spring-boot-starter-data-jpa` and one entity.

## What is the smallest, simplest way to reproduce the problem?

```java
package com.example;

import org.hibernate.annotations.Type;

import javax.persistence.Entity;
import javax.persistence.Id;
import java.util.UUID;

@Entity
public class ReceivedFile {

    @Id
    @Type(type = "uuid-char")
    UUID id;
}
```

## What did you expect to see?

Valid Java. For `uuid-char` the Hibernate 6 equivalent is `@JdbcTypeCode(SqlTypes.CHAR)` (keeps the `char(36)` column). If the recipe cannot map a registry name, I'd expect it to leave the annotation unchanged, perhaps with a TODO comment, rather than emitting code that won't parse as a class reference.

## What did you see instead?

```diff
     @Id
-    @Type(type = "uuid-char")
+    @Type(uuid-char.class)
     UUID id;
```

`uuid-char.class` parses as the expression `uuid - char.class`, so compilation fails:

```
[ERROR] src/main/java/com/example/ReceivedFile.java:[13,11] cannot find symbol
[ERROR]   symbol:   variable uuid
[ERROR]   location: class com.example.ReceivedFile
```

The change log names `org.openrewrite.hibernate.TypeAnnotationParameter` (via `MigrateToHibernate61` -> `MigrateToHibernate60`). In `replaceArgumentWithClass`, any string literal that isn't a `@TypeDef` alias is passed to `buildClassReference(fqTypeName, ...)` as if it were a class name. Hibernate 5 basic-type registry keys such as `uuid-char`, `uuid-binary` and `text` are not class names.

## What is the full stack trace of any errors you encountered?

No recipe error. The failure is the compile error above.

## Are you interested in contributing a fix to OpenRewrite?

Not at the moment.

---
Found with an upgrade benchmark: https://github.com/imashishsharma/stratigraph/tree/main/bench/upgrade-gap
