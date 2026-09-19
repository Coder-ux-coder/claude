#!/usr/bin/env python3
"""Start the Streamer Lead Workspace on this machine.

Checks the prerequisites, installs anything missing the first time, then runs
the API and the web interface together.  Works the same on Windows, macOS and
Linux.

    python run.py                 start everything
    python run.py --setup-only    install dependencies and stop
    python run.py --port 8010     use a different API port
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"
IS_WINDOWS = platform.system() == "Windows"

API_PORT = 8000
WEB_PORT = 5173


def say(message: str = "") -> None:
    print(message, flush=True)


def step(message: str) -> None:
    say(f"  -> {message}")


def fail(message: str, *remedies: str) -> "NoReturn":  # type: ignore[valid-type]
    say()
    say(f"ERROR: {message}")
    for remedy in remedies:
        say(f"       {remedy}")
    say()
    sys.exit(1)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def check_python() -> None:
    if sys.version_info < (3, 10):
        fail(
            f"Python 3.10 or newer is required (this is {platform.python_version()}).",
            "Install it from https://www.python.org/downloads/ and tick 'Add python.exe to PATH'.",
        )
    step(f"Python {platform.python_version()} found.")


def find_npm() -> str:
    npm = shutil.which("npm")
    if not npm:
        fail(
            "Node.js (npm) was not found on your PATH.",
            "Install the LTS build from https://nodejs.org/ , then open a new terminal.",
        )
    try:
        node_version = subprocess.run(
            [shutil.which("node") or "node", "--version"],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        step(f"Node {node_version} found.")
    except Exception:
        step("Node found.")
    return npm


def ensure_backend() -> Path:
    """Create the virtual environment and install the API dependencies."""
    python = venv_python()
    if not python.exists():
        step("Creating the Python virtual environment (first run only)...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        python = venv_python()

    probe = subprocess.run(
        [str(python), "-c", "import fastapi, uvicorn"], capture_output=True,
    )
    if probe.returncode != 0:
        step("Installing the API dependencies (first run only)...")
        subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "pip", "--quiet"], check=False)
        subprocess.run(
            [str(python), "-m", "pip", "install", "-r", str(BACKEND / "requirements.txt")],
            check=True,
        )
    step("API dependencies ready.")
    return python


def ensure_frontend(npm: str) -> None:
    if not (FRONTEND / "package.json").exists():
        fail("frontend/package.json is missing - the project files are incomplete.")
    if not (FRONTEND / "node_modules").is_dir():
        step("Installing the web dependencies (first run only, this takes a minute)...")
        subprocess.run([npm, "install", "--no-fund", "--no-audit"], cwd=FRONTEND, check=True)
    step("Web dependencies ready.")


def spawn(command: list[str], cwd: Path, env: dict) -> subprocess.Popen:
    """Start a child in its own process group so its children can be stopped too."""
    kwargs: dict = {"cwd": str(cwd), "env": env}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(command, **kwargs)


def stop(process: subprocess.Popen) -> None:
    """Stop a child process and the whole tree beneath it.

    `npm run dev` starts Vite as a grandchild, so terminating npm alone would
    leave the web server running and port 5173 occupied.
    """
    if process.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True, timeout=15,
            )
        else:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except Exception:
        try:
            process.terminate()
        except Exception:
            return
    try:
        process.wait(timeout=8)
    except Exception:
        try:
            if not IS_WINDOWS:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            else:
                process.kill()
        except Exception:
            pass


def wait_for_api(port: int, timeout: float = 45.0) -> bool:
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.4)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Start the Streamer Lead Workspace.")
    parser.add_argument("--setup-only", action="store_true", help="install dependencies, then stop")
    parser.add_argument("--no-frontend", action="store_true", help="run only the API")
    parser.add_argument("--port", type=int, default=API_PORT, help=f"API port (default {API_PORT})")
    args = parser.parse_args()

    say("=" * 66)
    say("  Streamer Lead Workspace")
    say("=" * 66)
    say()
    say("Checking prerequisites...")
    check_python()
    npm = find_npm() if not args.no_frontend else ""
    python = ensure_backend()
    if not args.no_frontend:
        ensure_frontend(npm)

    if args.setup_only:
        say()
        say("Setup finished. Start the application with:  python run.py")
        return 0

    say()
    say("Starting the application...")

    # The API must not inherit a proxy setting, or localhost calls can be
    # routed away from this machine.
    env = dict(os.environ)
    for variable in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(variable, None)
    env["NO_PROXY"] = "127.0.0.1,localhost"

    processes: list[subprocess.Popen] = []
    try:
        api = spawn(
            [str(python), "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(args.port)],
            BACKEND, env,
        )
        processes.append(api)

        if not wait_for_api(args.port):
            fail(
                f"The API did not start on port {args.port}.",
                "Another program may already be using it - try:  python run.py --port 8010",
            )
        step(f"API listening on http://127.0.0.1:{args.port}")

        if not args.no_frontend:
            web = spawn([npm, "run", "dev"], FRONTEND, env)
            processes.append(web)
            time.sleep(2.5)
            step(f"Web interface on http://localhost:{WEB_PORT}")

        say()
        say("-" * 66)
        say(f"  OPEN THIS IN YOUR BROWSER:   http://localhost:{WEB_PORT}")
        say("-" * 66)
        say()
        say("  Your leads are stored in backend/data/leads.db")
        say("  Press Ctrl+C in this window to stop the application.")
        say()

        while True:
            for process in processes:
                if process.poll() is not None:
                    say(f"A component stopped unexpectedly (exit code {process.returncode}).")
                    return 1
            time.sleep(0.8)

    except KeyboardInterrupt:
        say()
        say("Stopping...")
        return 0
    finally:
        for process in reversed(processes):
            stop(process)
        say("Stopped.")


if __name__ == "__main__":
    if not IS_WINDOWS:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.exit(main())
