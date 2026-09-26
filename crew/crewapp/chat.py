"""The Assistant: a Claude conversation (through Claude Code, on your subscription) that
answers, researches, uses the app's browser and your phone, and creates files you
can preview. Replies stream word by word to the app."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from crewlib import config as cfgmod
from crewlib.agents import CREW_ROOT, _kill_tree, _popen, child_env, which
from crewlib.util import atomic_write, clip, crew_home, now

from . import settings as settings_mod
from .sse import hub

DEFAULT_INSTRUCTIONS = """You are the owner's personal assistant inside the Crew app.

The owner is not technical. Answer in plain, warm, precise language. Keep code out of your answers unless asked;
if you build something, describe what it does and how to use it.

- When you make something the owner will look at (a web page, a document, a chart, a table), save it as a file in
  the current folder (for example page.html or summary.md). The app shows new files in a preview panel.
- You can browse the web in the app's own browser with the browser_* tools; the owner watches it live. Prefer it
  for tasks that need clicking, forms or logging in. Use web search for quick facts.
- You can operate the owner's Android phone with the phone_* tools, and their Windows computer (screen, mouse,
  keyboard, apps) with the computer_* tools, when they ask. Take a screenshot before acting and check the result
  after each step. Describe what you are about to do before anything that sends messages, spends money or deletes
  something, and ask first. If the owner pauses computer control, stop and ask.
- For a big build job (an app, a website with several parts, a larger program), suggest turning the conversation into
  a team project with the "Build this with the team" button.
