#!/usr/bin/env python3
"""Append and query the machine-local, append-only Gantry Run log."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EVENTS = {
    "run.started",
    "run.resumed",
    "run.cancelled",
    "run.finished",
    "round.started",
    "round.finished",
    "phase.started",
    "phase.finished",
    "subagent.started",
    "subagent.stopped",
    "role.invocation.started",
    "role.invocation.finished",
    "role.result.ready",
    "role.result.consumed",
    "host.handoff",
    "compaction",
    "hook.denied",
    "hook.degraded",
    "policy.changed",
    "issue.done",
    "issue.blocked",
    "issue.paused",
    "refutation",
    "review.finding",
    "role.selected",
    "role.changed",
    "operator.approved",
    "operator.waiting",
}
RUN_EVENTS = {"run.started", "run.resumed", "run.cancelled", "run.finished"}
ROUND_EVENTS = {"round.started", "round.finished"}
PHASE_EVENTS = {"phase.started", "phase.finished"}
SUBAGENT_EVENTS = {"subagent.started", "subagent.stopped"}
ISSUE_EVENTS = {"issue.done", "issue.blocked", "issue.paused", "refutation", "review.finding", "role.selected", "role.changed", "operator.approved"}
FINISHED_EVENTS = {"run.cancelled", "run.finished"}
UNIT_ID_RE = re.compile(r"^[0-9a-f]{12}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
ISSUE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*#\d{2,}$")
PROHIBITED_KEY_TOKENS = {
    "command", "commands", "cmd", "diff", "diffs", "output", "outputs", "patch", "patches",
    "stderr", "stdout", "prompt", "prompts", "excerpt", "excerpts", "body", "bodies", "plan", "plans",
}
MEASUREMENT_INVOCATIONS = {"original", "replan", "reuse", "implementation", "correction", "review-fix"}
USAGE_PAIRS = {("actual", "provider"), ("estimate", "estimate"), ("unknown", "unavailable")}


class EventError(ValueError):
    """An event cannot safely be written to the Run log."""


def state_root(value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else Path.home() / ".gantry" / "state"


def unit_id(cwd: Path) -> str:
    """Derive the shared execution-unit identifier for a repository worktree."""
    try:
        common_dir = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise EventError(f"could not resolve Git common directory: {error}") from error
    path = Path(common_dir)
    real_common_dir = (cwd / path).resolve() if not path.is_absolute() else path.resolve()
    return hashlib.sha256(str(real_common_dir).encode("utf-8")).hexdigest()[:12]


def git_dir(cwd: Path) -> Path:
    """The *per-worktree* git directory of `cwd` (`.git`, or `.git/worktrees/<name>`).

    Unlike `unit_id`, which deliberately shares one identity across every worktree of a
    clone, this is the one directory git itself keeps per worktree -- which is exactly the
    keying a "current Run" marker needs, so two worktrees of one execution unit running
    different Runs concurrently never attribute a hook denial to each other's Run.
    """
    try:
        raw = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise EventError(f"could not resolve Git directory: {error}") from error
    path = Path(raw)
    return path.resolve() if path.is_absolute() else (cwd / path).resolve()


def marker_path(cwd: Path) -> Path:
    return git_dir(cwd) / "gantry" / "current-run.json"


def write_marker(cwd: Path, run: str, state_root_value: str | None) -> Path:
    """Record which Run is currently executing in this worktree."""
    if not RUN_ID_RE.fullmatch(run):
        raise EventError("run must contain only letters, numbers, dots, colons, underscores, or hyphens")
    path = marker_path(cwd)
    payload: dict[str, str] = {"run": run, "worktree": str(cwd.resolve())}
    if state_root_value:
        payload["stateRoot"] = str(state_root(state_root_value))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return path


def read_marker(cwd: Path) -> dict | None:
    """The current-Run marker of `cwd`'s worktree, or `None` when there is none to trust."""
    try:
        payload = json.loads(marker_path(cwd).read_text(encoding="utf-8"))
    except (EventError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    run = payload.get("run")
    if not isinstance(run, str) or not RUN_ID_RE.fullmatch(run):
        return None
    return payload


def clear_marker(cwd: Path) -> None:
    try:
        marker_path(cwd).unlink(missing_ok=True)
    except (EventError, OSError):
        return


def resolve_hook_run(cwd: Path) -> tuple[str | None, str | None]:
    """Resolve (run id, state root) for a hook process, environment first, marker second.

    A harness that exports `GANTRY_RUN_ID` into the hook's environment wins; otherwise the
    Run is read from this worktree's own current-Run marker, which the round workflow writes
    before any agent works in the worktree. This is what makes a `hook.denied` recording a
    guarantee rather than a best-effort: a git hook inherits its environment from whatever
    shelled out to `git`, but it always runs inside the worktree the marker describes.
    """
    env_state_root = os.environ.get("GANTRY_STATE_ROOT") or None
    env_run = os.environ.get("GANTRY_RUN_ID")
    if env_run and RUN_ID_RE.fullmatch(env_run):
        return env_run, env_state_root
    marker = read_marker(cwd)
    if not marker:
        return None, env_state_root
    marked_root = marker.get("stateRoot")
    return marker["run"], env_state_root or (marked_root if isinstance(marked_root, str) else None)


def require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EventError(f"{name} must be a non-empty string")
    return value


def require_positive_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise EventError(f"{name} must be a positive integer")
    return value


def validate_timestamp(value: object) -> None:
    timestamp = require_string(value, "ts")
    try:
        datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise EventError("ts must be an ISO 8601 timestamp") from error


def validate_sensitive_data(value: object, path: str = "data") -> None:
    """Reject command, output, diff, and patch fields at every nesting level."""
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise EventError(f"{path} keys must be strings")
            words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
            tokens = re.findall(r"[a-z]+", words.lower())
            if any(token in PROHIBITED_KEY_TOKENS for token in tokens):
                raise EventError(f"{path}.{key} must not be stored in the Run log")
            validate_sensitive_data(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            validate_sensitive_data(nested, f"{path}[{index}]")


def validate_secret_checks(value: object, path: str = "data") -> None:
    if isinstance(value, dict):
        if value.get("secrets") is True:
            permitted = {"secrets", "exitCode", "counts"}
            unexpected = sorted(set(value) - permitted)
            if unexpected:
                raise EventError(f"{path} for a secrets check may record only exitCode and counts")
            if "exitCode" not in value or "counts" not in value:
                raise EventError(f"{path} for a secrets check requires exitCode and counts")
            if not isinstance(value["exitCode"], int) or isinstance(value["exitCode"], bool):
                raise EventError(f"{path}.exitCode must be an integer")
            if not isinstance(value["counts"], dict):
                raise EventError(f"{path}.counts must be an object")
        for key, nested in value.items():
            validate_secret_checks(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            validate_secret_checks(nested, f"{path}[{index}]")


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def validate_measurement(measurement: object, path: str = "data.measurement") -> None:
    """Accept a sanitized phase measurement and refuse plan or prompt payloads."""
    if not isinstance(measurement, dict):
        raise EventError(f"{path} must be an object")
    unexpected = sorted(set(measurement) - {"invocation", "counted", "usage"})
    if unexpected:
        raise EventError(f"{path} must not store {', '.join(unexpected)}")
    invocation = measurement.get("invocation")
    if invocation not in MEASUREMENT_INVOCATIONS:
        raise EventError(f"{path}.invocation is not a measurement identity")
    if not isinstance(measurement.get("counted"), bool):
        raise EventError(f"{path}.counted must be a boolean")
    if invocation == "reuse" and measurement["counted"] is not False:
        raise EventError("a reused plan is not a counted invocation")
    if invocation != "reuse" and measurement["counted"] is not True:
        raise EventError(f"{path}.counted must be true for a new invocation")
    usage = measurement.get("usage")
    if not isinstance(usage, dict):
        raise EventError(f"{path}.usage must be an object")
    extra = sorted(set(usage) - {"classification", "provenance", "inputCount", "producedCount"})
    if extra:
        raise EventError(f"{path}.usage must not store {', '.join(extra)}")
    classification = usage.get("classification")
    provenance = usage.get("provenance")
    if (classification, provenance) not in USAGE_PAIRS:
        raise EventError(f"{path}.usage provenance does not match its classification")
    input_count = usage.get("inputCount")
    produced_count = usage.get("producedCount")
    if classification == "unknown":
        if input_count is not None or produced_count is not None:
            raise EventError("unknown usage cannot carry counts")
        return
    if _count(input_count) is None or _count(produced_count) is None:
        raise EventError(f"{path}.usage counts must be non-negative integers")


def validate_event(payload: object) -> dict:
    """Validate a stable event envelope before it reaches persistent state."""
    if not isinstance(payload, dict):
        raise EventError("event must be a JSON object")
    unknown = sorted(set(payload) - {"ts", "run", "event", "issue", "phase", "data"})
    if unknown:
        raise EventError(f"unknown event fields: {', '.join(unknown)}")
    for field in ("ts", "run", "event"):
        if field not in payload:
            raise EventError(f"event is missing required field: {field}")
    validate_timestamp(payload["ts"])
    run = require_string(payload["run"], "run")
    if not RUN_ID_RE.fullmatch(run):
        raise EventError("run must contain only letters, numbers, dots, colons, underscores, or hyphens")
    event = payload["event"]
    if event not in EVENTS:
        raise EventError(f"unknown event: {event!r}")
    if "issue" in payload:
        issue = require_string(payload["issue"], "issue")
        if not ISSUE_RE.fullmatch(issue):
            raise EventError("issue must be an Issue reference such as sample#01")
    if "phase" in payload:
        require_string(payload["phase"], "phase")
    data = payload.get("data")
    if data is not None and not isinstance(data, dict):
        raise EventError("data must be an object when supplied")
    validate_sensitive_data(data)
    validate_secret_checks(data)
    if isinstance(data, dict) and "measurement" in data:
        validate_measurement(data["measurement"])

    if event == "run.started":
        if "data" not in payload:
            raise EventError("run.started requires data")
        for field in ("repositoryRoot", "policyHash", "tier", "staleAfterSeconds"):
            if field not in data:
                raise EventError(f"run.started data is missing required field: {field}")
        require_string(data["repositoryRoot"], "data.repositoryRoot")
        require_string(data["policyHash"], "data.policyHash")
        require_string(data["tier"], "data.tier")
        require_positive_integer(data["staleAfterSeconds"], "data.staleAfterSeconds")
    elif event == "run.resumed" and isinstance(data, dict) and "hostTransition" in data:
        transition = data["hostTransition"]
        if not isinstance(transition, dict) or set(transition) != {"oldHost", "newHost", "confirmationSource", "tier"}:
            raise EventError("hostTransition must contain only oldHost, newHost, confirmationSource and tier")
        hosts = {"antigravity", "claude-code", "codex", "opencode"}
        if (transition["oldHost"] is not None and (not isinstance(transition["oldHost"], str) or transition["oldHost"] not in hosts)) or not isinstance(transition["newHost"], str) or transition["newHost"] not in hosts:
            raise EventError("hostTransition requires supported host identities")
        if transition["confirmationSource"] != "invocation:operator-approved":
            raise EventError("hostTransition requires sanitized operator confirmation provenance")
        if not isinstance(transition["tier"], str) or transition["tier"] not in {"reference", "supported", "compatible"}:
            raise EventError("hostTransition requires a declared support tier")
    elif event in ROUND_EVENTS:
        if not isinstance(data, dict) or "round" not in data:
            raise EventError(f"{event} requires data.round")
        require_positive_integer(data["round"], "data.round")
    elif event in PHASE_EVENTS:
        if "issue" not in payload or "phase" not in payload:
            raise EventError(f"{event} requires issue and phase")
    elif event in SUBAGENT_EVENTS:
        if not isinstance(data, dict) or "role" not in data:
            raise EventError(f"{event} requires data.role")
        require_string(data["role"], "data.role")
    elif event == "compaction":
        if not isinstance(data, dict) or "source" not in data:
            raise EventError("compaction requires data.source")
        require_string(data["source"], "data.source")
    elif event == "hook.denied":
        if not isinstance(data, dict) or not {"rule", "path"} <= set(data):
            raise EventError("hook.denied requires data.rule and data.path")
        require_string(data["rule"], "data.rule")
        require_string(data["path"], "data.path")
    elif event == "hook.degraded":
        if not isinstance(data, dict) or not {"source", "missing"} <= set(data):
            raise EventError("hook.degraded requires data.source and data.missing")
        require_string(data["source"], "data.source")
        missing = data["missing"]
        if not isinstance(missing, list) or not all(isinstance(item, str) and item for item in missing):
            raise EventError("data.missing must be a list of non-empty strings")
        if data.get("degraded") is not True:
            raise EventError("hook.degraded requires data.degraded to be true")
    elif event == "policy.changed":
        if not isinstance(data, dict) or "policyHash" not in data:
            raise EventError("policy.changed requires data.policyHash")
        require_string(data["policyHash"], "data.policyHash")
    elif event == "operator.waiting":
        if "issue" not in payload or not isinstance(data, dict) or data.get("decision") != "post_critic_integration":
            raise EventError("operator.waiting requires a configured integration decision")
    elif event == "issue.paused":
        if "issue" not in payload:
            raise EventError("issue.paused requires issue")
        if not isinstance(data, dict) or not {"role", "reason"} <= set(data):
            raise EventError("issue.paused requires data.role and data.reason")
        require_string(data["role"], "data.role")
        require_string(data["reason"], "data.reason")
    elif event in {"role.result.ready", "role.result.consumed", "host.handoff"}:
        required = {"role", "invocationId", "worktree", "branch", "revision", "modelProgress"}
        if "issue" not in payload or not isinstance(data, dict) or not required <= set(data):
            raise EventError(f"{event} requires attributable result metadata")
        for field in required - {"branch", "revision"}:
            require_string(data[field], f"data.{field}")
        for field in ("branch", "revision"):
            if data[field] is not None:
                require_string(data[field], f"data.{field}")
        if data["modelProgress"] != "unknown":
            raise EventError("model progress must remain unknown")
        if event == "host.handoff":
            if data.get("reason") not in {"operator_stop", "host_capability_lost", "authorized_handoff"}:
                raise EventError("host.handoff requires a supported boundary reason")
        else:
            require_string(data.get("resultHash"), "data.resultHash")
    elif event in {"role.invocation.started", "role.invocation.finished"}:
        required = {"role", "attempt", "cliVersion", "requestedSelection", "observedSelection", "permissionScope"}
        if not isinstance(data, dict) or not required <= set(data):
            raise EventError(f"{event} requires attributable invocation metadata")
        require_string(data["role"], "data.role")
        require_positive_integer(data["attempt"], "data.attempt")
        require_string(data["cliVersion"], "data.cliVersion")
        require_string(data["permissionScope"], "data.permissionScope")
        if not isinstance(data["requestedSelection"], dict) or not isinstance(data["observedSelection"], dict):
            raise EventError("invocation selections must be objects")
        if event == "role.invocation.finished":
            require_string(data.get("status"), "data.status")
    elif event == "role.selected":
        if "issue" not in payload:
            raise EventError("role.selected requires issue")
        if not isinstance(data, dict) or not {"role", "requested", "effective"} <= set(data):
            raise EventError("role.selected requires data.role, data.requested, and data.effective")
        require_string(data["role"], "data.role")
        if not isinstance(data["requested"], dict) or not isinstance(data["effective"], dict):
            raise EventError("data.requested and data.effective must be objects")
    elif event == "role.changed":
        if "issue" not in payload:
            raise EventError("role.changed requires issue")
        if not isinstance(data, dict) or not {"role", "requested", "effective"} <= set(data):
            raise EventError("role.changed requires data.role, data.requested, and data.effective")
        require_string(data["role"], "data.role")
        if not isinstance(data["requested"], dict) or not isinstance(data["effective"], dict):
            raise EventError("data.requested and data.effective must be objects")
    elif event in ISSUE_EVENTS and "issue" not in payload:
        raise EventError(f"{event} requires issue")
    return payload


def run_log_path(root: Path, unit: str, run: str) -> Path:
    return root / unit / "runs" / f"{run}.jsonl"


def append_event(path: Path, payload: dict) -> None:
    """Append a sub-64 KB JSONL event with exactly one write system call."""
    encoded = (json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > 64 * 1024:
        raise EventError("event exceeds the 64 KB atomic append limit")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        written = os.write(descriptor, encoded)
        if written != len(encoded):
            raise EventError("could not write a complete Run log event")
    finally:
        os.close(descriptor)


def read_valid_events(path: Path) -> list[dict]:
    events: list[dict] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return events
    for line in lines:
        try:
            payload = validate_event(json.loads(line))
        except (EventError, json.JSONDecodeError):
            continue
        if payload["run"] != path.stem:
            continue
        events.append(payload)
    return events


def inflight(root: Path, unit: str) -> list[dict]:
    """Derive unfinished Issue phases from valid events only."""
    result: list[dict] = []
    for path in sorted((root / unit / "runs").glob("*.jsonl")):
        events = read_valid_events(path)
        if not events or events[0]["event"] != "run.started":
            continue
        started = events[0]
        active: dict[str, dict] = {}
        finished = False
        for event in events[1:]:
            if event["event"] in FINISHED_EVENTS:
                finished = True
                continue
            if event["event"] == "phase.started":
                active[event["issue"]] = {
                    "run": event["run"],
                    "issue": event["issue"],
                    "phase": event["phase"],
                    "worktree": event.get("data", {}).get("worktree"),
                }
            elif event["event"] == "issue.paused":
                if event["issue"] in active:
                    if event.get("data", {}).get("worktree"):
                        active[event["issue"]]["worktree"] = event["data"]["worktree"]
                else:
                    active[event["issue"]] = {
                        "run": event["run"],
                        "issue": event["issue"],
                        "phase": event.get("phase") or "Critic",
                        "worktree": event.get("data", {}).get("worktree"),
                    }
            elif event["event"] == "phase.finished":
                active.pop(event["issue"], None)
            elif event["event"] in {"issue.done", "issue.blocked"}:
                active.pop(event["issue"], None)
        if not finished:
            for item in active.values():
                if isinstance(item["worktree"], str) and item["worktree"]:
                    result.append(
                        {
                            **item,
                            "repositoryRoot": started["data"]["repositoryRoot"],
                            "policyHash": started["data"]["policyHash"],
                            "tier": started["data"]["tier"],
                            "staleAfterSeconds": started["data"]["staleAfterSeconds"],
                        }
                    )
    return result


def derive_corrections_spent(events: list[dict], issue_ref: str) -> int:
    """Apply the documented derivation rule to one Run's own valid events.

    `runlog.py inflight` never reports `correctionsSpent`: it is derived here from (1) the
    legacy `run.resumed.data.correctionsSpent` base from the first `run.resumed` event on this Run,
    but only when that same
    `run.resumed` event also names `issue_ref` as `data.issue` (0 otherwise, including when the Run
    has no `run.resumed` event, or when its `run.resumed` names a different Issue), plus (2) the
    number of `refutation` events for `issue_ref` that are each followed, later in the same log, by a
    `phase.started` `Implement` event for that same Issue without `data.recovery=true` — i.e. only
    refutations whose correction pass actually started count toward the spent budget; replaying an
    already-started phase does not consume another attempt. Current same-Run resumptions omit a
    copied base; the first-event base is retained for legacy logs, and later resume events never
    add or replace it. The base is per-Issue, not per-Run: a Run
    resumed for one Issue must never lend its `correctionsSpent` base to any other Issue that also
    happens to appear in the same Run's log.
    """
    resumed = next((event for event in events if event["event"] == "run.resumed"), None)
    base = (
        resumed["data"].get("correctionsSpent", 0)
        if resumed and resumed["data"].get("issue") == issue_ref
        else 0
    )
    started_corrections = 0
    for index, event in enumerate(events):
        if event["event"] != "refutation" or event.get("issue") != issue_ref:
            continue
        later = events[index + 1 :]
        if any(
            later_event["event"] == "phase.started"
            and later_event.get("issue") == issue_ref
            and later_event.get("phase") == "Implement"
            and not later_event.get("data", {}).get("recovery")
            for later_event in later
        ):
            started_corrections += 1
    return base + started_corrections


def _unknown_usage() -> dict[str, object]:
    return {"classification": "unknown", "provenance": "unavailable", "inputCount": None, "producedCount": None}


def _duration_seconds(started: str, finished: str) -> float | None:
    try:
        start = datetime.datetime.fromisoformat(started.replace("Z", "+00:00"))
        end = datetime.datetime.fromisoformat(finished.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return (end - start).total_seconds()


def _usage_projection(measurement: object) -> dict[str, object]:
    if not isinstance(measurement, dict) or not isinstance(measurement.get("usage"), dict):
        return _unknown_usage()
    usage = measurement["usage"]
    classification = usage.get("classification")
    provenance = usage.get("provenance")
    if (classification, provenance) not in USAGE_PAIRS:
        return _unknown_usage()
    if classification == "unknown":
        return _unknown_usage()
    return {
        "classification": classification,
        "provenance": provenance,
        "inputCount": _count(usage.get("inputCount")),
        "producedCount": _count(usage.get("producedCount")),
    }


def _project_phase(issue: str, phase: str, started: dict | None, finished: dict | None) -> dict[str, object]:
    measurement = None
    for event in (finished, started):
        data = event.get("data") if isinstance(event, dict) else None
        if isinstance(data, dict) and isinstance(data.get("measurement"), dict):
            measurement = data["measurement"]
            break
    invocation = measurement.get("invocation") if isinstance(measurement, dict) else None
    counted = measurement.get("counted") if isinstance(measurement, dict) else None
    reuse = invocation == "reuse"
    completed = started is not None and finished is not None and not reuse
    duration = None
    if completed and isinstance(started, dict) and isinstance(finished, dict):
        duration = _duration_seconds(str(started.get("ts")), str(finished.get("ts")))
    return {
        "issue": issue,
        "phase": phase,
        "completed": completed,
        "startedAt": started.get("ts") if isinstance(started, dict) else None,
        "finishedAt": finished.get("ts") if isinstance(finished, dict) else None,
        "durationSeconds": duration,
        "invocation": invocation,
        "counted": counted if isinstance(counted, bool) else None,
        "usage": _usage_projection(measurement),
    }


def build_report(events: list[dict]) -> dict[str, object]:
    """Public Run report. Missing measurements stay unknown and reuse is not usage."""
    open_phases: dict[tuple[str, str], list[dict]] = {}
    phases: list[dict[str, object]] = []
    issues: set[str] = set()
    completed: set[str] = set()
    for event in events:
        issue = event.get("issue")
        if isinstance(issue, str) and ISSUE_RE.fullmatch(issue):
            issues.add(issue)
        if event.get("event") == "issue.done" and isinstance(issue, str):
            completed.add(issue)
        phase = event.get("phase")
        if not isinstance(issue, str) or not isinstance(phase, str):
            continue
        key = (issue, phase)
        if event.get("event") == "phase.started":
            open_phases.setdefault(key, []).append(event)
        elif event.get("event") == "phase.finished":
            pending = open_phases.get(key, [])
            started = pending.pop(0) if pending else None
            phases.append(_project_phase(issue, phase, started, event))
    for (issue, phase), pending in open_phases.items():
        for started in pending:
            phases.append(_project_phase(issue, phase, started, None))

    def counted(invocation: str, phase_name: str | None = None) -> int:
        return sum(
            1 for phase in phases
            if phase["counted"] is True and phase["invocation"] == invocation
            and (phase_name is None or phase["phase"] == phase_name)
        )

    actual_input = 0
    actual_produced = 0
    estimate_input = 0
    estimate_produced = 0
    actual_complete = True
    saw_actual = False
    saw_estimate = False
    saw_unknown = False
    for phase in phases:
        if phase["counted"] is not True:
            continue
        usage = phase["usage"]
        if not isinstance(usage, dict):
            actual_complete = False
            saw_unknown = True
            continue
        if usage["classification"] == "actual" and usage["inputCount"] is not None and usage["producedCount"] is not None:
            saw_actual = True
            actual_input += int(usage["inputCount"])
            actual_produced += int(usage["producedCount"])
        elif usage["classification"] == "estimate" and usage["inputCount"] is not None and usage["producedCount"] is not None:
            saw_estimate = True
            estimate_input += int(usage["inputCount"])
            estimate_produced += int(usage["producedCount"])
        else:
            actual_complete = False
            saw_unknown = True

    issue_reports = {
        issue: {
            "reviewFixPasses": sum(
                1 for phase in phases
                if phase["issue"] == issue and phase["invocation"] == "review-fix" and phase["counted"] is True
            ),
            "criticCorrectionAttempts": derive_corrections_spent(events, issue),
            "completionEvidence": issue in completed,
        }
        for issue in sorted(issues)
    }
    return {
        "phases": phases,
        "invocations": {
            "planning": counted("original", "Technical Plan"),
            "replanning": counted("replan", "Technical Plan"),
            "implementation": counted("implementation", "Implement"),
            "corrections": counted("correction", "Implement"),
        },
        "reusedPlans": sum(1 for phase in phases if phase["invocation"] == "reuse"),
        "reviewFixPasses": sum(item["reviewFixPasses"] for item in issue_reports.values()),
        "criticCorrectionAttempts": {
            issue: item["criticCorrectionAttempts"] for issue, item in issue_reports.items()
        },
        "issues": issue_reports,
        "usage": {
            "actual": {
                "inputCount": actual_input if saw_actual and actual_complete and not saw_unknown else None,
                "producedCount": actual_produced if saw_actual and actual_complete and not saw_unknown else None,
                "complete": bool(saw_actual and actual_complete and not saw_unknown),
            },
            "estimate": {
                "inputCount": estimate_input if saw_estimate else None,
                "producedCount": estimate_produced if saw_estimate else None,
                "present": saw_estimate,
            },
            "unknownPresent": not phases or saw_unknown or any(
                phase["counted"] is not False and isinstance(phase["usage"], dict)
                and phase["usage"]["classification"] == "unknown"
                for phase in phases
            ),
        },
        "claims": {"tokenSavings": None, "fasterDelivery": None, "fewerCorrections": None},
        "limitations": [
            "Missing token measurements stay unknown.",
            "Estimates are not actual provider usage.",
            "This report does not claim token savings, faster delivery, or fewer corrections.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    unit_parser = subparsers.add_parser("unit-id", help="print the current repository execution-unit ID")
    unit_parser.add_argument("--cwd", default=".", help="repository or worktree to inspect")
    unit_parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    append_parser = subparsers.add_parser("append", help="append one JSON event from standard input")
    append_parser.add_argument("unit_id", help="twelve-hex repository execution-unit ID")
    append_parser.add_argument("run_id", nargs="?", help="optional Run ID, which must match the event")
    append_parser.add_argument("--state-root", help="override ~/.gantry/state")
    query_parser = subparsers.add_parser("inflight", help="list interrupted Issue phases")
    query_parser.add_argument("unit_id", help="twelve-hex repository execution-unit ID")
    query_parser.add_argument("--state-root", help="override ~/.gantry/state")
    query_parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    results_parser = subparsers.add_parser("results", help="query observed result identities without role payloads")
    results_parser.add_argument("unit_id")
    results_parser.add_argument("run_id")
    results_parser.add_argument("--state-root")
    results_parser.add_argument("--json", action="store_true")
    results_parser.add_argument("--retained", action="store_true", help="include previously recorded Implement/Review contracts for reconciliation")
    corrections_parser = subparsers.add_parser(
        "corrections", help="derive correctionsSpent for one Issue from one Run's own log"
    )
    corrections_parser.add_argument("unit_id", help="twelve-hex repository execution-unit ID")
    corrections_parser.add_argument("run_id", help="the Run whose log to read")
    corrections_parser.add_argument("issue", help="Issue reference such as sample#01")
    corrections_parser.add_argument("--state-root", help="override ~/.gantry/state")
    corrections_parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    report_parser = subparsers.add_parser("report", help="report phase duration, usage and corrections without savings claims")
    report_parser.add_argument("unit_id", help="twelve-hex repository execution-unit ID")
    report_parser.add_argument("run_id", help="the Run whose log to read")
    report_parser.add_argument("--state-root", help="override ~/.gantry/state")
    report_parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    mark_parser = subparsers.add_parser("mark", help="record which Run is executing in this worktree")
    mark_parser.add_argument("run_id", help="the Run currently executing here")
    mark_parser.add_argument("--cwd", default=".", help="repository or worktree to mark")
    mark_parser.add_argument("--state-root", help="override ~/.gantry/state for hooks in this worktree")
    current_parser = subparsers.add_parser("current", help="print the Run marked as executing in this worktree")
    current_parser.add_argument("--cwd", default=".", help="repository or worktree to inspect")
    current_parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    unmark_parser = subparsers.add_parser("unmark", help="remove this worktree's current-Run marker")
    unmark_parser.add_argument("--cwd", default=".", help="repository or worktree to clear")
    args = parser.parse_args()

    try:
        if args.command == "mark":
            write_marker(Path(args.cwd).resolve(), args.run_id, args.state_root)
            return 0
        if args.command == "current":
            marker = read_marker(Path(args.cwd).resolve())
            if not marker:
                return 2
            print(json.dumps(marker, sort_keys=True) if args.json else marker["run"])
            return 0
        if args.command == "unmark":
            clear_marker(Path(args.cwd).resolve())
            return 0
        if args.command == "unit-id":
            value = unit_id(Path(args.cwd).resolve())
            payload = {"unitId": value}
            print(json.dumps(payload, sort_keys=True) if args.json else value)
            return 0
        if not UNIT_ID_RE.fullmatch(args.unit_id):
            raise EventError("unit-id must be exactly twelve lowercase hexadecimal characters")
        root = state_root(args.state_root)
        if args.command == "append":
            try:
                payload = json.loads(sys.stdin.read())
            except json.JSONDecodeError as error:
                raise EventError(f"standard input must contain one JSON event: {error.msg}") from error
            event = validate_event(payload)
            if args.run_id and event["run"] != args.run_id:
                raise EventError("positional run-id must match event.run")
            path = run_log_path(root, args.unit_id, event["run"])
            if path.exists() and event["event"] == "run.started":
                raise EventError("a Run log already starts for this run-id")
            if not path.exists() and event["event"] != "run.started":
                raise EventError("the first event of a Run must be run.started")
            if event["event"].startswith("role.result.") and any(prior["event"] in FINISHED_EVENTS for prior in read_valid_events(path)):
                raise EventError("closed Run cannot receive result observations")
            transition = event.get("data", {}).get("hostTransition")
            if transition:
                events = read_valid_events(path)
                previous = events[0].get("data", {}).get("host", {}).get("effectiveHost") if events else None
                for prior in events[1:]:
                    if prior["event"] == "run.resumed" and prior.get("data", {}).get("hostTransition"):
                        previous = prior["data"]["hostTransition"]["newHost"]
                if not events or any(e["event"] in FINISHED_EVENTS for e in events) or transition["oldHost"] != previous:
                    raise EventError("host transition must match the existing unfinished Run's host")
            append_event(path, event)
            return 0
        if args.command == "results":
            path = run_log_path(root, args.unit_id, args.run_id)
            if not path.exists():
                raise EventError(f"no Run log for {args.run_id}")
            events = read_valid_events(path)
            consumed = {event["data"]["invocationId"] for event in events if event["event"] == "role.result.consumed"}
            results = [{**event["data"], "issue": event["issue"], "consumed": event["data"]["invocationId"] in consumed}
                       for event in events if event["event"] == "role.result.ready"]
            payload = {"runId": args.run_id, "availability": "observed" if results else "unknown", "modelProgress": "unknown",
                       "finished": any(event["event"] in FINISHED_EVENTS for event in events), "results": results}
            if args.retained:
                retained = []
                for index, event in enumerate(events):
                    if event["event"] != "role.result.ready" or event["data"]["role"] not in {"implementer", "reviewer"}:
                        continue
                    for later in events[index + 1:]:
                        if later.get("issue") != event["issue"] or later.get("data", {}).get("role") != event["data"]["role"]:
                            continue
                        if later["event"] == "role.result.ready":
                            break
                        if later["event"] == "subagent.stopped" and isinstance(later["data"].get("result"), dict):
                            retained.append({**event["data"], "issue": event["issue"], "result": later["data"]["result"]})
                            break
                payload["retainedResults"] = retained
            print(json.dumps(payload, sort_keys=True))
            return 0
        if args.command == "corrections":
            if not ISSUE_RE.fullmatch(args.issue):
                raise EventError("issue must be an Issue reference such as sample#01")
            path = run_log_path(root, args.unit_id, args.run_id)
            if not path.exists():
                raise EventError(f"no Run log for {args.run_id}")
            events = read_valid_events(path)
            spent = derive_corrections_spent(events, args.issue)
            payload = {
                "unitId": args.unit_id,
                "runId": args.run_id,
                "issue": args.issue,
                "correctionsSpent": spent,
            }
            print(json.dumps(payload, sort_keys=True) if args.json else str(spent))
            return 0
        if args.command == "report":
            path = run_log_path(root, args.unit_id, args.run_id)
            if not path.exists():
                raise EventError(f"no Run log for {args.run_id}")
            payload = build_report(read_valid_events(path))
            print(json.dumps(payload, sort_keys=True) if args.json else json.dumps(payload["invocations"], sort_keys=True))
            return 0
        payload = {"unitId": args.unit_id, "inflight": inflight(root, args.unit_id)}
        print(json.dumps(payload, sort_keys=True) if args.json else "\n".join(
            f"{item['run']} {item['issue']} {item['phase']} {item['worktree']}" for item in payload["inflight"]
        ))
        return 0
    except EventError as error:
        print(f"runlog error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
