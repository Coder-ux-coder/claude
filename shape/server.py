"""Shape -- a small web server that turns a sentence into a 3D object.

Three things happen per request: Claude writes a Blender script, the guard
checks it, Blender runs it and renders what came out. Nothing is stored but
the job folder.

Run:  python server.py           (http://127.0.0.1:7000)

It binds to localhost. Putting it on a public address means running
Claude-written code for strangers -- see the README before you do.
"""

import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import maker

HERE = Path(__file__).parent.resolve()
JOBS = HERE / "jobs"
BLENDER = os.environ.get("BLENDER", "blender")
PORT = int(os.environ.get("PORT", "7000"))
HOST = os.environ.get("HOST", "127.0.0.1")

MAX_PROMPT = 1000
BUILD_TIMEOUT = 240
DOWNLOADS = {"view.png": "image/png",
             "model.glb": "model/gltf-binary",
             "scene.blend": "application/octet-stream"}
ID = re.compile(r"^[0-9a-f]{12}$")

jobs: dict[str, dict] = {}
lock = threading.Lock()


def set_state(job_id, **fields):
    with lock:
        jobs[job_id].update(fields)


def build(job_id, prompt, previous_code, api_key):
    folder = JOBS / job_id
    folder.mkdir(parents=True, exist_ok=True)
    try:
        set_state(job_id, state="working", stage="Asking Claude")
        code = maker.write_script(
            prompt, previous=previous_code, api_key=api_key,
            on_stage=lambda s: set_state(job_id, stage=s))
        (folder / "code.py").write_text(code)

        set_state(job_id, stage="Building it in Blender")
        run = subprocess.run(
            [BLENDER, "-b", "--factory-startup", "--python", str(HERE / "build.py"),
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

        set_state(job_id, state="done", stage="Done", result=result,
                  files=[n for n in DOWNLOADS if (folder / n).exists()])
    except subprocess.TimeoutExpired:
        set_state(job_id, state="failed", stage="", error="That took too long to build.")
    except Exception as e:                                   # noqa: BLE001
        set_state(job_id, state="failed", stage="", error=str(e))


class Handler(BaseHTTPRequestHandler):
    server_version = "Shape"

    def log_message(self, fmt, *args):
        # The default log line would carry the query string. Keep it to the path.
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]}\n")

    def send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            page = (HERE / "web" / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if path == "/state":
            self.send_json(200, {"hasKey": bool(os.environ.get("ANTHROPIC_API_KEY"))})
            return

        if path.startswith("/job/"):
            job_id = path[5:]
            with lock:
                job = jobs.get(job_id)
            if not job:
                self.send_json(404, {"error": "No such job."})
                return
            self.send_json(200, {k: v for k, v in job.items() if k != "key"})
            return

        if path.startswith("/out/"):
            parts = path[5:].split("/")
            if len(parts) != 2 or not ID.match(parts[0]) or parts[1] not in DOWNLOADS:
                self.send_json(404, {"error": "No such file."})
                return
            target = JOBS / parts[0] / parts[1]
            if not target.exists():
                self.send_json(404, {"error": "No such file."})
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", DOWNLOADS[parts[1]])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_json(404, {"error": "No such page."})

    def do_POST(self):
        if self.path != "/make":
            self.send_json(404, {"error": "No such page."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(length, 200_000)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "That request did not make sense."})
            return

        prompt = str(body.get("prompt", "")).strip()[:MAX_PROMPT]
        if not prompt:
            self.send_json(400, {"error": "Say what it should be."})
            return

        # The key is held for this request only: never written to disk, never
        # logged, never returned in a job's status.
        api_key = body.get("key") or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            self.send_json(400, {"error": "Add your Claude key first."})
            return

        previous_code = None
        change_of = str(body.get("changeOf", ""))
        if ID.match(change_of):
            earlier = JOBS / change_of / "code.py"
            if earlier.exists():
                previous_code = earlier.read_text()

        job_id = secrets.token_hex(6)
        with lock:
            jobs[job_id] = {"id": job_id, "prompt": prompt, "state": "working",
                            "stage": "Starting", "started": time.time()}
        threading.Thread(target=build, args=(job_id, prompt, previous_code, api_key),
                         daemon=True).start()
        self.send_json(200, {"id": job_id})


def main():
    JOBS.mkdir(exist_ok=True)
    if HOST != "127.0.0.1":
        print(f"! Serving on {HOST}. This runs generated code -- read the README.",
              file=sys.stderr)
    print(f"Shape is at http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
