#!/usr/bin/env python3
"""Sum surefire/failsafe XML reports under a Maven project and list failing tests."""
import glob, json, os, sys
import xml.etree.ElementTree as ET

root = sys.argv[1]
out = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0, "suites": 0, "failed": []}
for kind in ("surefire-reports", "failsafe-reports"):
    for f in sorted(glob.glob(os.path.join(root, "**", "target", kind, "TEST-*.xml"), recursive=True)):
        try:
            s = ET.parse(f).getroot()
        except ET.ParseError:
            continue
        out["suites"] += 1
        for k in ("tests", "failures", "errors", "skipped"):
            out[k] += int(float(s.get(k, 0) or 0))
        for tc in s.iter("testcase"):
            for bad in ("failure", "error"):
                e = tc.find(bad)
                if e is not None:
                    msg = (e.get("message") or e.text or "").strip().splitlines()
                    out["failed"].append({
                        "test": f'{tc.get("classname")}#{tc.get("name")}',
                        "kind": bad, "type": e.get("type"),
                        "message": (msg[0] if msg else "")[:300]})
out["passed"] = out["tests"] - out["failures"] - out["errors"] - out["skipped"]
print(json.dumps(out, indent=1))
