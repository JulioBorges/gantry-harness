"""Shared parsing and policy helpers for the Gantry workflow scripts."""
from __future__ import annotations

import copy
import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_POLICY = {
    "artifacts": {
        "specs": ".scratch/{slug}/spec.md",
        "issues": ".scratch/{slug}/issues",
        "adrs": "docs/adr",
        "decisions": "docs/adr",
        "context": "CONTEXT.md",
        "issueTracker": "docs/agents/issue-tracker.md",
    },
    "templates": {"dir": ".gantry/templates", "headingMap": {}},
    "checks": [],
    "git": {
        "target": "main",
        "prefix": "gantry/",
        "issueBranch": "{prefix}{spec}-{number:02d}",
    },
    "delivery": {
        "strategy": "branch-merge",
    },
    "hooks": {"record": [], "deny": []},
    "budget": {"corrections": 2, "contextShare": 0.15},
    "dashboard": {"staleAfterSeconds": 900},
    "caveman": False,
    "execution": {"roles": {}},
}

SUPPORTED_HARNESSES = {"antigravity", "claude-code", "codex", "opencode"}

PROHIBITED_PROFILE_KEY_TOKENS = {
    "token", "tokens", "key", "keys", "secret", "secrets", "auth",
    "password", "passwords", "credential", "credentials", "transcript",
    "transcripts", "output", "outputs", "command", "commands",
    "diff", "diffs", "env", "environment",
}

REF_RE = re.compile(r"`?([a-z0-9][a-z0-9-]*)#(\d{2,})`?")
STATUS_RE = re.compile(r"^Status:\s*(.+?)\s*$", re.MULTILINE)
SLICE_RE = re.compile(r"^Slice:\s*`?([a-z0-9-]+#\d+)`?\s*$", re.MULTILINE)
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
CHECKBOX_RE = re.compile(r"^(\s*)- \[( |x|X)\]\s+(.*)$")
ISSUE_FILE_RE = re.compile(r"^(\d{2,})-[a-z0-9-]+\.md$")
DONE_STATUSES = {"done"}
PARKED_STATUSES = {"blocked", "needs-operator", "draft"}


def repo_root(start: Path | None = None) -> Path:
    """Find the enclosing repository, including linked worktrees."""
    path = (start or Path.cwd()).resolve()
    for candidate in [path, *path.parents]:
        if (candidate / ".git").exists():
            return candidate
    return path


