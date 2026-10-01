#!/usr/bin/env bash
# Run `stratigraph upgrade run` over the gap-map corpus and tabulate the results
# against the OpenRewrite-only baseline (README.md: 0/10 green).
#
# usage: agent-bench.sh [--ai] [NAME...]
#   --ai     pass --ai claude-code (uses your Claude account; costs money)
#   NAME     only these corpus entries (default: all in corpus.tsv)
# env:
#   STRATIGRAPH  command to run (default: node <repo>/dist/cli.js)
#   WORK         where fresh clones go (default: ~/.cache/stratigraph/upgrade-bench)
#   GAPMAP       where the gap map's source mirrors are (default: ~/.cache/stratigraph/gapmap)
#
# Each repo is cloned fresh at its pinned SHA; the upgrade runs on its own branch;
# upgrade-report.json is copied to $WORK/results/<name>.json and summarised.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STRATIGRAPH=${STRATIGRAPH:-"node $ROOT/dist/cli.js"}
WORK=${WORK:-$HOME/.cache/stratigraph/upgrade-bench}
GAPMAP=${GAPMAP:-$HOME/.cache/stratigraph/gapmap}
JDKS=$HOME/.sdkman/candidates/java
AI=()
if [ "${1:-}" = "--ai" ]; then AI=(--ai claude-code --ai-budget 3); shift; fi
ONLY=("$@")
mkdir -p "$WORK/results"

while IFS=$'\t' read -r name url sha base_jdk target_jdk recipe mvn_args; do
  [ -z "$name" ] || [ "${name:0:1}" = "#" ] && continue
  if [ ${#ONLY[@]} -gt 0 ] && [[ ! " ${ONLY[*]} " == *" $name "* ]]; then continue; fi
  case "$recipe" in *boot4*) to=4.0 ;; *) to=3.5 ;; esac
  dir="$WORK/$name"
  rm -rf "$dir"
  src=$url; [ -d "$GAPMAP/_src/$name/.git" ] && src=$GAPMAP/_src/$name
  git clone -q --no-hardlinks "$src" "$dir" && git -C "$dir" checkout -q -B bench "$sha" || { echo "$name: clone failed"; continue; }
  echo "[$(date -u +%H:%M:%S)] $name → $to"
  (cd "$dir" && $STRATIGRAPH upgrade run . --to "$to" \
      --baseline-java-home "$JDKS/$base_jdk" --target-java-home "$JDKS/$target_jdk" \
      ${mvn_args:+--maven-args "$mvn_args"} "${AI[@]}" > "$WORK/results/$name.log" 2>&1)
  cp "$dir/upgrade-report.json" "$WORK/results/$name.json" 2>/dev/null || echo "$name: no report (see $WORK/results/$name.log)"
done < "$HERE/corpus.tsv"

python3 - "$WORK/results" <<'EOF'
import json, os, sys
d = sys.argv[1]
rows = []
for f in sorted(os.listdir(d)):
    if not f.endswith('.json'): continue
    r = json.load(open(os.path.join(d, f)))
    fin = r.get('final') or {}
    layers = {}
    for c in r.get('commits', []): layers[c['layer']] = layers.get(c['layer'], 0) + 1
    decisions = sum(1 for h in r.get('remaining', []) if h['disposition'] == 'decision')
    rows.append((f[:-5], r['status'], f"{fin.get('passed','-')}/{fin.get('tests','-')}", len(fin.get('regressed') or []),
                 layers.get('known-fix', 0), layers.get('ai', 0), decisions, len(r.get('remaining', [])) - decisions,
                 r.get('minutes'), round(r.get('costUsd', 0), 2)))
print('| Repo | Status | Tests passing | Red vs baseline | Known fixes | AI fixes | Decisions left | Unresolved | Minutes | AI $ |')
print('|---|---|---|---|---|---|---|---|---|---|')
for row in rows: print('| ' + ' | '.join(str(x) for x in row) + ' |')
print(f"\nParity: {sum(1 for r in rows if r[1] == 'parity')}/{len(rows)}")
EOF
