**Target repo:** openrewrite/rewrite (`rewrite-maven`, `org.openrewrite.maven.UseMavenCompilerPluginReleaseConfiguration`)
**Title:** `UseMavenCompilerPluginReleaseConfiguration` replaces source/target with `<release>` while `compilerArgs` has `--add-exports` for a system module; javac then rejects the build

## What version of OpenRewrite are you using?

- rewrite-maven-plugin 6.46.1 (rewrite 8.89.0)
- rewrite-migrate-java 3.42.1 (also reproduced through rewrite-spring 6.37.1 `UpgradeSpringBoot_3_5`)
- Maven 3.9.12, JDK 17.0.13

These are the latest versions on Maven Central. I could not test newer releases from the Code Genome Project. `UseMavenCompilerPluginReleaseConfiguration.java` has not changed since 2026-04-14 (before 8.89.0), and on `main` it does not look at `compilerArgs`: https://github.com/openrewrite/rewrite/blob/main/rewrite-maven/src/main/java/org/openrewrite/maven/UseMavenCompilerPluginReleaseConfiguration.java

## How are you running OpenRewrite?

Maven plugin from the command line, single-module project, no pom changes:

```
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:3.42.1 \
  -Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava17
```

## Is your project public? If so, can you share a link to it?

Found while upgrading https://github.com/obsidiandynamics/kafdrop at `4fe1e6490e0ec74c725bcc73a5c790ac882e3a93` with `UpgradeSpringBoot_3_5`. The minimal reproducer is a single pom and one class.

## What is the smallest, simplest way to reproduce the problem?

```xml
<properties>
    <java.version>11</java.version>
</properties>
<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-compiler-plugin</artifactId>
            <version>3.11.0</version>
            <configuration>
                <source>11</source>
                <target>11</target>
                <compilerArgs>
                    <arg>--add-exports=jdk.management.agent/jdk.internal.agent=ALL-UNNAMED</arg>
                </compilerArgs>
            </configuration>
        </plugin>
    </plugins>
</build>
```

plus any class in `src/main/java`. `mvn clean compile` passes before the recipe runs.

## What did you expect to see?

`javac` does not allow `--release` together with `--add-exports` for a system module. When `compilerArgs` contains `--add-exports`, I'd expect the recipe to keep `<source>`/`<target>` and only bump their values (to 17), instead of switching to `<release>`.

## What did you see instead?

```diff
-                <version>3.11.0</version>
+                <version>3.16.0</version>
                 <configuration>
-                    <source>11</source>
-                    <target>11</target>
                     <compilerArgs>
                         <arg>--add-exports=jdk.management.agent/jdk.internal.agent=ALL-UNNAMED</arg>
                     </compilerArgs>
+                    <release>${java.version}</release>
                 </configuration>
```

The change log names `UpgradeBuildToJava11` -> `UpgradeJavaVersion` -> `org.openrewrite.maven.UseMavenCompilerPluginReleaseConfiguration`. `mvn clean compile` then fails:

```
[ERROR] COMPILATION ERROR :
[ERROR] exporting a package from system module jdk.management.agent is not allowed with --release
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.16.0:compile (default-compile) on project repro: Compilation failure
```

## What is the full stack trace of any errors you encountered?

No recipe error. The failure is the javac error above.

## Are you interested in contributing a fix to OpenRewrite?

Not at the moment.

---
Found with an upgrade benchmark: https://github.com/imashishsharma/stratigraph/tree/main/bench/upgrade-gap
