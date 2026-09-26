"""Team projects started from the app: each runs as its own background process
(so the app can close and reopen without disturbing it) and is observed through
its SQLite store."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
from pathlib import Path

from crewlib.cli import new_run_id
from crewlib.store import Store
from crewlib.util import crew_home, now
from crewlib.web import PHASES, state as run_state

CREW_ROOT = Path(__file__).resolve().parent.parent
ACTIVE = ("refine", "plan", "build", "deliver")
PREVIEW_CANDIDATES = ("index.html", "dist/index.html", "build/index.html", "public/index.html", "site/index.html",
                      "docs/index.html", "web/index.html")


def runs_dir() -> Path:
    path = crew_home() / "runs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run_dir(run_id: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id or ""):
        return None
    path = runs_dir() / run_id
    return path if (path / "team.db").is_file() or path.is_dir() else None


class RunManager:
    def __init__(self, extra_env: dict[str, str] | None = None):
        self.extra_env = extra_env or {}
        self.procs: dict[str, subprocess.Popen] = {}
        self._stores: dict[str, Store] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------ processes

    def _spawn(self, run_id: str, args: list[str]) -> None:
        run_dir = runs_dir() / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, **self.extra_env, "PYTHONPATH": str(CREW_ROOT), "CREW_HOME": str(crew_home()),
               "NO_COLOR": "1"}
        env.pop("CLAUDECODE", None)
        kwargs: dict = {}
        if os.name == "nt":
            kwargs["creationflags"] = 0x00000200 | 0x08000000  # new process group, no console window
        else:
            kwargs["start_new_session"] = True
        log = open(run_dir / "app-run.log", "ab")
        proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "crewlib", *args], cwd=str(CREW_ROOT), env=env,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, **kwargs)
        self.procs[run_id] = proc

    def start(self, request: str, repo: str | None = None, mode: str | None = None) -> str:
        request = (request or "").strip()
        if len(request) < 3:
            raise ValueError("Tell the team what you want first.")
        run_id = new_run_id(request)
        args = ["start", request, "--headless", "--run-id", run_id]
        if repo:
            args += ["--repo", repo]
        if mode in ("auto", "solo", "team"):
            args += ["--mode", mode]
        self._spawn(run_id, args)
        (runs_dir() / "LATEST").write_text(run_id)
        return run_id

    def resume(self, run_id: str) -> None:
        if self.running(run_id):
            return
        self._spawn(run_id, ["resume", run_id, "--headless"])

    def running(self, run_id: str) -> bool:
        proc = self.procs.get(run_id)
        return proc is not None and proc.poll() is None

    # ---------------------------------------------------------------- state

    def store(self, run_id: str) -> Store | None:
        run_dir = _run_dir(run_id)
        if run_dir is None or not (run_dir / "team.db").is_file():
            return None
        with self._lock:
            if run_id not in self._stores:
                self._stores[run_id] = Store(run_dir / "team.db")
            return self._stores[run_id]

    def stop(self, run_id: str) -> bool:
        st = self.store(run_id)
        if st is None:
            return False
        st.set("stop_requested", now())
        return True

    def say(self, run_id: str, text: str) -> bool:
        st = self.store(run_id)
        if st is None or not text.strip():
            return False
        st.post("you", "human", text.strip()[:4000], urgent=True)
        return True

    def project_dir(self, run_id: str) -> Path | None:
        st = self.store(run_id)
        repo = st.get("repo") if st else None
        return Path(repo) if repo else None

    def preview(self, run_id: str) -> dict:
        folder = self.project_dir(run_id)
        if folder is None or not folder.is_dir():
            return {}
        for rel in PREVIEW_CANDIDATES:
            if (folder / rel).is_file():
                return {"kind": "web", "url": f"/files/run/{run_id}/{rel}"}
        if (folder / "README.md").is_file():
            return {"kind": "doc", "url": f"/files/run/{run_id}/README.md"}
        return {}

    def state(self, run_id: str, after: int = 0) -> dict | None:
        st = self.store(run_id)
        if st is None:
            return None
        data = run_state(st, runs_dir() / run_id, after)
        phase = st.get("phase", "refine")
        data.update(id=run_id, running=self.running(run_id) or (phase in ACTIVE and self._recent(st)),
                    raw_phase=phase, mode=st.get("mode") or "", preview=self.preview(run_id),
                    folder=str(self.project_dir(run_id) or ""), started=st.get("started_at"),
                    request=st.get("goal", ""))
        return data

    @staticmethod
    def _recent(st: Store) -> bool:
        last = st.recent_messages(1)
        seats = st.seats()
        latest = max([m["ts"] for m in last] + [s.get("last_event_at") or 0 for s in seats] + [0])
        return now() - latest < 600

    def list(self) -> list[dict]:
        out = []
        for run_dir in runs_dir().iterdir():
            if not (run_dir / "team.db").is_file():
                continue
            st = self.store(run_dir.name)
            if st is None:
                continue
            brief = st.get("brief", {}) or {}
            tasks = st.tasks()
            phase = st.get("phase", "refine")
            out.append({
                "id": run_dir.name,
                "title": brief.get("title") or (st.get("goal", "") or run_dir.name)[:80],
                "phase": PHASES.get(phase, phase), "raw_phase": phase,
                "running": self.running(run_dir.name) or (phase in ACTIVE and self._recent(st)),
                "done": phase == "done",
                "progress": [sum(1 for t in tasks if t["status"] == "merged"),
                             sum(1 for t in tasks if t["status"] != "cancelled")],
                "started": st.get("started_at") or run_dir.stat().st_mtime,
                "mode": st.get("mode") or "",
                "preview": self.preview(run_dir.name),
            })
        return sorted(out, key=lambda r: r["started"] or 0, reverse=True)
