#!/usr/bin/env bash
# Reproduce one OpenRewrite-only upgrade run for the Upgrade Agent gap map.
#
# usage: run.sh NAME URL SHA BASE_JDK TARGET_JDK RECIPE [PHASES]
#   NAME        short name; work dir is $GAPMAP/NAME, raw logs in $GAPMAP/_logs/NAME
#   URL         git URL (a local mirror in $GAPMAP/_src/NAME is used if present)
#   SHA         full commit SHA to pin
#   BASE_JDK    JDK dir name under ~/.sdkman/candidates/java for the baseline build
#   TARGET_JDK  JDK dir name for the recipe run and the post-recipe build
#   RECIPE      e.g. org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5
#   PHASES      subset of "clone baseline recipe post" (default: all four)
# env:
#   MVN_ARGS        extra args for every mvn build (e.g. -Dskip.npm -Dcheckstyle.skip)
#   REWRITE_GOAL    run (default) or runNoFork (when `run`'s forked compile cannot work
#                   on the original code under TARGET_JDK)
#   REWRITE_PLUGIN  rewrite-maven-plugin version (default 6.46.1)
#   REWRITE_SPRING  rewrite-spring version (default 6.37.1)
#
# The repo's pom is never edited to add the plugin: the plugin is invoked by coordinates.
# Builds use -Dmaven.test.failure.ignore=true so a test failure still yields full
# surefire/failsafe counts; a compile failure still fails the build.
set -uo pipefail
NAME=$1 URL=$2 SHA=$3 BASE_JDK=$4 TARGET_JDK=$5 RECIPE=$6
PHASES=${7:-"clone baseline recipe post"}
GAPMAP=${GAPMAP:-$HOME/.cache/stratigraph/gapmap}
JDKS=$HOME/.sdkman/candidates/java
REWRITE_PLUGIN=${REWRITE_PLUGIN:-6.46.1}
REWRITE_SPRING=${REWRITE_SPRING:-6.37.1}
REWRITE_GOAL=${REWRITE_GOAL:-run}
MVN_ARGS=${MVN_ARGS:-}
HERE=$(cd "$(dirname "$0")" && pwd)
W=$GAPMAP/$NAME
L=$GAPMAP/_logs/$NAME
mkdir -p "$L"

has() { [[ " $PHASES " == *" $1 "* ]]; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

tests_summary() { # $1 = label
  python3 "$HERE/summarize_tests.py" "$W" > "$L/$1-tests.json"
  cat "$L/$1-tests.json" | head -c 400; echo
}

if has clone; then
  rm -rf "$W"
  src=$URL; [ -d "$GAPMAP/_src/$NAME/.git" ] && src=$GAPMAP/_src/$NAME
  git clone -q --no-hardlinks "$src" "$W" && git -C "$W" checkout -q "$SHA" || exit 2
  git -C "$W" rev-parse HEAD > "$L/sha.txt"
fi
cd "$W" || exit 2

if has baseline; then
  echo "[$(stamp)] baseline JDK=$BASE_JDK"
  JAVA_HOME=$JDKS/$BASE_JDK PATH=$JDKS/$BASE_JDK/bin:$PATH \
    mvn -B -e verify -Dmaven.test.failure.ignore=true $MVN_ARGS > "$L/baseline.log" 2>&1
  echo $? > "$L/baseline.exit"
  tests_summary baseline
  rm -rf target
  git -C "$W" status --porcelain > "$L/baseline-dirty.txt"
  git -C "$W" checkout -q -- . ; git -C "$W" clean -qfdx
fi

if has recipe; then
  echo "[$(stamp)] recipe $RECIPE goal=$REWRITE_GOAL JDK=$TARGET_JDK"
  JAVA_HOME=$JDKS/$TARGET_JDK PATH=$JDKS/$TARGET_JDK/bin:$PATH \
    mvn -B -e org.openrewrite.maven:rewrite-maven-plugin:$REWRITE_PLUGIN:$REWRITE_GOAL \
      -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:$REWRITE_SPRING \
      -Drewrite.activeRecipes=$RECIPE -Drewrite.exportDatatables=true $MVN_ARGS \
      > "$L/recipe.log" 2>&1
  echo $? > "$L/recipe.exit"
  rm -rf "$L/datatables"; [ -d target/rewrite ] && cp -R target/rewrite "$L/datatables"
  rm -rf target
  git add -A -N . 2>/dev/null
  git diff --stat=200 > "$L/diffstat.txt"; git diff > "$L/recipe.diff"
  git diff --shortstat | tee "$L/shortstat.txt"
  # snapshot the recipe output so later manual fixes diff cleanly against it
  git add -A && git -c user.name=gapmap -c user.email=gapmap@localhost commit -q --no-verify -m "openrewrite $RECIPE"
fi

if has post; then
  echo "[$(stamp)] post-recipe build JDK=$TARGET_JDK"
  JAVA_HOME=$JDKS/$TARGET_JDK PATH=$JDKS/$TARGET_JDK/bin:$PATH \
    mvn -B -e verify -Dmaven.test.failure.ignore=true $MVN_ARGS > "$L/post.log" 2>&1
  echo $? > "$L/post.exit"
  tests_summary post
fi
echo "[$(stamp)] done $NAME"
