**Target repo:** openrewrite/rewrite-spring
**Title:** `ReplaceGlobalMethodSecurityWithMethodSecurity` swaps the annotation on a `GlobalMethodSecurityConfiguration` subclass, and the context fails to start: "EnableGlobalMethodSecurity is required"

## What version of OpenRewrite are you using?

- rewrite-maven-plugin 6.46.1
- rewrite-spring 6.37.1
- Maven 3.9.12, JDK 17.0.13

These are the latest versions on Maven Central. I could not test rewrite-spring 6.41.0 from the Code Genome Project. `ReplaceGlobalMethodSecurityWithMethodSecurity.java` has not changed since 2026-04-29, before 6.37.1, so v6.41.0 and `main` have the same annotation-only visitor: https://github.com/openrewrite/rewrite-spring/blob/main/src/main/java/org/openrewrite/java/spring/security5/ReplaceGlobalMethodSecurityWithMethodSecurity.java

## How are you running OpenRewrite?

Maven plugin from the command line, single-module project, no pom changes:

```
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5
```

## Is your project public? If so, can you share a link to it?

Found while upgrading https://github.com/gtiwari333/spring-boot-blog-app at commit `095e50d8dcb9e01dae519dd9f7b5d394d39811c6` (`src/main/java/gt/app/config/security/MethodSecurityConfig.java`). The minimal reproducer is a Spring Boot 2.7.18 project with `spring-boot-starter-security`, the class below, and an empty `@SpringBootTest`.

## What is the smallest, simplest way to reproduce the problem?

```java
package com.example;

import org.springframework.context.annotation.Configuration;
import org.springframework.security.access.expression.method.DefaultMethodSecurityExpressionHandler;
import org.springframework.security.access.expression.method.MethodSecurityExpressionHandler;
import org.springframework.security.config.annotation.method.configuration.EnableGlobalMethodSecurity;
import org.springframework.security.config.annotation.method.configuration.GlobalMethodSecurityConfiguration;

@Configuration
@EnableGlobalMethodSecurity(prePostEnabled = true)
public class MethodSecurityConfig extends GlobalMethodSecurityConfiguration {

    @Override
    protected MethodSecurityExpressionHandler createExpressionHandler() {
        return new DefaultMethodSecurityExpressionHandler();
    }
}
```

Before the recipe, `mvn test` passes on Boot 2.7.18 (`contextLoads`).

## What did you expect to see?

One of two things:

- Leave `@EnableGlobalMethodSecurity` in place when the annotated class extends `GlobalMethodSecurityConfiguration`. Both are deprecated but still present in Spring Security 6.5, so the app keeps working.
- Or do the full migration: remove `extends GlobalMethodSecurityConfiguration` and turn the `createExpressionHandler()` override into a `@Bean MethodSecurityExpressionHandler`, as the Spring Security 5.8 migration guide describes.

## What did you see instead?

The recipe (`UpgradeSpringSecurity_5_8` -> `ReplaceGlobalMethodSecurityWithMethodSecurity`) changes only the annotation and leaves the superclass in place:

```diff
-import org.springframework.security.config.annotation.method.configuration.EnableGlobalMethodSecurity;
+import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
 import org.springframework.security.config.annotation.method.configuration.GlobalMethodSecurityConfiguration;

 @Configuration
-@EnableGlobalMethodSecurity(prePostEnabled = true)
+@EnableMethodSecurity
 public class MethodSecurityConfig extends GlobalMethodSecurityConfiguration {
```

The code compiles. On Boot 3.5.16 / Spring Security 6.5.11 the application context no longer starts, because `GlobalMethodSecurityConfiguration` reads its settings from `@EnableGlobalMethodSecurity`:

```
java.lang.IllegalStateException: Failed to load ApplicationContext ...
Caused by: org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'methodSecurityMetadataSource' defined in class path resource [com/example/MethodSecurityConfig.class]: ... Factory method 'methodSecurityMetadataSource' threw exception with message: org.springframework.security.config.annotation.method.configuration.EnableGlobalMethodSecurity is required
Caused by: java.lang.IllegalArgumentException: org.springframework.security.config.annotation.method.configuration.EnableGlobalMethodSecurity is required
	at org.springframework.security.config.annotation.method.configuration.GlobalMethodSecurityConfiguration.enableMethodSecurity(GlobalMethodSecurityConfiguration.java:465)
	at org.springframework.security.config.annotation.method.configuration.GlobalMethodSecurityConfiguration.prePostEnabled(GlobalMethodSecurityConfiguration.java:445)
	at org.springframework.security.config.annotation.method.configuration.GlobalMethodSecurityConfiguration.methodSecurityMetadataSource(GlobalMethodSecurityConfiguration.java:358)
```

The recipe's visitor only matches the annotation. It never checks the enclosing class's supertype.

## What is the full stack trace of any errors you encountered?

See above. The full log is available if useful. There is no recipe error; the failure happens at application startup.

## Are you interested in contributing a fix to OpenRewrite?

Not at the moment.

---
Found with an upgrade benchmark: https://github.com/imashishsharma/stratigraph/tree/main/bench/upgrade-gap
