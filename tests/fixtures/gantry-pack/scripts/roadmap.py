#!/usr/bin/env python3
"""Keep ROADMAP.md as a deterministic projection of authoritative Issue state."""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import Issue, issue_levels, load_issues, load_policy_issues, policy_spec_numbers, repo_root, resolve_issue_arg, spec_numbers  # noqa: E402

PROGRESS_ISSUES_RE = re.compile(r"^(\| Issues completed \| \*\*)(\d+) / (\d+)(\*\* \|)\s*$")
PROGRESS_SPECS_RE = re.compile(r"^(\| Specs completed \| \*\*)(\d+) / (\d+)(\*\* \|)\s*$")
PROGRESS_WAVES_RE = re.compile(r"^(\| Execution waves \| \*\*)(\d+)(\*\* \|)\s*$")
BLOCK_RE = {
    name: re.compile(rf"(<!-- BEGIN GENERATED: {name} -->\n)(.*?)(<!-- END GENERATED: {name} -->)", re.DOTALL)
    for name in ("spec progress", "issue checklist")
}
STATUS_LINE_RE = re.compile(r"^Status:\s*.*$", re.MULTILINE)


def counts(issues: dict[str, Issue]) -> tuple[int, int, int, int]:
    grouped: dict[str, list[Issue]] = {}
    for issue in issues.values():
        grouped.setdefault(issue.spec, []).append(issue)
    return (
        sum(issue.done for issue in issues.values()), len(issues),
        sum(all(issue.done for issue in entries) for entries in grouped.values()), len(grouped),
    )


def render_spec_progress(issues: dict[str, Issue], levels: dict[str, int], numbers: dict[str, int]) -> str:
    rows = ["| # | Spec | Issues done | Waves |", "|---|---|---|---|"]
    for spec in sorted({issue.spec for issue in issues.values()}, key=lambda value: (numbers.get(value, 99), value)):
        entries = [issue for issue in issues.values() if issue.spec == spec]
        depths = sorted(levels[issue.ref] for issue in entries)
        span = str(depths[0]) if depths[0] == depths[-1] else f"{depths[0]}–{depths[-1]}"
        rows.append(f"| {numbers.get(spec, 0):02d} | `{spec}` | {sum(issue.done for issue in entries)}/{len(entries)} | {span} |")
    return "\n".join(rows) + "\n"


def render_issue_checklist(issues: dict[str, Issue], levels: dict[str, int], numbers: dict[str, int]) -> str:
    waves: dict[int, list[Issue]] = {}
    for ref, level in levels.items():
        waves.setdefault(level, []).append(issues[ref])
    output: list[str] = []
    for level in sorted(waves):
        members = sorted(waves[level], key=lambda issue: (numbers.get(issue.spec, 99), issue.spec, issue.number))
        output.append(f"\n### Wave {level} — {sum(issue.done for issue in members)}/{len(members)} done\n")
        for issue in members:
            line = f"- [{'x' if issue.done else ' '}] **`{issue.ref}`** — {issue.title}"
            blockers = [blocker for blocker in issue.blocked_by if blocker in issues]
            output.append(line + (" _(no blockers)_" if not blockers else ""))
            if blockers:
                output.append("  <br>↳ blocked by: " + ", ".join(blockers))
    return "\n".join(output).lstrip("\n") + "\n"


def delivery_levels(text: str, issues: dict[str, Issue]) -> dict[str, int]:
    """Preserve completed wave membership; schedule other Issues after history.

    The roadmap supplies historical placement only. Authoritative Issue status,
    never a cached checkbox or heading count, determines whether a wave is complete.
    """
    issue_levels(issues)  # Validate cycles before resolving historical placement.
    block = BLOCK_RE["issue checklist"].search(text)
    frozen: dict[str, int] = {}
    if block:
        sections = re.split(r"^### Wave (\d+)[^\n]*\n", block.group(2), flags=re.MULTILINE)
        for index in range(1, len(sections), 2):
            wave = int(sections[index])
            refs = re.findall(r"^- \[[ xX]\] \*\*`([^`]+)`\*\*", sections[index + 1], re.MULTILINE)
            if refs and all(ref in issues and issues[ref].done for ref in refs):
                for ref in refs:
                    if ref in frozen:
                        raise ValueError(f"completed Issue {ref} appears in multiple waves")
                    frozen[ref] = wave
            else:
                break
    floor = max(frozen.values(), default=-1) + 1
    levels = dict(frozen)

    def place(ref: str) -> int:
        if ref not in levels:
            blockers = [place(blocker) + 1 for blocker in issues[ref].blocked_by if blocker in issues]
            levels[ref] = max([floor, *blockers])
        return levels[ref]

    for ref in sorted(issues):
        place(ref)
    for ref, issue in issues.items():
        if any(levels[blocker] >= levels[ref] for blocker in issue.blocked_by if blocker in issues):
            raise ValueError(f"dependencies of {ref} conflict with completed wave history")
    return levels


