"""Build single-file, double-clickable installers.

The app already fits in one zip, but a zip still asks the operator to unzip it,
find the right file inside, and know which one. That is three decisions, and
three is two too many for the person this is for.

These installers carry the app inside themselves as base64. Double-click one and
it writes the app out beside itself, installs what Python needs, starts the
server and opens the browser. Double-click it again tomorrow and it does the
same thing -- so there is exactly one file to keep, and one action to remember.

    python3 make_installer.py

Writes into dist/. Run package.sh first, or let this call it.
"""
from __future__ import annotations

import base64
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

WINDOWS_NAME = "START THE APP (Windows).bat"
MAC_NAME = "START THE APP (Mac).command"

PY_DOWNLOAD = "https://www.python.org/downloads/"


# --------------------------------------------------------------------------
# Windows
# --------------------------------------------------------------------------
# cmd.exe reads a batch file line by line as it runs it, so `exit /b` before the
# payload means the base64 below is never parsed as commands. PowerShell does the
# extraction because it is on every Windows 10/11 machine and batch string
# handling over a 300 KB literal is not.
#
# LastIndexOf, not IndexOf: the marker string also appears in the PowerShell line
# that searches for it, and matching that copy would hand FromBase64String the
# remainder of the script instead of the archive.
WINDOWS_TEMPLATE = r"""@echo off
setlocal EnableDelayedExpansion
title Lead Enrichment
cd /d "%~dp0"

echo.
echo   ==========================================
echo     Lead Enrichment  --  starting up
echo   ==========================================
echo.

set "APPDIRNAME=lead-enrichment"
set "APPDIR=%~dp0%APPDIRNAME%"

REM ---------------------------------------------------------------- unpack
if not exist "%APPDIR%\run.bat" (
  echo   Unpacking the app ^(first time only^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$raw = Get-Content -LiteralPath '%~f0' -Raw;" ^
    "$i = $raw.LastIndexOf('__PAYLOAD_BEGINS__');" ^
    "if ($i -lt 0) { throw 'payload marker missing' };" ^
    "$b64 = $raw.Substring($i + 18) -replace '\s','';" ^
    "$zip = Join-Path $env:TEMP 'lead-enrichment-payload.zip';" ^
    "[IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($b64));" ^
    "Expand-Archive -LiteralPath $zip -DestinationPath '%~dp0' -Force;" ^
    "Remove-Item $zip -Force"
  if errorlevel 1 (
    echo.
    echo   Could not unpack the app.
    echo   Try moving this file to your Desktop and double-clicking it again.
    echo.
    pause
    exit /b 1
  )
  echo   Done.
  echo.
)

REM ---------------------------------------------------------------- python
set "PY="
where python  >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )

if not defined PY (
  echo   Python is needed once, and is not installed yet.
  echo   Trying to install it for you...
  echo.
  where winget >nul 2>nul
  if not errorlevel 1 (
    winget install --id Python.Python.3.12 -e --source winget ^
      --accept-package-agreements --accept-source-agreements
    where python >nul 2>nul && set "PY=python"
  )
)

if not defined PY (
  echo.
  echo   Please install Python, then double-click this file again.
  echo.
  echo     1. The download page is opening now.
  echo     2. Click the big yellow "Download Python" button.
  echo     3. Run the installer and TICK "Add python.exe to PATH"
  echo        on the very first screen. This part matters.
  echo     4. Come back and double-click this file again.
  echo.
  start "" "PY_DOWNLOAD_URL"
  pause
  exit /b 1
)

REM ---------------------------------------------------------------- launch
cd /d "%APPDIR%"
echo   Starting. Your browser will open in a moment.
echo   Leave this black window open while you use the app.
echo.
call run.bat
pause
exit /b

__PAYLOAD_BEGINS__
"""


# --------------------------------------------------------------------------
# macOS / Linux
# --------------------------------------------------------------------------
# Python does the unpacking rather than base64/unzip: macOS ships BSD versions
# whose flags differ from GNU's, and Python has to be present for the app to run
# anyway, so gating on it first turns two possible failures into one.
MAC_TEMPLATE = r"""#!/usr/bin/env bash
# Double-click me. That is the whole thing.
cd "$(dirname "$0")"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$HERE/lead-enrichment"

echo
echo "  =========================================="
echo "    Lead Enrichment  --  starting up"
echo "  =========================================="
echo

# ------------------------------------------------------------------ python
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "  Python is needed once, and is not installed yet."
  echo
  echo "    1. The download page is opening now."
  echo "    2. Download the macOS installer and run it."
  echo "    3. Come back and double-click this file again."
  echo
  open "PY_DOWNLOAD_URL" 2>/dev/null || true
  read -r -p "  Press Enter to close." _ 2>/dev/null || true
  exit 1
fi

# ------------------------------------------------------------------ unpack
if [ ! -f "$APPDIR/run.sh" ]; then
  echo "  Unpacking the app (first time only)..."
  "$PY" - "$SELF" "$HERE" <<'UNPACK'
import base64, io, os, stat, sys, zipfile
self_path, dest = sys.argv[1], sys.argv[2]
raw = open(self_path, "rb").read()
marker = b"__PAYLOAD_BEGINS__\n"
i = raw.rfind(marker)
if i < 0:
    sys.exit("payload marker missing")
blob = base64.b64decode(b"".join(raw[i + len(marker):].split()))
with zipfile.ZipFile(io.BytesIO(blob)) as z:
    for info in z.infolist():
        out = z.extract(info, dest)
        mode = info.external_attr >> 16
        if mode:
            os.chmod(out, mode)
UNPACK
  if [ ! -f "$APPDIR/run.sh" ]; then
    echo
    echo "  Could not unpack the app."
    echo "  Try moving this file to your Desktop and double-clicking it again."
    echo
    read -r -p "  Press Enter to close." _ 2>/dev/null || true
    exit 1
  fi
  echo "  Done."
  echo
fi

# ------------------------------------------------------------------ launch
echo "  Starting. Your browser will open in a moment."
echo "  Leave this window open while you use the app."
echo
cd "$APPDIR"
exec bash ./run.sh
exit 0

__PAYLOAD_BEGINS__
"""


def build_payload() -> bytes:
    """The packaged app, built fresh so an installer is never stale."""
    subprocess.run(["bash", str(ROOT / "package.sh")], check=True,
                   capture_output=True, text=True)
    zips = sorted(DIST.glob("lead-enrichment-*.zip"))
    if not zips:
        raise SystemExit("package.sh produced no archive")
    return zips[-1].read_bytes()


def wrap_b64(blob: bytes, width: int = 120) -> str:
    b64 = base64.b64encode(blob).decode("ascii")
    return "\n".join(textwrap.wrap(b64, width))


def build() -> list[Path]:
    payload = build_payload()
    body = wrap_b64(payload)
    DIST.mkdir(parents=True, exist_ok=True)
    written = []

    win = DIST / WINDOWS_NAME
    # CRLF throughout: cmd.exe mis-parses a batch file with bare LF endings.
    text = WINDOWS_TEMPLATE.replace("PY_DOWNLOAD_URL", PY_DOWNLOAD) + body + "\n"
    win.write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    written.append(win)

    mac = DIST / MAC_NAME
    mac.write_text(MAC_TEMPLATE.replace("PY_DOWNLOAD_URL", PY_DOWNLOAD) + body + "\n",
                   encoding="ascii", newline="\n")
    mac.chmod(0o755)
    written.append(mac)

    return written


if __name__ == "__main__":
    for p in build():
        size = p.stat().st_size / 1024
        print(f"  {p}   ({size:.0f} KB)")
    sys.exit(0)
