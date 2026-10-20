#!/usr/bin/env bash
# Maven project that also carries a Gradle wrapper (like spring-projects/spring-petclinic).
# Runs only UpdateGradleWrapper (the step of UpgradeSpringBoot_4_0 that failed) via rewrite.yml.
# To force a fresh download, move ~/.rewrite/remote/* aside first (cached archives are reused).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export JAVA_HOME=$HOME/.sdkman/candidates/java/17.0.13-amzn
W=$(mktemp -d); cp -r "$HERE/pom.xml" "$HERE/rewrite.yml" "$HERE/gradlew" "$HERE/gradlew.bat" "$HERE/gradle" "$HERE/src" "$W/"; cd "$W"
git init -q && git add -A && git -c user.email=r@r -c user.name=r commit -qm input
mvn -B -e org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.activeRecipes=com.example.Wrapper > "$HERE/rewrite.log" 2>&1; echo "rewrite exit: $?"
git diff --stat