def render_roadmap(text: str, issues: dict[str, Issue], root: Path, *, scratch: Path | None = None) -> str:
    levels = delivery_levels(text, issues)
    numbers = spec_numbers(scratch) if scratch else policy_spec_numbers(root)
    done_issues, total_issues, done_specs, total_specs = counts(issues)
    blocks = {
        "spec progress": render_spec_progress(issues, levels, numbers),
        "issue checklist": render_issue_checklist(issues, levels, numbers),
    }
    for name, expression in BLOCK_RE.items():
        if not expression.search(text):
            raise SystemExit(f"ROADMAP.md is missing the generated block markers for '{name}'")
        text = expression.sub(lambda match, name=name: match.group(1) + "\n" + blocks[name] + "\n" + match.group(3), text)
    lines: list[str] = []
    for line in text.splitlines():
        if match := PROGRESS_ISSUES_RE.match(line):
            line = f"{match.group(1)}{done_issues} / {total_issues}{match.group(4)}"
        if match := PROGRESS_SPECS_RE.match(line):
            line = f"{match.group(1)}{done_specs} / {total_specs}{match.group(4)}"
        if match := PROGRESS_WAVES_RE.match(line):
            line = f"{match.group(1)}{max(levels.values()) + 1 if levels else 0}{match.group(3)}"
        lines.append(line)
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def drift(old: str, new: str) -> list[str]:
    changes = [line for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0)
               if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
    return changes[:40] + ([f"… {len(changes) - 40} more"] if len(changes) > 40 else [])


def set_status(path: Path, value: str) -> None:
    text = path.read_text(encoding="utf-8")
    if not STATUS_LINE_RE.search(text):
        raise SystemExit(f"{path} has no Status: line")
    path.write_text(STATUS_LINE_RE.sub(f"Status: {value}", text, count=1), encoding="utf-8")


def append_comment(path: Path, value: str) -> None:
    text = path.read_text(encoding="utf-8").rstrip("\n")
    entry = f"- {dt.date.today().isoformat()} — {value.strip()}\n"
    text += "\n" + entry if re.search(r"^## Comments\s*$", text, re.MULTILINE) else "\n\n## Comments\n\n" + entry
    path.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "waves", "done", "status", "comment"])
    parser.add_argument("issue", nargs="?")
    parser.add_argument("value", nargs="?")
    parser.add_argument("--scratch", help="legacy Issue root override")
    parser.add_argument("--roadmap", default="ROADMAP.md")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = repo_root()
    roadmap = root / args.roadmap
    scratch = root / args.scratch if args.scratch else None
    issues = load_issues(scratch) if scratch else load_policy_issues(root)
    if args.command in ("check", "waves"):
        old = roadmap.read_text(encoding="utf-8")
        try:
            new = render_roadmap(old, issues, root, scratch=scratch)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        changes = drift(old, new)
        if args.command == "waves" and not args.dry_run and changes:
            roadmap.write_text(new, encoding="utf-8")
        done_issues, total_issues, done_specs, total_specs = counts(issues)
        payload = {"issues_done": done_issues, "issues_total": total_issues, "specs_done": done_specs,
                   "specs_total": total_specs, "drift": changes, "written": args.command == "waves" and not args.dry_run and bool(changes)}
        print(json.dumps(payload, indent=2) if args.json else f"issues {done_issues}/{total_issues}, specs {done_specs}/{total_specs}")
        return 1 if args.command == "check" and changes else 0
    if not args.issue:
        parser.error(f"{args.command} needs an Issue reference")
    issue = resolve_issue_arg(args.issue, root, issues)
    if not issue:
        print(f"issue not found: {args.issue}", file=sys.stderr)
        return 2
    if args.command == "status":
        if not args.value:
            parser.error("status needs a value")
        if args.value.lower() == "done":
            print("refusing: use `roadmap.py done` so the roadmap is updated in the same change", file=sys.stderr)
            return 1
        if not args.dry_run:
            set_status(issue.path, args.value)
        print(f"{issue.ref}: Status -> {args.value}")
        return 0
    if args.command == "comment":
        if not args.value:
            parser.error("comment needs text")
        if not args.dry_run:
            append_comment(issue.path, args.value)
        print(f"{issue.ref}: comment appended")
        return 0
    if not issue.criteria:
        print(f"refusing: {issue.ref} has no acceptance criteria to satisfy", file=sys.stderr)
        return 1
    if args.dry_run:
        print(f"would: mark {issue.ref} done")
        return 0
    from acceptance import tick_all
    tick_all(issue.path)
    set_status(issue.path, "done")
    refreshed_issues = load_issues(scratch) if scratch else load_policy_issues(root)
    new = render_roadmap(roadmap.read_text(encoding="utf-8"), refreshed_issues, root, scratch=scratch)
    roadmap.write_text(new, encoding="utf-8")
    print(f"did: tick criteria and set Status: done in {issue.path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