def _merge_policy(base: dict, overlay: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        result[key] = _merge_policy(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else copy.deepcopy(value)
    return result


def resolve_policy(root: Path | None = None) -> dict:
    """Overlay optional repository policy onto portable pack defaults."""
    root = repo_root(root)
    path = root / ".gantry" / "config.json"
    if not path.exists():
        return copy.deepcopy(DEFAULT_POLICY)
    try:
        overlay = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(overlay, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return _merge_policy(DEFAULT_POLICY, overlay)


def profile_root(env: dict[str, str] | None = None) -> Path:
    env_map = env if env is not None else os.environ
    custom = env_map.get("GANTRY_PROFILE_ROOT")
    if custom:
        return Path(custom).resolve()
    return (Path.home() / ".gantry" / "profiles").resolve()


def profile_dir(root: Path, custom_profile_root: Path | None = None) -> Path:
    import runlog
    base = custom_profile_root.resolve() if custom_profile_root else profile_root()
    uid = runlog.unit_id(root)
    return base / uid


def profile_path(root: Path, custom_profile_root: Path | None = None) -> Path:
    return profile_dir(root, custom_profile_root) / "execution.json"


def validate_profile(profile_data: dict[str, Any]) -> None:
    if not isinstance(profile_data, dict):
        raise ValueError("Profile must be a JSON object")

    def _check_keys(d: dict):
        for k, v in d.items():
            k_lower = k.lower()
            for token in PROHIBITED_PROFILE_KEY_TOKENS:
                if token in k_lower:
                    raise ValueError(f"Prohibited key '{k}' in profile")
            if isinstance(v, dict):
                _check_keys(v)

    _check_keys(profile_data)

    allowed_top = {"hostHarness", "roles"}
    unexpected = set(profile_data.keys()) - allowed_top
    if unexpected:
        raise ValueError(f"Unexpected top-level keys in profile: {sorted(unexpected)}")

    host = profile_data.get("hostHarness")
    if host is not None:
        if not isinstance(host, str) or host not in SUPPORTED_HARNESSES:
            raise ValueError(f"Unsupported profile hostHarness: {host}")

    roles = profile_data.get("roles")
    if roles is not None:
        if not isinstance(roles, dict):
            raise ValueError("Profile roles must be an object")
        allowed_role_keys = {"harness", "model", "effort"}
        for r_name, r_val in roles.items():
            if not isinstance(r_val, dict):
                raise ValueError(f"Role '{r_name}' in profile must be an object")
            extra = set(r_val.keys()) - allowed_role_keys
            if extra:
                raise ValueError(f"Unexpected fields in role '{r_name}': {sorted(extra)}")
            h = r_val.get("harness")
            if h is not None and (not isinstance(h, str) or h not in SUPPORTED_HARNESSES):
                raise ValueError(f"Unsupported harness '{h}' in role '{r_name}'")
            m = r_val.get("model")
            if m is not None and not isinstance(m, str):
                raise ValueError(f"Model in role '{r_name}' must be a string")
            eff = r_val.get("effort")
            if eff is not None and not isinstance(eff, str):
                raise ValueError(f"Effort in role '{r_name}' must be a string")


def read_profile(root: Path, custom_profile_root: Path | None = None) -> dict[str, Any]:
    try:
        path = profile_path(root, custom_profile_root)
    except Exception:
        return {}
    if not path.exists():
        return {}
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid profile JSON at {path}: {exc}") from exc
    validate_profile(content)
    return content


def write_profile(root: Path, profile_data: dict[str, Any], custom_profile_root: Path | None = None) -> Path:
    validate_profile(profile_data)
    path = profile_path(root, custom_profile_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile_data, indent=2) + "\n", encoding="utf-8")
    return path


def resolve_effective_template(root: Path | None, kind: str) -> Path:
    """Locate a repository template, falling back to the pack default."""
    if kind not in {"spec", "prd", "issue"}:
        raise ValueError(f"unknown template kind: {kind}")
    root = repo_root(root)
    configured = root / resolve_policy(root)["templates"]["dir"] / f"{kind}.md"
    if configured.exists():
        return configured
    return Path(__file__).resolve().parent.parent / "templates" / f"{kind}.md"


def resolve_heading_map(root: Path | None = None) -> dict[str, str]:
    """Return policy-declared equivalent headings as canonical Markdown headings."""
    raw_map = resolve_policy(root)["templates"].get("headingMap", {})
    if not isinstance(raw_map, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in raw_map.items()):
        raise ValueError("templates.headingMap must map heading strings to heading strings")

    def heading(value: str) -> str:
        value = value.strip()
        return value if value.startswith("## ") else f"## {value.lstrip('#').strip()}"

    return {heading(alias): heading(canonical) for alias, canonical in raw_map.items()}


def resolve_workflow_paths(root: Path, slug: str) -> dict[str, Path]:
    """Render the effective policy's repository paths for a workflow run."""
    root = repo_root(root)
    artifacts = resolve_policy(root)["artifacts"]

    def render(name: str) -> Path:
        return root / artifacts[name].format(slug=slug)

    issue_dir = render("issues")
    existing = sorted(issue_dir.glob("*.md"))
    return {
        "specPath": render("specs"),
        "issueDir": issue_dir,
        "exemplarIssue": existing[0] if existing else render("issueTracker"),
        "decisions": render("decisions"),
        "issueTracker": render("issueTracker"),
        "context": render("context"),
        "adrs": render("adrs"),
    }


def artifact_path(root: Path, name: str, slug: str) -> Path:
    """Render one effective artifact path for an Issue's parent Spec."""
    root = repo_root(root)
    return root / resolve_policy(root)["artifacts"][name].format(slug=slug)


def load_policy_issues(root: Path, policy: dict | None = None) -> dict[str, Issue]:
    """Load Issue files from the policy's rendered, slug-aware issue directory."""
    root = repo_root(root)
    effective = policy or resolve_policy(root)
    pattern = effective["artifacts"]["issues"].format(slug="*").rstrip("/")
    issues: dict[str, Issue] = {}
    for path in sorted(root.glob(f"{pattern}/*.md")):
        if ISSUE_FILE_RE.match(path.name):
            issue = parse_issue(path)
            issues[issue.ref] = issue
    return issues


def policy_spec_numbers(root: Path, policy: dict | None = None) -> dict[str, int]:
    """Read Spec numbers from the policy's rendered, slug-aware spec paths."""
    root = repo_root(root)
    effective = policy or resolve_policy(root)
    template = effective["artifacts"]["specs"]
    pattern = template.format(slug="*")
    slug_matcher = re.compile("^" + re.escape(template).replace(re.escape("{slug}"), r"(?P<slug>[^/]+)") + "$")
    result: dict[str, int] = {}
    for path in sorted(root.glob(pattern)):
        match = re.search(r"\(spec\s+(\d+)", path.read_text(encoding="utf-8"))
        if match:
            relative = path.relative_to(root).as_posix()
            slug = slug_matcher.match(relative)
            if slug:
                result[slug.group("slug")] = int(match.group(1))
    return result


def section(text: str, heading: str) -> str:
    """Return a level-two Markdown section body."""
    match = re.search(rf"^##\s+{re.escape(heading)}\s*$", text, re.MULTILINE | re.IGNORECASE)
    if not match:
        return ""
    rest = text[match.end():]
    next_heading = re.search(r"^##\s+", rest, re.MULTILINE)
    return rest[:next_heading.start()] if next_heading else rest


@dataclass
class Criterion:
    index: int
    text: str
    checked: bool
    line_no: int


@dataclass
class Issue:
    ref: str
    spec: str
    number: int
    path: Path
    title: str
    status: str
    blocked_by: list[str] = field(default_factory=list)
    criteria: list[Criterion] = field(default_factory=list)

    @property
    def done(self) -> bool:
        return self.status.lower() in DONE_STATUSES

    @property
    def parked(self) -> bool:
        return self.status.lower() in PARKED_STATUSES

    def to_dict(self, root: Path) -> dict:
        return {
            "ref": self.ref, "spec": self.spec, "number": self.number,
            "path": str(self.path.relative_to(root)), "title": self.title,
            "status": self.status, "blocked_by": self.blocked_by,
            "criteria_total": len(self.criteria),
            "criteria_checked": sum(criterion.checked for criterion in self.criteria),
        }


def parse_criteria(text: str) -> list[Criterion]:
    body = section(text, "Acceptance criteria")
    if not body:
        return []
    start_line = text[:text.index(body)].count("\n")
    criteria: list[Criterion] = []
    for offset, line in enumerate(body.splitlines()):
        match = CHECKBOX_RE.match(line)
        if match:
            criteria.append(Criterion(len(criteria) + 1, match.group(3).strip(), match.group(2).lower() == "x", start_line + offset + 1))
    return criteria


def parse_blocked_by(text: str, own_spec: str) -> list[str]:
    refs: list[str] = []
    for line in section(text, "Blocked by").splitlines():
        if line.strip().startswith("-"):
            for spec, number in REF_RE.findall(line):
                ref = f"{spec}#{int(number):02d}"
                if ref not in refs:
                    refs.append(ref)
    return refs


def parse_issue(path: Path) -> Issue:
    path = path.resolve()
    text = path.read_text(encoding="utf-8")
    spec = path.parent.parent.name
    file_match = ISSUE_FILE_RE.match(path.name)
    number = int(file_match.group(1)) if file_match else 0
    ref_match = SLICE_RE.search(text)
    raw_ref = ref_match.group(1) if ref_match else f"{spec}#{number:02d}"
    ref_spec, raw_number = raw_ref.split("#")
    ref = f"{ref_spec}#{int(raw_number):02d}"
    title = TITLE_RE.search(text)
    status = STATUS_RE.search(text)
    return Issue(ref, ref_spec, int(raw_number), path, title.group(1) if title else path.stem,
                 status.group(1) if status else "unknown", parse_blocked_by(text, ref_spec), parse_criteria(text))


def issue_branch(policy: dict, issue: Issue) -> str:
    """Render the policy's branch name for an Issue."""
    template = policy["git"]["issueBranch"]
    try:
        branch = template.format(
            prefix=policy["git"]["prefix"],
            spec=issue.spec,
            number=issue.number,
        )
    except (AttributeError, KeyError, ValueError) as exc:
        raise ValueError("git.issueBranch must use only {prefix}, {spec}, and {number}") from exc
    if not branch:
        raise ValueError("git.issueBranch must render a non-empty branch name")
    return branch


def load_issues(scratch: Path) -> dict[str, Issue]:
    issues: dict[str, Issue] = {}
    for directory in sorted(scratch.glob("*/issues")):
        for path in sorted(directory.glob("*.md")):
            if ISSUE_FILE_RE.match(path.name):
                issue = parse_issue(path)
                issues[issue.ref] = issue
    return issues


def normalise_ref(raw: str) -> str | None:
    match = REF_RE.fullmatch(raw.strip().strip("`"))
    return f"{match.group(1)}#{int(match.group(2)):02d}" if match else None


def resolve_issue_arg(arg: str, root: Path, issues: dict[str, Issue]) -> Issue | None:
    ref = normalise_ref(arg)
    if ref and ref in issues:
        return issues[ref]
    path = Path(arg)
    path = path if path.is_absolute() else root / path
    return parse_issue(path) if path.exists() else None


def roadmap_waves(roadmap_text: str) -> dict[int, list[str]]:
    waves: dict[int, list[str]] = {}
    current: int | None = None
    for line in roadmap_text.splitlines():
        match = re.match(r"^###\s+Wave\s+(\d+)", line)
        if match:
            current = int(match.group(1))
            waves.setdefault(current, [])
            continue
        item = re.match(r"^- \[( |x|X)\] \*\*`([a-z0-9-]+#\d+)`\*\*", line)
        if item and current is not None:
            spec, number = item.group(2).split("#")
            waves[current].append(f"{spec}#{int(number):02d}")
    return waves


def spec_numbers(scratch: Path) -> dict[str, int]:
    result: dict[str, int] = {}
    for spec in sorted(scratch.glob("*/spec.md")):
        match = re.search(r"\(spec\s+(\d+)", spec.read_text(encoding="utf-8"))
        if match:
            result[spec.parent.name] = int(match.group(1))
    return result


def issue_levels(issues: dict[str, Issue]) -> dict[str, int]:
    levels: dict[str, int] = {}
    visiting: set[str] = set()

    def depth(ref: str) -> int:
        if ref in levels:
            return levels[ref]
        if ref in visiting:
            raise ValueError(f"dependency cycle through {ref}")
        visiting.add(ref)
        blockers = [blocker for blocker in issues[ref].blocked_by if blocker in issues]
        levels[ref] = 0 if not blockers else 1 + max(depth(blocker) for blocker in blockers)
        visiting.remove(ref)
        return levels[ref]

    for reference in sorted(issues):
        depth(reference)
    return levels


def main() -> int:
    """Print the portable policy and rendered workflow paths."""
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--cwd", default=".", help="repository or worktree to inspect")
    parser.add_argument("--scope-slug", default="sample", help="slug used to render artifact paths")
    parser.add_argument("--issue", help="Issue reference or path whose configured branch to render")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = repo_root(Path(args.cwd))
    paths = resolve_workflow_paths(root, args.scope_slug)
    payload = {
        "repo_root": str(root),
        "policy": resolve_policy(root),
        "paths": {name: str(path) for name, path in paths.items()},
    }
    if args.issue:
        issue = resolve_issue_arg(args.issue, root, load_policy_issues(root, payload["policy"]))
        if issue is None:
            raise ValueError(f"could not resolve Issue {args.issue!r}")
        payload["issueBranch"] = issue_branch(payload["policy"], issue)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"repo_root: {payload['repo_root']}")
        if "issueBranch" in payload:
            print(f"issue_branch: {payload['issueBranch']}")
        for name, path in payload["paths"].items():
            print(f"{name}: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