- Keep answers short unless depth is asked for. Use headings and bullet points for anything longer than a paragraph.
"""

FRIENDLY = [
    ("mcp__crew_devices__browser", "Using the browser"),
    ("mcp__crew_devices__phone", "Using your phone"),
    ("mcp__crew_devices__computer", "Using your computer"),
    ("WebSearch", "Searching the web"),
    ("WebFetch", "Reading a web page"),
    ("Read", "Reading"),
    ("Write", "Writing"),
    ("Edit", "Writing"),
    ("NotebookEdit", "Writing"),
    ("Bash", "Working on the computer"),
    ("PowerShell", "Working on the computer"),
    ("Glob", "Looking through files"),
    ("Grep", "Looking through files"),
    ("Task", "Asking a helper"),
    ("Agent", "Asking a helper"),
    ("TodoWrite", "Planning"),
    ("ToolSearch", "Getting ready"),
    ("Skill", "Using a skill"),
]


def friendly_tool(name: str) -> str:
    for prefix, label in FRIENDLY:
        if name.startswith(prefix):
            return label
    return "Working"


def instructions_path() -> Path:
    return crew_home() / "assistant.md"


def instructions() -> str:
    p = instructions_path()
    if not p.is_file():
        atomic_write(p, DEFAULT_INSTRUCTIONS)
    return p.read_text(encoding="utf-8")


def save_instructions(text: str) -> None:
    atomic_write(instructions_path(), (text or DEFAULT_INSTRUCTIONS).rstrip() + "\n")


# ------------------------------------------------------------------ storage


class ChatDB:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(str(path), timeout=30, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.RLock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, created REAL, updated REAL,
                session_id TEXT, model TEXT, effort TEXT);
            CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT,
                text TEXT, ts REAL, meta TEXT);
            CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id);
        """)

    def q(self, sql: str, args=()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def x(self, sql: str, args=()) -> int:
        with self._lock:
            return int(self.db.execute(sql, args).lastrowid or 0)


class ChatSession:
    """One long-lived Claude Code process for one conversation."""

    def __init__(self, manager: "ChatManager", chat: dict):
        self.m, self.chat_id = manager, chat["id"]
        self.session_id = chat.get("session_id")
        self.model, self.effort = chat.get("model"), chat.get("effort")
        self.proc = None
        self.busy = False
        self.buffer = ""
        self.tools: list[str] = []
        self.turn_started = 0.0
        self._lock = threading.Lock()

    @property
    def topic(self) -> str:
        return f"chat:{self.chat_id}"

    def workspace(self) -> Path:
        path = crew_home() / "chats" / self.chat_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self) -> None:
        exe = which("claude")
        if not exe:
            raise RuntimeError("Claude Code is not installed on this computer yet. Run the Crew installer.")
        app = settings_mod.load()
        cfg = cfgmod.load(str(settings_mod.path()) if settings_mod.path().is_file() else None)
        cfg.models.check(self.model)
        account = self.m.pick_account(cfg)
        files = self.workspace() / ".crew"
        files.mkdir(exist_ok=True)
        (files / "system.md").write_text(instructions(), encoding="utf-8")
        mcp = {"mcpServers": {}}
        if self.m.app_url:
            import sys
            mcp["mcpServers"]["crew_devices"] = {
                "type": "stdio", "command": sys.executable, "args": ["-m", "crewapp.devices_mcp"],
                "env": {"CREW_APP_URL": self.m.app_url, "CREW_APP_TOKEN": self.m.app_token,
                        "PYTHONPATH": str(CREW_ROOT)}}
        (files / "mcp.json").write_text(json.dumps(mcp), encoding="utf-8")
        (files / "settings.json").write_text(json.dumps({"model": self.model}), encoding="utf-8")
        cmd = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--include-partial-messages", "--model", self.model, "--effort", self.effort,
               "--append-system-prompt-file", str(files / "system.md"),
               "--mcp-config", str(files / "mcp.json"), "--strict-mcp-config",
               "--settings", str(files / "settings.json"),
               "--permission-mode", app["team"].get("permission_mode") or "bypassPermissions"]
        pack = crew_home() / "skills-active"
        if (pack / ".claude-plugin" / "plugin.json").is_file():
            cmd += ["--plugin-dir", str(pack)]
        if self.session_id:
            cmd += ["--resume", self.session_id]
        env = {"CLAUDE_CODE_SUBAGENT_MODEL": cfg.models.work, "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1",
               "ANTHROPIC_DEFAULT_HAIKU_MODEL": cfg.models.work, "DISABLE_AUTOUPDATER": "1"}
        prof = account.profile_dir() if account else None
        if prof is not None:
            prof.mkdir(parents=True, exist_ok=True)
            env["CLAUDE_CONFIG_DIR"] = str(prof)
        from crewlib.util import load_env_file
        secrets = {k: v for k, v in load_env_file(settings_mod.secrets_path()).items() if k != "ANTHROPIC_API_KEY"}
        self.proc = _popen(cmd, self.workspace(), child_env({**secrets, **env}))
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        threading.Thread(target=lambda p=self.proc: [None for _ in p.stderr], daemon=True).start()

    def send(self, text: str, model: str, effort: str) -> None:
        with self._lock:
            if self.busy:
                raise RuntimeError("Still answering the last message.")
            if self.alive() and (model != self.model or effort != self.effort):
                self.stop_process()
            self.model, self.effort = model, effort
            if not self.alive():
                self._start()
            self.busy, self.buffer, self.tools = True, "", []
            self.turn_started = now()
            msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                   "parent_tool_use_id": None, "session_id": self.session_id or ""}
            self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        hub.publish(self.topic, "start", {})

    def interrupt(self) -> None:
        if self.alive():
            try:
                self.proc.stdin.write(json.dumps({"type": "control_request", "request_id": uuid.uuid4().hex,
                                                  "request": {"subtype": "interrupt"}}) + "\n")
                self.proc.stdin.flush()
            except (OSError, ValueError):
                pass

    def stop_process(self) -> None:
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            _kill_tree(self.proc, grace=2)
        self.proc = None

    def _read(self, proc) -> None:
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            kind = msg.get("type")
            if kind == "system" and msg.get("subtype") == "init":
                self.session_id = msg.get("session_id") or self.session_id
                self.m.db.x("UPDATE chats SET session_id=? WHERE id=?", (self.session_id, self.chat_id))
            elif kind == "stream_event":
                ev = msg.get("event") or {}
                if msg.get("parent_tool_use_id"):
                    continue  # a helper's inner text is not the answer
                if ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                    piece = ev["delta"].get("text") or ""
                    self.buffer += piece
                    hub.publish(self.topic, "delta", {"text": piece})
                elif ev.get("type") == "content_block_start" and (ev.get("content_block") or {}).get("type") == "text" \
                        and self.buffer and not self.buffer.endswith("\n"):
                    self.buffer += "\n\n"
                    hub.publish(self.topic, "delta", {"text": "\n\n"})
            elif kind == "assistant" and not msg.get("parent_tool_use_id"):
                for block in (msg.get("message") or {}).get("content") or []:
                    if block.get("type") == "tool_use":
                        label = friendly_tool(block.get("name", ""))
                        if not self.tools or self.tools[-1] != label:
                            self.tools.append(label)
                            hub.publish(self.topic, "tool", {"label": label})
            elif kind == "rate_limit_event":
                self.m.rate[self.m.chat_account or ""] = msg.get("rate_limit_info") or {}
            elif kind == "result":
                self._finish(msg)
        if self.busy:  # the process died mid-turn
            self._finish({"is_error": True, "result": "The assistant stopped unexpectedly. Please send that again."})

    def _finish(self, msg: dict) -> None:
        text = self.buffer.strip() or (msg.get("result") or "").strip()
        error = bool(msg.get("is_error"))
        files = self._new_files()
        meta = {"tools": self.tools, "files": files, "error": error, "cost": msg.get("total_cost_usd"),
                "seconds": round(now() - self.turn_started, 1)}
        if error and not self.buffer.strip():
            text = self._explain_error(msg.get("result") or "")
        mid = self.m.db.x("INSERT INTO messages(chat_id,role,text,ts,meta) VALUES(?,?,?,?,?)",
                          (self.chat_id, "assistant", text, now(), json.dumps(meta)))
        self.m.db.x("UPDATE chats SET updated=? WHERE id=?", (now(), self.chat_id))
        self.busy, self.buffer = False, ""
        hub.publish(self.topic, "done", {"id": mid, "text": text, "meta": meta})

    @staticmethod
    def _explain_error(raw: str) -> str:
        low = raw.lower()
        if "limit" in low:
            return "This subscription has reached its usage limit for now. Choose another account in Settings, or try again after it resets."
        if "login" in low or "auth" in low or "401" in low:
            return "The assistant isn't signed in. Open Settings → Subscriptions and press Sign in."
        return "Something went wrong: " + clip(raw, 300)

    def _new_files(self) -> list[dict]:
        root = self.workspace()
        out = []
        for p in root.rglob("*"):
            parts = p.relative_to(root).parts
            if p.is_file() and ".crew" not in parts and parts[0] != "attachments" and not p.name.startswith(".") \
                    and p.stat().st_mtime >= self.turn_started - 1:
                rel = p.relative_to(root).as_posix()
                kind = {".html": "web", ".htm": "web", ".md": "doc", ".txt": "doc", ".png": "image", ".jpg": "image",
                        ".jpeg": "image", ".gif": "image", ".svg": "image", ".webp": "image", ".pdf": "pdf",
                        ".csv": "table"}.get(p.suffix.lower(), "file")
                out.append({"name": rel, "kind": kind, "url": f"/files/chat/{self.chat_id}/{rel}"})
        return sorted(out, key=lambda f: f["name"])[:20]


