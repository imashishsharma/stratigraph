#!/usr/bin/env bash
# Copies the input (pom.xml + src) to a scratch git repo, runs the recipe with the
# latest OpenRewrite releases, writes the recipe diff and the follow-up compile error.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RECIPE=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5
export JAVA_HOME=$HOME/.sdkman/candidates/java/17.0.13-amzn
W=$(mktemp -d); cp -r "$HERE/pom.xml" "$HERE/src" "$W/"; cd "$W"
git init -q && git add -A && git -c user.email=r@r -c user.name=r commit -qm input
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=$RECIPE > "$HERE/rewrite.log" 2>&1
git diff > "$HERE/after.diff"
mvn -B clean test > "$HERE/test.log" 2>&1; echo "test exit: $?"
