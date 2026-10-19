#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
STATUS_RE = re.compile(r"^Status:\s*(.+?)\s*$", re.MULTILINE)
SLICE_RE = re.compile(r"^Slice:\s*`?([a-z0-9-]+#\d+)`?\s*$", re.MULTILINE)
BLOCKER_RE = re.compile(r"^-\s+`([^`]+)`\s*$")


def main() -> int:
    if "--json" in sys.argv:
        sys.stderr.write("unexpected --json\n")
        return 2
    argv = sys.argv[1:]
    cwd = Path.cwd()
    command = "board"
    index = 0
    while index < len(argv):
        if argv[index] == "--cwd" and index + 1 < len(argv):
            cwd = Path(argv[index + 1])
            index += 2
            continue
        if argv[index] in {"board", "issues", "specs", "frontier"}:
            command = argv[index]
        index += 1
    log = cwd / "board-invocations.log"
    with log.open("a", encoding="utf-8") as handle:
        handle.write(" ".join(sys.argv) + "\n")
    records = []
    issue_root = cwd / ".scratch"
    issue_paths = sorted(issue_root.glob("*/issues/*.md")) if issue_root.exists() else []
    for issue_path in issue_paths:
        text = issue_path.read_text(encoding="utf-8")
        title = TITLE_RE.search(text)
        status = STATUS_RE.search(text)
        slice_match = SLICE_RE.search(text)
        blockers = []
        if "## Blocked by" in text:
            section = text.split("## Blocked by", 1)[1]
            for line in section.splitlines():
                if line.startswith("## "):
                    break
                match = BLOCKER_RE.match(line.strip())
                if match:
                    blockers.append(match.group(1))
        ref = slice_match.group(1) if slice_match else issue_path.stem
        spec, number = ref.split("#")
        records.append({
            "ref": ref,
            "spec": spec,
            "number": int(number),
            "title": title.group(1) if title else issue_path.stem,
            "status": status.group(1) if status else "ready-for-agent",
            "path": issue_path.relative_to(cwd).as_posix(),
            "blocked_by": blockers,
            "done": (status.group(1) if status else "") == "done",
        })
    by_ref = {item["ref"]: item for item in records}
    frontier = []
    issues = []
    for item in sorted(records, key=lambda entry: (entry["spec"], entry["number"])):
        open_blockers = [
            blocker for blocker in item["blocked_by"]
            if blocker not in by_ref or not by_ref[blocker]["done"]
        ]
        blocked = bool(open_blockers)
        if not item["done"] and not blocked:
            frontier.append(item["ref"])
        issues.append({
            "ref": item["ref"],
            "spec": item["spec"],
            "number": item["number"],
            "title": item["title"],
            "status": item["status"],
            "path": item["path"],
            "frontierBlocked": blocked,
            "openBlockers": open_blockers,
        })
    specs = []
    for spec_path in sorted(issue_root.glob("*/spec.md")) if issue_root.exists() else []:
        specs.append({
            "slug": spec_path.parent.name,
            "path": spec_path.relative_to(cwd).as_posix(),
            "executable": False,
        })
    result = {"issues": issues, "specs": specs, "frontier": frontier}
    if command == "issues":
        result = {"issues": issues}
    elif command == "specs":
        result = {"specs": specs}
    elif command == "frontier":
        result = {"frontier": frontier}
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
