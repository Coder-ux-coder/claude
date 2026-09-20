"""Kiln's web server. Four kinds of request, no framework.

It serves one page, takes the settings, runs a build, and hands back the
picture and the model. It listens on localhost only: the app runs on your
machine, with your key, and nothing about a build leaves it except the request
to Claude.
"""

import json
import re
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

import maker
import settings

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)).resolve()
MAX_PROMPT = 1000
BUILD_TIMEOUT = 300
DOWNLOADS = {"view.png": "image/png",
             "model.glb": "model/gltf-binary",
             "scene.blend": "application/octet-stream"}
ID = re.compile(r"^[0-9a-f]{12}$")

jobs: dict[str, dict] = {}
lock = threading.Lock()


def set_state(job_id, **fields):
    with lock:
        jobs[job_id].update(fields)


def friendly(error: Exception) -> str:
    """Say what went wrong in words the person can act on."""
    if isinstance(error, anthropic.AuthenticationError):
        return "That Claude key was not accepted. Check it in Settings."
    if isinstance(error, anthropic.PermissionDeniedError):
        return "That key is not allowed to use this model. Try another model in Settings."
    if isinstance(error, anthropic.RateLimitError):
        return "Your Claude account is rate limited right now. Try again in a minute."
    if isinstance(error, anthropic.APIConnectionError):
        return "Could not reach Claude. Check the internet connection."
    if isinstance(error, anthropic.APIStatusError) and error.status_code >= 500:
        return "Claude had a problem at its end. Try again."
    return str(error)


def build(job_id, prompt, previous_code):
    folder = settings.JOBS_DIR / job_id
    folder.mkdir(parents=True, exist_ok=True)
    blender = settings.find_blender()
    if not blender:
        set_state(job_id, state="failed", stage="",
                  error="Blender is not installed, or Kiln cannot find it. "
                        "Add its location in Settings.")
        return
    try:
        set_state(job_id, state="working", stage="Asking Claude")
        written = maker.write_script(
            prompt, previous=previous_code,
            on_stage=lambda s: set_state(job_id, stage=s))
        (folder / "code.py").write_text(written["code"])

        set_state(job_id, stage="Building it in Blender")
        run = subprocess.run(
            [blender, "-b", "--factory-startup", "--python", str(HERE / "build.py"),
             "--", str(folder)],
            cwd=folder, capture_output=True, text=True, timeout=BUILD_TIMEOUT,
        )
        result_file = folder / "result.json"
        if not result_file.exists():
            tail = (run.stderr or run.stdout or "").strip().splitlines()[-3:]
            raise RuntimeError("Blender stopped before it finished. " + " ".join(tail))

        result = json.loads(result_file.read_text())
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "The script did not build anything."))

        card = {
            "prompt": prompt,
            "size_cm": result.get("size_cm"),
            "parts": result.get("parts"),
            "triangles": result.get("triangles"),
            "cost_usd": written["cost_usd"],
            "model": written["model"],
            "made": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        (folder / "card.json").write_text(json.dumps(card, indent=2))
        set_state(job_id, state="done", stage="Done", result=result, card=card)
    except subprocess.TimeoutExpired:
        set_state(job_id, state="failed", stage="",
                  error="That took too long to build. Try describing something simpler.")
    except Exception as e:                                   # noqa: BLE001
        set_state(job_id, state="failed", stage="", error=friendly(e))


class Handler(BaseHTTPRequestHandler):
    server_version = "Kiln"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]}\n")

    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            self.send_file((HERE / "web" / "index.html").read_bytes(),
                           "text/html; charset=utf-8")
            return

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if path == "/settings":
            blender = settings.find_blender()
            self.reply(200, {
                # Never the key itself: only enough to recognise it.
                "keySet": bool(settings.get_key()),
                "keyHint": settings.key_hint(),
                "blender": blender,
                "blenderOk": bool(blender),
                "blenderHelp": settings.blender_download_url(),
                "model": settings.model(),
                "models": [{"id": m, "name": n, "inPrice": i, "outPrice": o}
                           for m, n, i, o in settings.MODELS],
            })
            return

        if path == "/history":
            self.reply(200, {"items": settings.history()})
            return

        if path.startswith("/job/"):
            with lock:
                job = jobs.get(path[5:])
            if not job:
                self.reply(404, {"error": "No such job."})
                return
            self.reply(200, job)
            return

        if path.startswith("/out/"):
            parts = path[5:].split("/")
            if len(parts) != 2 or not ID.match(parts[0]) or parts[1] not in DOWNLOADS:
                self.reply(404, {"error": "No such file."})
                return
            target = settings.JOBS_DIR / parts[0] / parts[1]
            if not target.exists():
                self.reply(404, {"error": "No such file."})
                return
            self.send_file(target.read_bytes(), DOWNLOADS[parts[1]])
            return

        self.reply(404, {"error": "No such page."})

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(length, 200_000)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.reply(400, {"error": "That request did not make sense."})
            return

        if self.path == "/settings":
            key = str(body.get("key", "")).strip()
            if key:
                if not key.startswith("sk-ant-"):
                    self.reply(400, {"error": "A Claude key starts with sk-ant-."})
                    return
                settings.set_key(key)
            if body.get("forgetKey"):
                settings.clear_key()
            blender = str(body.get("blender", "")).strip()
            if blender:
                if not Path(blender).exists():
                    self.reply(400, {"error": "Nothing is at that location."})
                    return
                settings.save(blender=blender)
            chosen = str(body.get("model", "")).strip()
            if chosen:
                settings.save(model=chosen)
            self.reply(200, {"ok": True})
            return

        if self.path == "/forget":
            job_id = str(body.get("id", ""))
            if ID.match(job_id):
                settings.forget(job_id)
            self.reply(200, {"ok": True})
            return

        if self.path != "/make":
            self.reply(404, {"error": "No such page."})
            return

        prompt = str(body.get("prompt", "")).strip()[:MAX_PROMPT]
        if not prompt:
            self.reply(400, {"error": "Say what it should be."})
            return
        if not settings.get_key():
            self.reply(400, {"error": "Connect your Claude account first."})
            return

        previous_code = None
        change_of = str(body.get("changeOf", ""))
        if ID.match(change_of):
            earlier = settings.JOBS_DIR / change_of / "code.py"
            if earlier.exists():
                previous_code = earlier.read_text()

        job_id = secrets.token_hex(6)
        with lock:
            jobs[job_id] = {"id": job_id, "prompt": prompt, "state": "working",
                            "stage": "Starting", "started": time.time()}
        threading.Thread(target=build, args=(job_id, prompt, previous_code),
                         daemon=True).start()
        self.reply(200, {"id": job_id})


def serve(host="127.0.0.1", port=7000):
    settings.ensure_dirs()
    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    serve().serve_forever()
