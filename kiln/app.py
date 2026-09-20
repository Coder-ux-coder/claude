"""Kiln. Double-click this, or run it, and the app opens in your browser.

It picks a free port, starts the server on localhost, and opens the page. Your
key and the objects you make stay on this machine.
"""

import argparse
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

import server
import settings

VERSION = "1.0.0"
BANNER = r"""
  _  _ _
 | |/ (_) |
 | ' /| | |_ __
 | . \| | | '_ \
 |_|\_\_|_|_| |_|
"""


def free_port(preferred: int) -> int:
    """The preferred port if it is free, otherwise any free one.

    The probe reuses addresses exactly as the server will. Without that, a port
    still in TIME_WAIT from the last run reads as busy and Kiln quietly moves to
    a random one -- so closing it and opening it again would hand you a
    different address every time.
    """
    for candidate in (preferred, 0):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", candidate))
                return probe.getsockname()[1]
            except OSError:
                continue
    return preferred


SELF_CHECK = """
import bpy
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.05, location=(0, 0, 0.05))
m = bpy.data.materials.new("check")
m.use_nodes = True
m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.2, 0.6, 0.5, 1)
bpy.context.active_object.data.materials.append(m)
"""


def self_check() -> int:
    """Build one known object, to prove Blender and Kiln agree.

    Nothing here touches Claude, so it costs nothing and works offline.
    """
    blender = settings.find_blender()
    print(f"  Blender: {blender or 'NOT FOUND'}")
    if not blender:
        print("  Install it from https://www.blender.org/download/ and run this again.")
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        (folder / "code.py").write_text(SELF_CHECK)
        started = time.time()
        run = subprocess.run(
            [blender, "-b", "--factory-startup", "--python",
             str(server.HERE / "build.py"), "--", str(folder)],
            capture_output=True, text=True, timeout=300,
        )
        result = folder / "result.json"
        if not result.exists():
            print("  Blender did not finish:")
            print("   ", (run.stderr or run.stdout).strip().splitlines()[-1:])
            return 1
        data = json.loads(result.read_text())
        if not data.get("ok"):
            print(f"  The build failed: {data.get('error')}")
            return 1
        picture = folder / "view.png"
        print(f"  Built and rendered a {data['size_cm'][2]} cm sphere in "
              f"{time.time() - started:.1f}s "
              f"({picture.stat().st_size // 1024} KB picture, "
              f"{(folder / 'model.glb').stat().st_size // 1024} KB model).")
    key = settings.get_key()
    print(f"  Claude:  {'connected ' + settings.key_hint() if key else 'not connected'}")
    print("\n  Everything Kiln needs is working.")
    return 0


def main():
    parser = argparse.ArgumentParser(prog="kiln", description="Make things in Blender by saying what you want.")
    parser.add_argument("--port", type=int, default=7000)
    parser.add_argument("--no-browser", action="store_true",
                        help="start the app without opening a window")
    parser.add_argument("--check", action="store_true",
                        help="build one test object and report whether it worked")
    parser.add_argument("--version", action="version", version=f"Kiln {VERSION}")
    args = parser.parse_args()

    settings.ensure_dirs()
    if args.check:
        print(BANNER)
        return self_check()
    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}"

    print(BANNER)
    print(f"  Kiln {VERSION}")
    print(f"  Open {url}")
    blender = settings.find_blender()
    print(f"  Blender: {blender or 'not found yet — the app will ask'}")
    print(f"  Claude:  {'connected ' + settings.key_hint() if settings.get_key() else 'not connected yet — the app will ask'}")
    print(f"  Objects: {settings.JOBS_DIR}")
    print("\n  Close this window to quit.\n")

    httpd = server.serve(port=port)
    if not args.no_browser:
        threading.Thread(
            target=lambda: (time.sleep(0.4), webbrowser.open(url)), daemon=True
        ).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Bye.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