class ChatManager:
    def __init__(self, app_url: str = "", app_token: str = ""):
        self.db = ChatDB(crew_home() / "app.db")
        self.sessions: dict[str, ChatSession] = {}
        self.app_url, self.app_token = app_url, app_token
        self.rate: dict[str, dict] = {}
        self.chat_account: str | None = None

    def pick_account(self, cfg):
        app = settings_mod.load()["app"]
        claude = cfg.accounts_for("claude")
        chosen = next((a for a in claude if a.name == app.get("chat_account")), claude[0] if claude else None)
        self.chat_account = chosen.name if chosen else None
        return chosen

    def list(self) -> list[dict]:
        return self.db.q("SELECT id,title,created,updated FROM chats ORDER BY updated DESC LIMIT 200")

    def create(self, model: str | None = None, effort: str | None = None) -> dict:
        app = settings_mod.load()["app"]
        cid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.db.x("INSERT INTO chats(id,title,created,updated,model,effort) VALUES(?,?,?,?,?,?)",
                  (cid, "New conversation", now(), now(), model or app["chat_model"], effort or app["chat_effort"]))
        return self.get(cid)

    def get(self, cid: str) -> dict | None:
        rows = self.db.q("SELECT * FROM chats WHERE id=?", (cid,))
        if not rows:
            return None
        chat = rows[0]
        msgs = self.db.q("SELECT id,role,text,ts,meta FROM messages WHERE chat_id=? ORDER BY id", (cid,))
        for m in msgs:
            m["meta"] = json.loads(m["meta"] or "{}")
        s = self.sessions.get(cid)
        chat.update(messages=msgs, busy=bool(s and s.busy), partial=(s.buffer if s and s.busy else ""),
                    tools=(s.tools if s and s.busy else []))
        return chat

    def send(self, cid: str, text: str, model: str | None = None, effort: str | None = None,
             attachments: list[str] | None = None) -> dict:
        chat = self.get(cid)
        if chat is None:
            raise KeyError(cid)
        text = (text or "").strip()
        attachments = [a for a in (attachments or []) if isinstance(a, str) and re.fullmatch(r"attachments/[\w.-]+", a)]
        if not text and attachments:
            text = "Please look at what I attached."
        if not text:
            raise ValueError("Type or say something first.")
        model = model or chat["model"]
        effort = effort or chat["effort"]
        if effort not in cfgmod.EFFORTS:
            raise ValueError("Unknown effort level.")
        cfg = cfgmod.load(str(settings_mod.path()) if settings_mod.path().is_file() else None)
        cfg.models.check(model)  # a banned or unknown model is refused before anything is recorded
        session = self.sessions.get(cid) or ChatSession(self, chat)
        self.sessions[cid] = session
        if session.busy:
            raise ValueError("Still answering the last message. Press stop first, or wait a moment.")
        self.db.x("INSERT INTO messages(chat_id,role,text,ts,meta) VALUES(?,?,?,?,?)",
                  (cid, "user", text, now(), json.dumps({"attachments": attachments or []})))
        words = " ".join(text.split())
        title = chat["title"] if chat["title"] != "New conversation" else (words if len(words) <= 60 else words[:59].rstrip() + "…")
        self.db.x("UPDATE chats SET updated=?, title=?, model=?, effort=? WHERE id=?", (now(), title, model, effort, cid))
        prompt = text
        if attachments:
            prompt += "\n\n(The owner attached: " + ", ".join(attachments) + " — in this folder. Open them to answer.)"
        try:
            session.send(prompt, model, effort)
        except (RuntimeError, OSError, cfgmod.ConfigError) as exc:  # could not start: say so in the conversation
            session.busy, session.turn_started = False, now()
            mid = self.db.x("INSERT INTO messages(chat_id,role,text,ts,meta) VALUES(?,?,?,?,?)",
                            (cid, "assistant", str(exc), now(), json.dumps({"error": True})))
            hub.publish(session.topic, "done", {"id": mid, "text": str(exc), "meta": {"error": True}})
            return {"ok": False, "error": str(exc)}
        return {"ok": True}

    def save_attachment(self, cid: str, name: str, data: bytes) -> dict:
        root = self.workspace(cid)
        if root is None:
            raise KeyError(cid)
        stem, dot, ext = (name or "file").rpartition(".")
        safe = re.sub(r"[^\w.-]+", "-", (stem if dot else ext) or "file").strip("-.")[:60] or "file"
        ext = re.sub(r"[^\w]", "", ext)[:8] if dot else ""
        folder = root / "attachments"
        folder.mkdir(exist_ok=True)
        target = folder / (safe + ("." + ext if ext else ""))
        n = 1
        while target.exists():
            target = folder / (f"{safe}-{n}" + ("." + ext if ext else ""))
            n += 1
        target.write_bytes(data)
        rel = target.relative_to(root).as_posix()
        return {"path": rel, "name": target.name, "url": f"/files/chat/{cid}/{rel}", "size": len(data)}

    def stop(self, cid: str) -> None:
        s = self.sessions.get(cid)
        if s:
            s.interrupt()

    def delete(self, cid: str) -> None:
        s = self.sessions.pop(cid, None)
        if s:
            s.stop_process()
        self.db.x("DELETE FROM messages WHERE chat_id=?", (cid,))
        self.db.x("DELETE FROM chats WHERE id=?", (cid,))

    def workspace(self, cid: str) -> Path | None:
        if not self.get(cid):
            return None
        path = crew_home() / "chats" / cid
        path.mkdir(parents=True, exist_ok=True)
        return path

    def as_project_request(self, cid: str) -> str:
        chat = self.get(cid) or {}
        parts = []
        for m in chat.get("messages", [])[-12:]:
            who = "Owner" if m["role"] == "user" else "Assistant"
            parts.append(f"{who}: {clip(m['text'], 1500)}")
        return ("Build what the owner asked for in this conversation (the latest request matters most):\n\n"
                + "\n\n".join(parts))

    def shutdown(self) -> None:
        for s in self.sessions.values():
            s.stop_process()
