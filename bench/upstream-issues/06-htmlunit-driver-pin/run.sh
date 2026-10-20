#!/usr/bin/env bash
# Copies the input (pom.xml + src) to a scratch git repo, runs the recipe with the
# latest OpenRewrite releases on Maven Central, writes the recipe diff and the test result.
# Usage: ./run.sh [recipe]   (default: UpgradeSpringBoot_3_4; UpgradeSpringBoot_3_5 / boot4.UpgradeSpringBoot_4_0 behave the same)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RECIPE=${1:-org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_4}
SUFFIX=${RECIPE##*.}
export JAVA_HOME=$HOME/.sdkman/candidates/java/17.0.13-amzn
W=$(mktemp -d); cp -r "$HERE/pom.xml" "$HERE/src" "$W/"; cd "$W"
mvn -B clean test > "$HERE/before-test.log" 2>&1; echo "before test exit: $?"
git init -q && git add pom.xml src && git -c user.email=r@r -c user.name=r commit -qm input
mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=$RECIPE > "$HERE/rewrite-$SUFFIX.log" 2>&1
git diff > "$HERE/after-$SUFFIX.diff"
mvn -B clean test > "$HERE/test-$SUFFIX.log" 2>&1; echo "after test exit: $?"
