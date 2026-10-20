**Target repo:** openrewrite/rewrite (`org.openrewrite.java.ChangeType`). The visible symptom is in rewrite-spring's `AuthorizeHttpRequests`; if maintainers prefer, it could go to openrewrite/rewrite-spring instead.
**Title:** `ChangeType` drops the outer class's type arguments when changing an inner type: `OldOuter<String>.Registry` becomes raw `Registry2`

Related but different: #8398 (`ChangeType` import handling for nested target types). This report is about the type arguments of a parameterized outer type being lost.

## What version of OpenRewrite are you using?

- rewrite-maven-plugin 6.46.1 (rewrite 8.89.0)
- rewrite-spring 6.37.1 (for the Spring case)
- Maven 3.9.12, JDK 17.0.13

These are the latest versions on Maven Central. I could not test newer releases from the Code Genome Project. Neither `ChangeType.java` on rewrite `main` nor rewrite-spring's `AuthorizeHttpRequests.java` at v6.41.0/main has a commit addressing this since those versions.

## How are you running OpenRewrite?

Maven plugin from the command line, single-module projects.

## Is your project public? If so, can you share a link to it?

Found while upgrading https://github.com/macrozheng/mall-tiny at `a81ec4740a0c7c99a06ebffb43a14168beadffc3` (`SecurityConfig.java`), as part of `UpgradeSpringBoot_3_5`. The minimal reproducers below are self-contained.

## What is the smallest, simplest way to reproduce the problem?

**Core case.** `rewrite.yml`:

```yaml
type: specs.openrewrite.org/v1beta/recipe
name: com.example.CT
recipeList:
  - org.openrewrite.java.ChangeType:
      oldFullyQualifiedTypeName: com.example.OldOuter.Registry
      newFullyQualifiedTypeName: com.example.NewOuter.Registry2
```

```java
public class OldOuter<T> { public class Registry { public T get() { return null; } } }
public class NewOuter<T> { public class Registry2 { public T get() { return null; } } }

class Use {
    String m(OldOuter<String>.Registry r) {
        return r.get().trim();
    }
}
```

`mvn org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run -Drewrite.activeRecipes=com.example.CT`

**Spring case**, where this hits real code. Spring Boot 2.7.18 with `spring-boot-starter-security`, running only `org.openrewrite.java.spring.security5.AuthorizeHttpRequests` (rewrite-spring 6.37.1). That recipe runs `ChangeType` from `ExpressionUrlAuthorizationConfigurer.ExpressionInterceptUrlRegistry` to `AuthorizeHttpRequestsConfigurer.AuthorizationManagerRequestMatcherRegistry`:

```java
ExpressionUrlAuthorizationConfigurer<HttpSecurity>.ExpressionInterceptUrlRegistry registry =
        http.authorizeRequests();
registry.antMatchers("/public/**").permitAll();
registry.anyRequest().authenticated();
```

## What did you expect to see?

The outer type's arguments are kept:

```java
String m(NewOuter<String>.Registry2 r) {
```

```java
AuthorizeHttpRequestsConfigurer<HttpSecurity>.AuthorizationManagerRequestMatcherRegistry registry =
        http.authorizeHttpRequests();
```

## What did you see instead?

The reference becomes a raw simple name with an import of the inner class:

```diff
+import com.example.NewOuter.Registry2;
+
 class Use {
-    String m(OldOuter<String>.Registry r) {
+    String m(Registry2 r) {
```

```diff
-import org.springframework.security.config.annotation.web.configurers.ExpressionUrlAuthorizationConfigurer;
+import org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.AuthorizationManagerRequestMatcherRegistry;
 ...
-        ExpressionUrlAuthorizationConfigurer<HttpSecurity>.ExpressionInterceptUrlRegistry registry =
-                http.authorizeRequests();
+        AuthorizationManagerRequestMatcherRegistry registry =
+                http.authorizeHttpRequests();
```

`Registry2` and `AuthorizationManagerRequestMatcherRegistry` are inner classes of generic classes. Used raw, every `T`/`C`-typed member erases to `Object`, so the code no longer compiles:

```
[ERROR] src/main/java/com/example/Use.java:[7,23] cannot find symbol
  symbol:   method trim()
  location: class java.lang.Object
```

```
[ERROR] src/main/java/com/example/SecurityConfig.java:[16,43] cannot find symbol
  symbol:   method permitAll()
  location: class java.lang.Object
[ERROR] src/main/java/com/example/SecurityConfig.java:[17,30] cannot find symbol
  symbol:   method authenticated()
  location: class java.lang.Object
```

(In the core case `ChangeType` also renames the inner class declared in `OldOuter.java`, since it is a source file in the same project. That is expected and unrelated.)

## What is the full stack trace of any errors you encountered?

No recipe error. The failures are the compile errors above.

## Are you interested in contributing a fix to OpenRewrite?

Not at the moment.

---
Found with an upgrade benchmark: https://github.com/imashishsharma/stratigraph/tree/main/bench/upgrade-gap
