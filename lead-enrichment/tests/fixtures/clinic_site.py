"""A realistic Indian clinic website, served over real HTTP for integration tests.

Modelled on how these sites are actually built: a phone in the header, a
reception number captioned as such, a doctor's direct line published beside her
name on a Team page, a contact page reached by a link the site calls "Reach Us"
rather than "/contact", and a robots.txt that disallows one directory.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROBOTS = "User-agent: *\nDisallow: /admin/\nDisallow: /internal\n"

HOME = """<!doctype html>
<html><head><meta charset="utf-8"><title>Lotus Wellness Polyclinic</title></head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/about-us">About</a>
      <a href="/reach-us">Reach Us</a>
      <a href="/team">Our Doctors</a>
      <a href="/internal">Staff portal</a>
    </nav>
  </header>
  <main>
    <h1>Lotus Wellness Polyclinic, Jaipur</h1>
    <p>General medicine, dermatology and physiotherapy since 2009.</p>
    <p>Appointments: <a href="tel:+911414567890">0141 456 7890</a></p>
  </main>
</body></html>
"""

REACH_US = """<!doctype html>
<html><head><meta charset="iso-8859-1"><title>Reach Us</title></head>
<body>
  <h1>Reach Us</h1>
  <p>Reception &ndash; 0141 456 7890</p>
  <p>Emergency helpline: +91 99999 10011</p>
  <address>14 Civil Lines, Jaipur 302006</address>
</body></html>
"""

TEAM = """<!doctype html>
<html><head><meta charset="utf-8"><title>Our Doctors</title></head>
<body>
  <h1>Our Doctors</h1>
  <div class="doctor">
    <h2>Dr Meera Joshi</h2>
    <p>Proprietor and Consultant Physician. MBBS, MD.</p>
    <p>Direct line: +91 99999 10005</p>
  </div>
  <div class="doctor">
    <h2>Dr Ravi Sharma</h2>
    <p>Consultant Dermatologist. For appointments call reception on 0141 456 7890.</p>
  </div>
</body></html>
"""

PAGES = {
    "/": ("text/html; charset=utf-8", HOME.encode("utf-8")),
    "/reach-us": ("text/html; charset=iso-8859-1", REACH_US.encode("utf-8")),
    "/team": ("text/html; charset=utf-8", TEAM.encode("utf-8")),
    "/robots.txt": ("text/plain", ROBOTS.encode("utf-8")),
    # A brochure the reader must decline to parse rather than mine for digits.
    "/brochure.pdf": ("application/pdf", b"%PDF-1.7 not a page 9876543210"),
}


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):                                   # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path == "/internal":                         # robots-disallowed
            body = b"<html><body>Staff only 0141 999 0000</body></html>"
            self._send("text/html", body)
            return
        if path not in PAGES:
            self._send("text/html", b"<html><body>Not found</body></html>", 404)
            return
        ctype, body = PAGES[path]
        self._send(ctype, body)

    def _send(self, ctype: str, body: bytes, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_a):                         # keep test output clean
        pass


class ClinicSite:
    """Runs the site on a real port for the duration of a test."""

    def __init__(self):
        self._srv = HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self._srv.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)

    def __enter__(self) -> "ClinicSite":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._srv.shutdown()
        self._srv.server_close()
        self._thread.join(timeout=5)
