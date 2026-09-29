#!/usr/bin/env bash
# Time-boxed manual fix iteration after the recipe: rebuild NAME with its target JDK,
# log to $GAPMAP/_logs/NAME/fixN.log, record the note and the cumulative manual diff.
# usage: fix.sh NAME N "what was changed before this rebuild" [TARGET_JDK]
set -uo pipefail
NAME=$1 N=$2 NOTE=$3 TARGET_JDK=${4:-17.0.13-amzn}
GAPMAP=${GAPMAP:-$HOME/.cache/stratigraph/gapmap}
HERE=$(cd "$(dirname "$0")" && pwd)
W=$GAPMAP/$NAME L=$GAPMAP/_logs/$NAME
cd "$W" || exit 2
echo "$NOTE" > "$L/fix$N.note"
git add -A -N . ; git diff > "$L/fix$N.diff"
rm -rf target
JAVA_HOME=$HOME/.sdkman/candidates/java/$TARGET_JDK PATH=$HOME/.sdkman/candidates/java/$TARGET_JDK/bin:$PATH \
  mvn -B -e verify -Dmaven.test.failure.ignore=true ${MVN_ARGS:-} > "$L/fix$N.log" 2>&1
echo $? > "$L/fix$N.exit"
python3 "$HERE/summarize_tests.py" "$W" > "$L/fix$N-tests.json"
echo "exit=$(cat "$L/fix$N.exit")"
grep -E "^\[ERROR\] /.*\.java" "$L/fix$N.log" | sed "s#$W/##" | sort -u | head -30
python3 -c "import json;d=json.load(open('$L/fix$N-tests.json'));print('tests',d['tests'],'passed',d['passed'],'fail',d['failures'],'err',d['errors'],'skip',d['skipped']);[print(' -',f['test'],f['message'][:150]) for f in d['failed'][:15]]"
