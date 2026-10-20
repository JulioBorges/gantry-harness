#!/usr/bin/env python3
"""Read the Gantry board, execute one Run, resume or discard it, or approve it."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from common import artifact_path, issue_branch, load_policy_issues, normalise_ref, repo_root, resolve_policy


def specs(root: Path, policy: dict) -> list[dict[str, object]]:
    template = policy["artifacts"]["specs"]
    matcher = re.compile(
        "^" + re.escape(template).replace(re.escape("{slug}"), r"(?P<slug>[^/]+)") + "$"
    )
    entries: list[dict[str, object]] = []
    for path in sorted(root.glob(template.format(slug="*"))):
        match = matcher.match(path.relative_to(root).as_posix())
        if match and path.is_file():
            entries.append({
                "slug": match.group("slug"),
                "path": path.relative_to(root).as_posix(),
                "executable": False,
            })
    return entries


def board(root: Path) -> dict[str, object]:
    policy = resolve_policy(root)
    issues = load_policy_issues(root, policy)
    records = []
    frontier = []
    for issue in sorted(issues.values(), key=lambda entry: (entry.spec, entry.number)):
        open_blockers = [
            blocker for blocker in issue.blocked_by
            if blocker not in issues or not issues[blocker].done
        ]
        blocked = bool(open_blockers)
        if not issue.done and not issue.parked and not blocked:
            frontier.append(issue.ref)
        records.append({
            "ref": issue.ref,
            "spec": issue.spec,
            "number": issue.number,
            "title": issue.title,
            "status": issue.status,
            "path": issue.path.relative_to(root).as_posix(),
            "frontierBlocked": blocked,
            "openBlockers": open_blockers,
        })
    return {"issues": records, "specs": specs(root, policy), "frontier": frontier}


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, sort_keys=True), flush=True)


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=False)


def role_command(root: Path, policy: dict, role: str) -> Path | None:
    configured = policy.get("execution", {}).get("roles", {}).get(role, {}).get("command")
    if not isinstance(configured, str) or not configured.strip():
        return None
    path = Path(configured)
    if not path.is_absolute():
        path = root / path
    if path.is_file() and os.access(path, os.X_OK):
        return path
    return None


def check_commands(policy: dict) -> str | None:
    checks = policy.get("checks") or []
    if not isinstance(checks, list):
        return "checks-invalid"
    for check in checks:
        command = check if isinstance(check, str) else check.get("command") if isinstance(check, dict) else None
        if not isinstance(command, str) or not command.strip():
            return "checks-invalid"
    return None


def setup_error(reason: str) -> int:
    emit({"error": {"code": "setup-invalid", "reason": reason}})
    return 2


def run_checks(worktree: Path, policy: dict) -> bool:
    for check in policy.get("checks") or []:
        command = check if isinstance(check, str) else check["command"]
        completed = subprocess.run(command, cwd=worktree, shell=True, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            return False
    return True


def invoke_role(
    command: Path, worktree: Path, role: str, diff_base: str, diff: str,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GANTRY_ROLE"] = role
    env["GANTRY_DIFF_BASE"] = diff_base
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [str(command), "--role", role, "--diff-base", diff_base],
        cwd=worktree, text=True, capture_output=True, check=False,
        input=None if role in {"implement", "plan"} else diff, env=env,
    )


def verdict_passed(completed: subprocess.CompletedProcess[str]) -> bool:
    if completed.returncode != 0:
        return False
    try:
        body = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return False
    return isinstance(body, dict) and body.get("verdict") == "pass"


def pause(payload: dict[str, object]) -> str:
    emit(payload)
    return sys.stdin.readline().strip().lower()


def correction_budget(policy: dict) -> int:
    raw = policy.get("budget", {}).get("corrections", 2)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return 2
    return raw


def render_branch(policy: dict, spec: str, number: int) -> str:
    return policy["git"]["issueBranch"].format(
        prefix=policy["git"]["prefix"], spec=spec, number=number,
    )


def worktree_path(root: Path, branch: str) -> Path:
    return root / ".gantry" / "worktrees" / branch.replace("/", "-")


def primary_checkout(root: Path) -> Path:
    completed = git(root, "rev-parse", "--git-common-dir")
    if completed.returncode != 0:
        return root
    path = Path(completed.stdout.strip())
    if not path.is_absolute():
        path = (root / path).resolve()
    if path.name == ".git":
        return path.parent
    if path.parent.name == "worktrees" and path.parent.parent.name == ".git":
        return path.parent.parent.parent
    return root


def tree_dirty(worktree: Path) -> bool:
    return bool(git(worktree, "status", "--porcelain").stdout.strip())


def create_worktree(root: Path, branch: str, target: str) -> Path | None:
    worktree = worktree_path(root, branch)
    if git(root, "rev-parse", "--verify", "--quiet", branch).returncode == 0 or worktree.exists():
        return None
    if git(root, "branch", branch, target).returncode != 0:
        return None
    worktree.parent.mkdir(parents=True, exist_ok=True)
    added = git(root, "worktree", "add", "--quiet", str(worktree), branch)
    if added.returncode != 0:
        git(root, "branch", "-D", branch)
        if worktree.exists():
            git(root, "worktree", "remove", "--force", str(worktree))
        return None
    return worktree


def discard_worktree(root: Path, worktree: Path, branch: str) -> None:
    git(root, "worktree", "remove", "--force", str(worktree))
    git(root, "branch", "-D", branch)


def git_common_dir(root: Path) -> Path:
    completed = git(root, "rev-parse", "--git-common-dir")
    path = Path(completed.stdout.strip() or ".git")
    if not path.is_absolute():
        path = (root / path).resolve()
    return path


def run_record_path(root: Path, ref: str) -> Path:
    return git_common_dir(root) / "gantry-cli" / f"{ref.replace('#', '--')}.json"


def save_run(root: Path, record: dict[str, object]) -> None:
    path = run_record_path(root, str(record["ref"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")


def load_run(root: Path, ref: str) -> dict[str, object] | None:
    path = run_record_path(root, ref)
    if not path.is_file():
        return None
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return loaded if isinstance(loaded, dict) else None


def delete_run(root: Path, ref: str) -> None:
    path = run_record_path(root, ref)
    if path.is_file():
        path.unlink()


def implement_failed(worktree: Path, target: str, completed: subprocess.CompletedProcess[str]) -> bool:
    ahead = git(worktree, "rev-list", "--count", f"{target}..HEAD")
    return completed.returncode != 0 or tree_dirty(worktree) or ahead.returncode != 0 or ahead.stdout.strip() in {"", "0"}


def ready_payload(branch: str, worktree: Path) -> dict[str, object]:
    return {"event": "ready-for-approval", "branch": branch, "worktree": str(worktree), "pushed": False}


def deliver(
    root: Path, worktree: Path, branch: str, target: str, policy: dict,
    commands: dict[str, Path], record: dict[str, object],
) -> int:
    while True:
        phase = record["phase"]
        if phase == "ready":
            emit(ready_payload(branch, worktree))
            return 0
        if phase == "implement":
            spent = int(record["spent"])
            granted = int(record["granted"])
            if spent > 0 and spent >= granted:
                save_run(root, record)
                answer = pause({
                    "event": "pause", "reason": "corrections-exhausted", "choices": ["continue", "stop"],
                    "branch": branch, "worktree": str(worktree), "pushed": False,
                })
                if answer != "continue":
                    emit({"event": "stopped", "branch": branch, "worktree": str(worktree), "pushed": False})
                    return 1
                record["granted"] = granted + 1
                save_run(root, record)
            record["phase"] = "implement"
            save_run(root, record)
            implement = invoke_role(commands["implement"], worktree, "implement", target, "")
            if implement_failed(worktree, target, implement):
                record["spent"] = int(record["spent"]) + 1
                record["phase"] = "implement"
                save_run(root, record)
                continue
            record["phase"] = "checks"
            phase = "checks"
        if phase == "checks":
            save_run(root, record)
            if not run_checks(worktree, policy):
                record["spent"] = int(record["spent"]) + 1
                record["phase"] = "implement"
                save_run(root, record)
                continue
            record["phase"] = "review"
            phase = "review"
        if phase == "review":
            record["phase"] = "review"
            save_run(root, record)
            diff = git(worktree, "diff", f"{target}...HEAD").stdout
            review = invoke_role(commands["review"], worktree, "review", target, diff)
            if not verdict_passed(review):
                record["spent"] = int(record["spent"]) + 1
                record["phase"] = "implement"
                save_run(root, record)
                continue
            record["phase"] = "critic"
            phase = "critic"
        if phase == "critic":
            record["phase"] = "critic"
            save_run(root, record)
            diff = git(worktree, "diff", f"{target}...HEAD").stdout
            critic = invoke_role(commands["critic"], worktree, "critic", target, diff)
            if not verdict_passed(critic):
                record["spent"] = int(record["spent"]) + 1
                record["phase"] = "implement"
                save_run(root, record)
                continue
            record["phase"] = "ready"
            save_run(root, record)
            emit(ready_payload(branch, worktree))
            return 0


def execution_context(root: Path) -> tuple[dict, str] | int:
    if not (root / ".git").exists():
        return setup_error("not-a-repository")
    if not (root / ".agents" / "skills" / "gantry").is_dir():
        emit({"error": {"code": "pack-unreadable", "repository": str(root)}})
        return 2
    try:
        policy = resolve_policy(root)
    except ValueError as error:
        return setup_error(f"policy-invalid: {error}")
    if check_commands(policy):
        return setup_error("checks-invalid")
    target = policy["git"]["target"]
    if git(root, "rev-parse", "--verify", "--quiet", target).returncode != 0:
        return setup_error("target-missing")
    return policy, target


def require_commands(root: Path, policy: dict, roles: tuple[str, ...]) -> dict[str, Path] | int:
    commands = {role: role_command(root, policy, role) for role in roles}
    if any(path is None for path in commands.values()):
        return setup_error("role-command-missing")
    return commands  # type: ignore[return-value]


def execute_issue(root: Path, ref: str) -> int:
    prepared = execution_context(root)
    if isinstance(prepared, int):
        return prepared
    policy, target = prepared
    key = normalise_ref(ref) if ref else None
    issues = load_policy_issues(root, policy)
    issue = issues.get(key) if key else None
    if issue is None:
        return setup_error("issue-missing")
    spec = artifact_path(root, "specs", issue.spec)
    if not spec.is_file():
        return setup_error("spec-missing")
    commands = require_commands(root, policy, ("implement", "review", "critic"))
    if isinstance(commands, int):
        return commands
    branch = issue_branch(policy, issue)
    if git(root, "rev-parse", "--verify", "--quiet", branch).returncode == 0 or worktree_path(root, branch).exists():
        return setup_error("branch-exists")
    open_blockers = [blocker for blocker in issue.blocked_by if blocker not in issues or not issues[blocker].done]
    if open_blockers:
        emit({"error": {"code": "open-blocker", "openBlockers": open_blockers}})
        return 1
    worktree = create_worktree(root, branch, target)
    if worktree is None:
        return setup_error("worktree-create-failed")
    record = {
        "ref": issue.ref,
        "branch": branch,
        "phase": "implement",
        "spent": 0,
        "granted": correction_budget(policy),
    }
    save_run(root, record)
    emit({"event": "worktree", "branch": branch, "worktree": str(worktree), "pushed": False})
    return deliver(root, worktree, branch, target, policy, commands, record)


def next_issue_number(root: Path, policy: dict, slug: str) -> int:
    directory = root / policy["artifacts"]["issues"].format(slug=slug)
    numbers = [
        int(match.group(1))
        for path in directory.glob("*.md")
        if directory.is_dir() and (match := re.match(r"^(\d{2,})-", path.name))
    ]
    return max(numbers, default=0) + 1


def plan_environment(record: dict[str, object]) -> dict[str, str]:
    ref = str(record["ref"])
    slug, number = ref.split("#")
    return {
        "GANTRY_SLUG": slug,
        "GANTRY_ISSUE_NUMBER": number,
        "GANTRY_SPEC_PATH": str(record["specPath"]),
        "GANTRY_ISSUE_PATH": str(record["issuePath"]),
    }


def artifacts_ready(worktree: Path, record: dict[str, object]) -> bool:
    spec = record.get("specPath")
    issue = record.get("issuePath")
    if not isinstance(spec, str) or not isinstance(issue, str):
        return False
    return (worktree / spec).is_file() and (worktree / issue).is_file() and not tree_dirty(worktree)


def reject_plan(root: Path, worktree: Path, branch: str, ref: str) -> int:
    discard_worktree(root, worktree, branch)
    delete_run(root, ref)
    emit({"event": "rejected", "branch": branch, "pushed": False})
    return 1


def finish_plan(
    root: Path, worktree: Path, branch: str, target: str, policy: dict,
    commands: dict[str, Path], record: dict[str, object],
) -> int:
    environment = plan_environment(record)

    def call_plan() -> subprocess.CompletedProcess[str]:
        record["phase"] = "plan"
        save_run(root, record)
        return invoke_role(commands["plan"], worktree, "plan", target, "", environment)

    def plan_ready(completed: subprocess.CompletedProcess[str]) -> bool:
        return completed.returncode == 0 and not tree_dirty(worktree)

    if not artifacts_ready(worktree, record):
        completed = call_plan()
        if not plan_ready(completed):
            completed = call_plan()
        while not plan_ready(completed):
            answer = pause({
                "event": "pause", "reason": "plan-dirty", "choices": ["try-again", "reject"],
                "branch": branch, "worktree": str(worktree), "pushed": False,
            })
            if answer != "try-again":
                return reject_plan(root, worktree, branch, str(record["ref"]))
            completed = call_plan()
    record["phase"] = "plan-approval"
    save_run(root, record)
    answer = pause({
        "event": "pause", "reason": "plan-approval", "choices": ["approve", "reject"],
        "branch": branch, "worktree": str(worktree), "pushed": False,
    })
    if answer != "approve":
        return reject_plan(root, worktree, branch, str(record["ref"]))
    record["phase"] = "implement"
    record["spent"] = 0
    record["granted"] = correction_budget(policy)
    save_run(root, record)
    return deliver(root, worktree, branch, target, policy, commands, record)


def execute_plan(root: Path, slug: str) -> int:
    prepared = execution_context(root)
    if isinstance(prepared, int):
        return prepared
    policy, target = prepared
    spec = artifact_path(root, "specs", slug)
    issue_dir = root / policy["artifacts"]["issues"].format(slug=slug)
    if spec.is_file() or any(issue_dir.glob("*.md")):
        return setup_error("spec-or-issue-exists")
    commands = require_commands(root, policy, ("plan", "implement", "review", "critic"))
    if isinstance(commands, int):
        return commands
    number = next_issue_number(root, policy, slug)
    branch = render_branch(policy, slug, number)
    if git(root, "rev-parse", "--verify", "--quiet", branch).returncode == 0 or worktree_path(root, branch).exists():
        return setup_error("branch-exists")
    worktree = create_worktree(root, branch, target)
    if worktree is None:
        return setup_error("worktree-create-failed")
    ref = f"{slug}#{number:02d}"
    record = {
        "ref": ref,
        "branch": branch,
        "phase": "plan",
        "spent": 0,
        "granted": correction_budget(policy),
        "specPath": policy["artifacts"]["specs"].format(slug=slug),
        "issuePath": policy["artifacts"]["issues"].format(slug=slug).rstrip("/") + f"/{number:02d}-{slug}.md",
    }
    save_run(root, record)
    emit({"event": "worktree", "branch": branch, "worktree": str(worktree), "pushed": False})
    return finish_plan(root, worktree, branch, target, policy, commands, record)


def resume_run(root: Path, ref: str) -> int:
    checkout = primary_checkout(root)
    prepared = execution_context(checkout)
    if isinstance(prepared, int):
        return prepared
    policy, target = prepared
    key = normalise_ref(ref) if ref else None
    if key is None:
        return setup_error("issue-missing")
    record = load_run(checkout, key)
    if record is None:
        return setup_error("run-missing")
    branch = str(record["branch"])
    worktree = worktree_path(checkout, branch)
    if not worktree.is_dir():
        return setup_error("worktree-missing")
    if record.get("phase") == "ready":
        emit(ready_payload(branch, worktree))
        return 0
    if record.get("phase") in {"plan", "plan-approval"}:
        commands = require_commands(checkout, policy, ("plan", "implement", "review", "critic"))
        if isinstance(commands, int):
            return commands
        return finish_plan(checkout, worktree, branch, target, policy, commands, record)
    commands = require_commands(checkout, policy, ("implement", "review", "critic"))
    if isinstance(commands, int):
        return commands
    return deliver(checkout, worktree, branch, target, policy, commands, record)


def discard_issue(root: Path, ref: str) -> int:
    checkout = primary_checkout(root)
    prepared = execution_context(checkout)
    if isinstance(prepared, int):
        return prepared
    key = normalise_ref(ref) if ref else None
    if key is None:
        return setup_error("issue-missing")
    record = load_run(checkout, key)
    if record is None:
        return setup_error("run-missing")
    if record.get("phase") == "ready":
        return setup_error("not-interrupted")
    branch = str(record["branch"])
    discard_worktree(checkout, worktree_path(checkout, branch), branch)
    delete_run(checkout, key)
    emit({"event": "discarded", "branch": branch, "pushed": False})
    return 0


def approve_issue(root: Path, ref: str) -> int:
    checkout = primary_checkout(root)
    if not (checkout / ".git").exists():
        return setup_error("not-a-repository")
    if not (checkout / ".agents" / "skills" / "gantry").is_dir():
        emit({"error": {"code": "pack-unreadable", "repository": str(checkout)}})
        return 2
    try:
        policy = resolve_policy(checkout)
    except ValueError as error:
        return setup_error(f"policy-invalid: {error}")
    key = normalise_ref(ref) if ref else None
    if key is None:
        return setup_error("issue-missing")
    spec, number_text = key.split("#")
    branch = render_branch(policy, spec, int(number_text))
    worktree = worktree_path(checkout, branch)
    if not worktree.exists():
        return setup_error("worktree-missing")
    if tree_dirty(worktree):
        return setup_error("worktree-dirty")
    issues = load_policy_issues(worktree, policy)
    issue = issues.get(key)
    if issue is None:
        return setup_error("issue-missing")
    target = policy["git"]["target"]
    before = git(worktree, "rev-parse", "HEAD").stdout.strip()
    created = False
    if issue.status != "done":
        roadmap = Path(__file__).resolve().parent / "roadmap.py"
        closed = subprocess.run(
            [sys.executable, str(roadmap), "done", key],
            cwd=worktree, text=True, capture_output=True, check=False,
        )
        if closed.returncode != 0:
            return setup_error("close-failed")
        relative = issue.path.relative_to(worktree).as_posix()
        if git(worktree, "add", "--", "ROADMAP.md", relative).returncode != 0:
            return setup_error("close-failed")
        if git(worktree, "commit", "-qm", f"gantry: close {key}").returncode != 0:
            return setup_error("close-failed")
        created = git(worktree, "rev-parse", "HEAD").stdout.strip() != before
    if "origin" not in git(worktree, "remote").stdout.split():
        return setup_error("remote-missing")
    pushed = git(worktree, "push", "-u", "origin", f"HEAD:refs/heads/{branch}")
    if pushed.returncode != 0:
        return setup_error("push-failed")
    title = issue.title
    body = f"Close {key}.\n\nThe closing commit marks the Issue and the roadmap done.\n"
    pull = subprocess.run(
        ["gh", "pr", "create", "--base", target, "--head", branch, "--title", title, "--body", body],
        cwd=worktree, text=True, capture_output=True, check=False,
    )
    if pull.returncode != 0:
        return setup_error("pull-request-failed")
    emit({
        "event": "pull-request", "branch": branch, "target": target, "worktree": str(worktree),
        "pushed": True, "createdCommit": created, "url": pull.stdout.strip(),
    })
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", default=".", help="repository to inspect")
    parser.add_argument(
        "command",
        choices=("board", "issues", "specs", "frontier", "execute", "approve", "resume", "discard"),
        nargs="?", default="board",
    )
    parser.add_argument("issue", nargs="?")
    args = parser.parse_args(argv)
    root = repo_root(Path(args.cwd))
    if args.command == "execute":
        if not args.issue:
            return setup_error("issue-missing")
        if "#" not in args.issue:
            return execute_plan(root, args.issue)
        return execute_issue(root, args.issue)
    if args.command == "approve":
        if not args.issue:
            return setup_error("issue-missing")
        return approve_issue(root, args.issue)
    if args.command == "resume":
        if not args.issue:
            return setup_error("issue-missing")
        return resume_run(root, args.issue)
    if args.command == "discard":
        if not args.issue:
            return setup_error("issue-missing")
        return discard_issue(root, args.issue)
    pack = root / ".agents" / "skills" / "gantry"
    if not pack.is_dir():
        print(json.dumps({"error": {"code": "pack-unreadable", "repository": str(root)}}))
        return 2
    result = board(root)
    if args.command == "issues":
        result = {"issues": result["issues"]}
    elif args.command == "specs":
        result = {"specs": result["specs"]}
    elif args.command == "frontier":
        result = {"frontier": result["frontier"]}
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
