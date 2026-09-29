#!/usr/bin/env python3
"""Condense a run's raw logs ($GAPMAP/_logs/NAME) into bench/upgrade-gap/logs/NAME.txt (<~200 lines).

Keeps: pinned sha, exit codes, test summaries, recipe diffstat, deduplicated compiler
errors (first line + detail lines), failing tests, key 'Caused by' lines, and the
same for every fixN.log (manual time-boxed fix iterations after the recipe)."""
import json, os, re, sys, glob

name = sys.argv[1]
G = os.path.expanduser(os.environ.get("GAPMAP", "~/.cache/stratigraph/gapmap"))
L = os.path.join(G, "_logs", name)
W = os.path.join(G, name) + "/"
out = []
def rd(p, default=""):
    try: return open(os.path.join(L, p)).read().strip()
    except OSError: return default

def build_excerpt(logname, max_lines=45):
    txt = rd(logname)
    if not txt: return ["  (no log)"]
    lines = [l.replace(W, "") for l in txt.splitlines()]
    res, seen = [], set()
    # compiler errors
    for i, l in enumerate(lines):
        m = re.match(r"\[ERROR\] (/?\S+\.(java|kt|groovy)):\[(\d+),\d+\] (.*)", l)
        if m:
            key = (m.group(1), m.group(3), m.group(4))
            if key in seen: continue
            seen.add(key)
            res.append(f"  {m.group(1)}:{m.group(3)} {m.group(4)[:200]}")
            for d in lines[i+1:i+4]:
                if re.match(r"\[ERROR\]\s{2,}(symbol|location|required|found|reason)", d):
                    res.append("      " + d.replace("[ERROR]", "").strip()[:160])
    other = [l for l in lines if l.startswith("[ERROR] Failed to execute goal")]
    for l in other[:3]: res.append("  " + l[:300])
    causes = []
    for l in lines:
        if l.startswith("Caused by:") and l not in causes: causes.append(l)
    for c in causes[-6:]: res.append("  " + c[:260])
    for l in lines:
        if re.match(r"\[(INFO|ERROR|WARNING)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+$", l):
            res.append("  " + l)
    for l in lines:
        if "BUILD SUCCESS" in l or "BUILD FAILURE" in l: res.append("  " + l)
    return res[:max_lines]

def tests(label):
    try: d = json.loads(rd(f"{label}-tests.json"))
    except Exception: return ["  (no test report)"]
    r = [f"  tests={d['tests']} passed={d['passed']} failures={d['failures']} errors={d['errors']} skipped={d['skipped']}"]
    seen = set()
    for f in d["failed"]:
        k = (f["test"].split("#")[0], f["message"][:80])
        if k in seen: continue
        seen.add(k)
        r.append(f"   - {f['test']}: {f['type']}: {f['message'][:180]}")
        if len(r) > 14: r.append("   ..."); break
    return r

out.append(f"# {name}  sha={rd('sha.txt')}")
out.append(f"## baseline exit={rd('baseline.exit')}")
out += tests("baseline")
out.append(f"## recipe exit={rd('recipe.exit')}  {rd('shortstat.txt')}")
ds = rd("diffstat.txt").splitlines()
out += ["  " + l for l in ds[:25]] + (["  ..."] if len(ds) > 25 else [])
out.append(f"## post-recipe build exit={rd('post.exit')}")
out += build_excerpt("post.log")
out += tests("post")
for f in sorted(glob.glob(os.path.join(L, "fix*.log")), key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0)):
    b = os.path.basename(f)
    note = rd(b.replace(".log", ".note"))
    out.append(f"## {b[:-4]}: {note}")
    out += build_excerpt(b, 30)
    t = b.replace(".log", "")
    if os.path.exists(os.path.join(L, f"{t}-tests.json")): out += tests(t)
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", f"{name}.txt")
open(dst, "w").write("\n".join(out[:200]) + "\n")
print(dst, len(out))
