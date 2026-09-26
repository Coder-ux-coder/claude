#!/usr/bin/env python3
"""A scripted stand-in for Claude Code (`claude -p ...`) and Codex (`codex exec ...`).

It speaks the same wire formats (stream-json / exec JSONL), launches the team
tools exactly like the real CLIs do (from --mcp-config or -c mcp_servers.*),
keeps resumable session files in the account's profile folder, and follows a
simple "brain" so the orchestrator can be tested end to end. Faults are
injected through CREW_FAKE_SCENARIO (JSON):

  hang_on_task: [ids]        first time given this task: go silent forever
  crash_on_task: [ids]       first time: exit(1)
  limit_on_task: [ids]       first time: report the account's usage limit
  reject_task: [ids]         reviewer requests changes the first time
  outside_scope_task: [ids]  owner also edits shared.txt (forces a merge conflict)
  plan_changes: true         CEO requires plan changes once
  tasks: N                   number of feature tasks the lead creates (default 3)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

SCEN = json.loads(os.environ.get("CREW_FAKE_SCENARIO") or "{}")
STATE = Path(os.environ.get("CREW_FAKE_STATE") or "/tmp/crew-fake-state")
STATE.mkdir(parents=True, exist_ok=True)


def once(key: str) -> bool:
    """True the first time a key is seen across all fake processes."""
    marker = STATE / re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        return True
    except FileExistsError:
        return False


# ------------------------------------------------------------------ MCP client


class Mcp:
    def __init__(self, command: str, args: list[str], env: dict):
        self.p = subprocess.Popen([command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  env={**os.environ, **env}, text=True)
        self.n = 0
        self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "fake"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method: str, params: dict) -> dict:
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def call(self, name: str, **args) -> tuple[str, bool]:
        res = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        return res["content"][0]["text"], res["isError"]


# ------------------------------------------------------------------ git helpers


def sh(*cmd: str) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def write_and_commit(files: dict[str, str], message: str) -> None:
    for path, text in files.items():
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    sh("git", "add", "-A")
    sh("git", "commit", "-q", "-m", message)


# ----------------------------------------------------------------------- brain


class Brain:
    def __init__(self, emit, mcp: Mcp | None, seat: str, role: str):
        self.emit, self.mcp, self.seat, self.role = emit, mcp, seat, role

    def tool(self, name: str, **args) -> tuple[str, bool]:
        self.emit("tool_use", f"mcp__crew_team__{name}", args)
        text, err = self.mcp.call(name, **args)
        self.emit("tool_result", name, text)
        return text, err

    def turn(self, text: str) -> str:
        if "Turn the owner's request below into a precise brief" in text:
            return "BRIEF"
        if "senior reviewer with fresh eyes" in text:
            return self.review(text)
        if "CEO-level reviewer: the most capable model" in text:
            want = SCEN.get("plan_changes") and once("ceo-plan-changes")
            if want:
                self.tool("team_verdict", kind="plan", verdict="changes", notes="1. Split task 2 into smaller pieces.")
            else:
                self.tool("team_verdict", kind="plan", verdict="approve", notes="")
            return "verdict given"
        if "final acceptance review" in text:
            self.tool("team_verdict", kind="final", verdict="approve", notes="")
            return "final verdict"
        if "CEO-level decision maker" in text:
            self.tool("team_decide", text="Ruling: keep the current plan, split the stuck task.")
            return "ruled"
        if "You are the lead." in text or "owner's project starts now. You are the lead" in text:
            return self.plan()
        if "The CEO requires changes to the plan" in text:
            self.tool("team_plan_ready", summary="Revised plan after the CEO's review.")
            return "replanned"
        if m := re.search(r"Task #(\d+) is yours", text):
            return self.work(int(m.group(1)), text)
        if "Every task is merged" in text:
            (Path("REPORT_NOTE.txt")).write_text("verified\n")
            sh("git", "add", "-A")
            sh("git", "commit", "-q", "-m", "final touch")
            self.tool("team_project_done", report="We built the feature modules and verified each one with the tests. "
                                                  "Open the project folder to use it.")
            return "done"
        if "Save 2–4 lessons" in text:
            self.tool("team_lesson_add", category="process", lesson="Fake teams finish faster when tasks are small and independent.")
            return "lessons saved"
        if "is planning" in text and self.role == "member":
            if SCEN.get("concern") and once(f"concern-{self.seat}"):
                self.tool("team_chat_post", text="Concern: task sizes look large.", kind="concern")
            return "oriented"
        if "PROGRESS STALLED" in text:
            self.tool("team_decide", text="Replan: continue; reviewers will re-check.")
            return "replanned"
        return "ok"

    def plan(self) -> str:
        n = int(SCEN.get("tasks", 3))
        seats = [s.strip() for s in os.environ.get("CREW_FAKE_SEATS", "").split(",") if s.strip()]
        members = [s for s in seats if s != self.seat] or [self.seat]
        t, _ = self.tool("team_task_create", title="Foundation", spec="Create the package skeleton.",
                         acceptance="package imports", scope=["app/__init__.py"], size="S", kind="foundation",
                         suggested_owner=self.seat)
        found = int(re.search(r"#(\d+)", t).group(1))
        for i in range(1, n + 1):
            self.tool("team_task_create", title=f"Feature {i}", spec=f"Implement feature {i}.",
                      acceptance=f"feat{i}() returns {i}", scope=[f"app/feat{i}.py", f"tests/test_feat{i}.py"],
                      depends_on=[found], size="S", suggested_owner=members[(i - 1) % len(members)])
        self.tool("team_set_checks", commands=[f"{sys.executable} -m unittest discover -s tests -q"])
        self.tool("team_plan_ready", summary=f"Foundation then {n} independent features.")
        return "planned"

    def work(self, tid: int, text: str) -> str:
        if tid in SCEN.get("hang_on_task", []) and once(f"hang-{tid}"):
            time.sleep(10_000)
        if tid in SCEN.get("crash_on_task", []) and once(f"crash-{tid}"):
            sys.exit(1)
        if tid in SCEN.get("limit_on_task", []) and once(f"limit-{tid}"):
            return "LIMIT"
        detail, _ = self.tool("team_task_detail", task_id=tid)
        files = {}
        if "Foundation" in detail:
            files["app/__init__.py"] = "# package\n"
            files["tests/__init__.py"] = ""
        else:
            i = int(re.search(r"Feature (\d+)", detail).group(1))
            files[f"app/feat{i}.py"] = f"def feat{i}():\n    return {i}\n"
            files[f"tests/test_feat{i}.py"] = (f"import unittest\nfrom app.feat{i} import feat{i}\n\n\n"
                                               f"class T(unittest.TestCase):\n    def test(self):\n"
                                               f"        self.assertEqual(feat{i}(), {i})\n")
            if tid in SCEN.get("outside_scope_task", []):
                files["shared.txt"] = f"edited by {self.seat} for task {tid}\n"
        if "Merge conflict" in text:
            sh("git", "merge", "-X", "theirs", "--no-edit", os.environ.get("CREW_FAKE_INTEGRATION", ""))
            files.pop("shared.txt", None)
        write_and_commit(files, f"task {tid} by {self.seat}")
        self.tool("team_task_note", task_id=tid, note="Done: files written. Next: submit.")
        out = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"],
                             capture_output=True, text=True)
        self.tool("team_task_submit", task_id=tid, summary=f"Implemented task {tid} with a unit test.",
                  evidence=f"unittest exit {out.returncode}")
        return "submitted"

    def review(self, text: str) -> str:
        tid = int(re.search(r"Review task #(\d+)", text).group(1))
        if tid in SCEN.get("reject_task", []) and once(f"reject-{tid}"):
            self.tool("team_review_submit", task_id=tid, verdict="changes",
                      notes="1. app/feat.py: add a docstring and handle the edge case; re-run the tests.")
        else:
            self.tool("team_review_submit", task_id=tid, verdict="approve", notes="Looks correct; tests pass.")
        return "reviewed"


# ------------------------------------------------------------------- claude mode


def claude_main(argv: list[str]) -> int:
    def opt(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default

    stream_in = opt("--input-format") == "stream-json"
    model = opt("--model", "claude-opus-5-5")
    resume = opt("--resume")
    schema = opt("--json-schema")
    seat, role = os.environ.get("CREW_SEAT", "?"), os.environ.get("CREW_ROLE", "member")
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude-fake")
    sessdir = home / "projects" / re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
    mcp = None
    cfg = opt("--mcp-config")
    if cfg and Path(cfg).is_file():
        server = json.loads(Path(cfg).read_text())["mcpServers"]["crew_team"]
        mcp = Mcp(server["command"], server["args"], server.get("env", {}))

    def out(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    sid = resume or str(uuid.uuid4())
    if resume and not (sessdir / f"{sid}.jsonl").is_file():
        out({"type": "result", "subtype": "error_during_execution", "is_error": True,
             "result": f"No conversation found with session ID: {sid}", "session_id": sid})
        return 1
    out({"type": "system", "subtype": "init", "session_id": sid, "model": model, "cwd": os.getcwd(),
         "mcp_servers": [{"name": "crew_team", "status": "connected"}] if mcp else []})

    def emit(kind, name, payload):
        if kind == "tool_use":
            out({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": payload}]},
                 "session_id": sid})
        else:
            out({"type": "user", "message": {"content": [{"type": "tool_result", "content": str(payload)[:200]}]},
                 "session_id": sid})

    brain = Brain(emit, mcp, seat, role)
    account = home.name
    util_file = STATE / f"util-{account}"

    def run_turn(text: str) -> None:
        sessdir.mkdir(parents=True, exist_ok=True)
        with (sessdir / f"{sid}.jsonl").open("a") as fh:
            fh.write(json.dumps({"type": "user", "text": text[:500]}) + "\n")
        util = float(util_file.read_text()) if util_file.exists() else 0.1
        result = brain.turn(text)
        if result == "LIMIT":
            out({"type": "rate_limit_event", "rate_limit_info": {
                "status": "rejected", "resetsAt": int(time.time()) + 3600, "rateLimitType": "five_hour",
                "utilization": 1.0, "unifiedWindows": {"five_hour": {"utilization": 1.0, "resetsAt": int(time.time()) + 3600}}},
                "session_id": sid})
            out({"type": "result", "subtype": "error_during_execution", "is_error": True,
                 "result": "Claude AI usage limit reached|" + str(int(time.time()) + 3600), "session_id": sid})
            return
        util = min(0.95, util + 0.02)
        util_file.write_text(str(util))
        out({"type": "rate_limit_event", "rate_limit_info": {
            "status": "allowed", "rateLimitType": "five_hour", "utilization": util,
            "unifiedWindows": {"five_hour": {"utilization": util, "resetsAt": int(time.time()) + 4 * 3600},
                               "seven_day": {"utilization": util / 4, "resetsAt": int(time.time()) + 5 * 86400}}},
            "session_id": sid})
        payload = {"type": "result", "subtype": "success", "is_error": False, "result": result,
                   "usage": {"input_tokens": 1200, "output_tokens": 300, "cache_creation_input_tokens": 500},
                   "total_cost_usd": 0.02, "num_turns": 1, "duration_ms": 50, "session_id": sid}
        if schema:
            payload["structured_output"] = {
                "title": "Feature pack", "goal": "Build a small package of features with tests.",
                "deliverables": ["app package"], "acceptance_criteria": ["all tests pass"],
                "constraints": [], "assumptions": ["Python standard library only"]}
        out(payload)

    if stream_in:
        for line in sys.stdin:
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("type") != "user":
                continue
            content = msg["message"]["content"]
            text = content if isinstance(content, str) else "".join(b.get("text", "") for b in content)
            run_turn(text)
    else:
        run_turn(sys.stdin.read())
    return 0


# -------------------------------------------------------------------- codex mode


def codex_main(argv: list[str]) -> int:
    configs = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
    conf = {}
    for c in configs:
        key, _, value = c.partition("=")
        conf[key] = value
    command = json.loads(conf.get("mcp_servers.crew_team.command", "null") or "null")
    args = json.loads(conf.get("mcp_servers.crew_team.args", "[]"))
    env = {}
    table = conf.get("mcp_servers.crew_team.env", "{}").strip()[1:-1]
    for part in re.finditer(r'(\w+) = ("(?:[^"\\]|\\.)*")', table):
        env[part.group(1)] = json.loads(part.group(2))
    mcp = Mcp(command, args, env) if command else None
    seat, role = env.get("CREW_SEAT", "?"), env.get("CREW_ROLE", "member")
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex-fake")
    resume = "resume" in argv
    if resume:
        rest = [a for a in argv[argv.index("resume") + 1:] if not a.startswith("-")]
        positional = [a for i, a in enumerate(argv[argv.index("resume") + 1:]) if not a.startswith("-")
                      and argv[argv.index("resume") + i] != "-c"]
        tid = next(p for p in positional if re.fullmatch(r"[0-9a-f-]{36}", p))
    else:
        tid = str(uuid.uuid4())
    if "-C" in argv:
        os.chdir(argv[argv.index("-C") + 1])

    def out(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    out({"type": "thread.started", "thread_id": tid})
    out({"type": "turn.started"})

    def emit(kind, name, payload):
        if kind == "tool_use":
            out({"type": "item.started", "item": {"id": uuid.uuid4().hex[:8], "type": "mcp_tool_call", "tool": name}})

    text = sys.stdin.read()
    result = Brain(emit, mcp, seat, role).turn(text)
    if result == "LIMIT":
        out({"type": "turn.failed", "error": {"message": "You've hit your usage limit. Try again later."}})
        return 1
    day = time.strftime("%Y/%m/%d")
    rollout = home / "sessions" / day / f"rollout-2026-{tid}.jsonl"
    rollout.parent.mkdir(parents=True, exist_ok=True)
    with rollout.open("a") as fh:
        fh.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": 30.0, "window_minutes": 300, "resets_in_seconds": 7200},
            "secondary": {"used_percent": 10.0, "window_minutes": 10080, "resets_in_seconds": 400000}}}}) + "\n")
    out({"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": result}})
    out({"type": "turn.completed", "usage": {"input_tokens": 900, "cached_input_tokens": 0, "output_tokens": 200}})
    return 0


if __name__ == "__main__":
    mode = sys.argv[1]
    sys.exit(claude_main(sys.argv[2:]) if mode == "claude" else codex_main(sys.argv[2:]))
