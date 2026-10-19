#!/usr/bin/env python3
import json
import os
import sys

log = os.environ.get("GANTRY_INVOCATION_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(sys.argv) + "\n")
if "--json" in sys.argv:
    sys.stderr.write("unexpected --json\n")
    raise SystemExit(2)
print(json.dumps({
    "frontier": ["path#01"],
    "issues": [{
        "frontierBlocked": False,
        "number": 1,
        "openBlockers": [],
        "path": ".scratch/path/issues/01-ready.md",
        "ref": "path#01",
        "spec": "path",
        "status": "ready-for-agent",
        "title": "Resolved from PATH",
    }],
    "specs": [{"executable": False, "path": ".scratch/path/spec.md", "slug": "path"}],
}, sort_keys=True))
