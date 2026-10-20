#!/usr/bin/env bash
# 1) Spring case: rewrite-spring's AuthorizeHttpRequests on a Boot 2.7.18 project (pom.xml + src).
# 2) Core case: plain org.openrewrite.java.ChangeType from core/rewrite.yml on two tiny generic classes.
# Each runs in a scratch git repo; writes after*.diff and compile*.log next to this script.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export JAVA_HOME=$HOME/.sdkman/candidates/java/17.0.13-amzn
run() { # $1=input dir, $2=suffix, rest=mvn args
  local in=$1 sfx=$2; shift 2
  W=$(mktemp -d); cp -r "$in"/* "$W/"; cd "$W"
  git init -q && git add -A && git -c user.email=r@r -c user.name=r commit -qm input
  mvn -B org.openrewrite.maven:rewrite-maven-plugin:6.46.1:run "$@" > "$HERE/rewrite$sfx.log" 2>&1
  git diff > "$HERE/after$sfx.diff"
  mvn -B clean compile > "$HERE/compile$sfx.log" 2>&1; echo "compile$sfx exit: $?"
}
mkdir -p "$HERE/.in" && rm -rf "$HERE/.in"/* && cp -r "$HERE/pom.xml" "$HERE/src" "$HERE/.in/"
run "$HERE/.in" "" \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:6.37.1 \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.security5.AuthorizeHttpRequests
rm -rf "$HERE/.in"
run "$HERE/core" "-core" -Drewrite.activeRecipes=com.example.CT
