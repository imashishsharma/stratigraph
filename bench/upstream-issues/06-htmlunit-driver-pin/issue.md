**Target repo:** openrewrite/rewrite-spring
**Title:** `UpgradeSpringBoot_3_4` keeps `htmlunit-driver` (HtmlUnit 2) and pins it to 4.13.0; MockMvc HtmlUnit tests then fail with `NoClassDefFoundError: org/htmlunit/WebConnection`

Related: #627 (closed) listed "Include the HtmlUnit migrations with the Spring Framework 6.2 upgrade" as an open checkbox. As far as I can tell that was never done: `htmlunit` appears in rewrite-spring `main` only in `spring-boot-40-properties.yml`.

## What version of OpenRewrite are you using?

- rewrite-maven-plugin 6.46.1 (rewrite 8.89.0)
- rewrite-spring 6.37.1
- Maven 3.9.12, JDK 17.0.13

These are the latest versions on Maven Central. I could not test rewrite-spring 6.41.0 from the Code Genome Project. Neither `v6.41.0` nor `main` (1907e11, 2026-10-20) has any recipe that touches `org.seleniumhq.selenium:htmlunit-driver` or `net.sourceforge.htmlunit` (`git grep -i htmlunit` matches only two property keys in `spring-boot-40-properties.yml`).

## How are you running OpenRewrite?

Maven plugin from the command line, single-module project, no pom changes:

```
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_4
```

`UpgradeSpringBoot_3_5` and `boot4.UpgradeSpringBoot_4_0` give the same pin and the same failure.

## Is your project public? If so, can you share a link to it?

Found while upgrading https://github.com/citerus/dddsample-core at `d8b896254ed4e18ba8117dcd5bf9a54708bdeaaf` (Boot 3.3.10, `htmlunit-driver` without a version, `MockMvcHtmlUnitDriverBuilder` in `AbstractAcceptanceTest`). The minimal reproducer is below.

## What is the smallest, simplest way to reproduce the problem?

Spring Boot 3.3.10 parent, `spring-boot-starter-web`, `spring-boot-starter-test`, and

```xml
<dependency>
    <groupId>org.seleniumhq.selenium</groupId>
    <artifactId>htmlunit-driver</artifactId>
    <scope>test</scope>
</dependency>
```

with one controller returning `<html><head><title>hello</title></head>...` and this test:

```java
@SpringBootTest
class AppTest {
    @Autowired WebApplicationContext context;

    @Test
    void pageTitle() {
        WebDriver driver = MockMvcHtmlUnitDriverBuilder.webAppContextSetup(context).build();
        driver.get("http://localhost/");
        assertEquals("hello", driver.getTitle());
    }
}
```

`mvn test` passes on Boot 3.3.10 (Boot manages `htmlunit-driver` 4.13.0 -> `net.sourceforge.htmlunit:htmlunit` 2.70.0).

## What did you expect to see?

Boot 3.4 replaced HtmlUnit 2 with HtmlUnit 3+ (`org.htmlunit`) and manages `org.seleniumhq.selenium:htmlunit3-driver` instead of `htmlunit-driver`. I'd expect the upgrade to change the dependency to `htmlunit3-driver` (version managed by Boot). With that one change by hand the test passes on 3.4.13.

The steps already exist in `org.openrewrite.java.testing.htmlunit.UpgradeHtmlUnit_3` (currently in rewrite-jenkins: `ChangeDependency` `htmlunit-driver` -> `htmlunit3-driver`, `net.sourceforge.htmlunit` -> `org.htmlunit`, and `ChangePackage` `com.gargoylesoftware.htmlunit` -> `org.htmlunit`). The Boot 3.4 / Spring Framework 6.2 recipes don't include them.

## What did you see instead?

`htmlunit-driver` is no longer managed by the new parent, so `UpgradeParentVersion` keeps the build resolvable by pinning the old managed version:

```diff
-        <version>3.3.10</version>
+        <version>3.4.13</version>
 ...
+    <dependencyManagement>
+        <dependencies>
+            <dependency>
+                <groupId>org.seleniumhq.selenium</groupId>
+                <artifactId>htmlunit-driver</artifactId>
+                <version>4.13.0</version>
+            </dependency>
+        </dependencies>
+    </dependencyManagement>
```

(Pinning a dropped managed version is reasonable in general; the problem is that nothing migrates this artifact first.) The project still compiles, but Spring Framework 6.2's `MockMvcHtmlUnitDriverBuilder` needs HtmlUnit 3+ on the classpath:

```
[ERROR] com.example.AppTest.pageTitle -- Time elapsed: 0.404 s <<< ERROR!
java.lang.NoClassDefFoundError: org/htmlunit/WebConnection
	at com.example.AppTest.pageTitle(AppTest.java:20)
Caused by: java.lang.ClassNotFoundException: org.htmlunit.WebConnection
	at java.base/jdk.internal.loader.BuiltinClassLoader.loadClass(BuiltinClassLoader.java:641)
	at java.base/jdk.internal.loader.ClassLoaders$AppClassLoader.loadClass(ClassLoaders.java:188)
	at java.base/java.lang.ClassLoader.loadClass(ClassLoader.java:525)
```

## What is the full stack trace of any errors you encountered?

No recipe error. The failure is the test error above.

## Are you interested in contributing a fix to OpenRewrite?

Not at the moment.

---
Found with an upgrade benchmark: https://github.com/imashishsharma/stratigraph/tree/main/bench/upgrade-gap
