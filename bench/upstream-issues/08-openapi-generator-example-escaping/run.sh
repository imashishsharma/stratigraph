#!/usr/bin/env bash
# Generates the Spring interface for a spec whose string example contains escaped quotes, then compiles.
# Usage: ./run.sh [generator-version]   (default 7.26.0, the latest release; 7.27.0-SNAPSHOT uses snap-settings.xml)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
V=${1:-7.26.0}
export JAVA_HOME=$HOME/.sdkman/candidates/java/17.0.13-amzn
W=$(mktemp -d); cp -r "$HERE/pom.xml" "$HERE/src" "$W/"; cd "$W"
EXTRA=""; case "$V" in *SNAPSHOT) EXTRA="-s $HERE/snap-settings.xml";; esac
mvn -B $EXTRA -Dopenapi-generator.version=$V clean compile > "$HERE/compile-$V.log" 2>&1; echo "compile exit ($V): $?"
grep -rn "exampleString =" target/generated-sources
