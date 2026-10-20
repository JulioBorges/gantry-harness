#!/usr/bin/env python3
"""Extract or verify the acceptance criteria of one Issue."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import artifact_path, load_issues, load_policy_issues, parse_issue, repo_root, resolve_issue_arg, section  # noqa: E402


def tick_all(path: Path) -> int:
    """Tick every criterion; only roadmap.py invokes this state transition."""
    issue = parse_issue(path)
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    changed = 0
    for criterion in issue.criteria:
        old = lines[criterion.line_no - 1]
        new = old.replace("- [ ]", "- [x]", 1)
        if new != old:
            lines[criterion.line_no - 1] = new
            changed += 1
    if changed:
        path.write_text("".join(lines), encoding="utf-8")
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("issue", help="spec#NN or an Issue path")
    parser.add_argument("--scratch", help="legacy Issue root override")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--check", action="store_true", help="require done Status and every criterion ticked")
    args = parser.parse_args()
    root = repo_root()
    issues = load_issues(root / args.scratch) if args.scratch else load_policy_issues(root)
    issue = resolve_issue_arg(args.issue, root, issues)
    if not issue:
        print(f"issue not found: {args.issue}", file=sys.stderr)
        return 2
    text = issue.path.read_text(encoding="utf-8")
    payload = {
        **issue.to_dict(root),
        "spec_path": str(artifact_path(root, "specs", issue.spec).relative_to(root)),
        "criteria": [{"index": item.index, "text": item.text, "checked": item.checked} for item in issue.criteria],
        "what_to_build": section(text, "What to build").strip(),
        "notes": section(text, "Notes").strip(),
    }
    payload["complete"] = issue.done and bool(issue.criteria) and all(item.checked for item in issue.criteria)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"{issue.ref}  {issue.title}")
        print(f"  status: {issue.status}   blocked by: {', '.join(issue.blocked_by) or 'none'}")
        for item in issue.criteria:
            print(f"  [{'x' if item.checked else ' '}] {item.index}. {item.text}")
    if args.check and not payload["complete"]:
        print(f"NOT COMPLETE: status={issue.status}, ticked={payload['criteria_checked']}/{payload['criteria_total']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
