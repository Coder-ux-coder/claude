#!/usr/bin/env python3
"""Serve the analyser on localhost.

Microphone capture requires a secure context. http://localhost qualifies;
opening index.html directly as a file:// URL does not, and the browser will
refuse getUserMedia there. So run this rather than double-clicking the file.

    python3 web/serve.py [--port 8000] [--no-open]
"""
import argparse
import http.server
import socketserver
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "favicon" not in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", a.port),
                                partial(Handler, directory=str(ROOT))) as httpd:
        url = f"http://localhost:{a.port}/index.html"
        print(f"  Voice Analyser  →  {url}")
        print("  Microphone capture works here because localhost is a secure context.")
        print("  Ctrl-C to stop.\n")
        if not a.no_open:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
