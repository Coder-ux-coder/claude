"""The single-file installers.

The Windows one cannot be executed here, so these tests reproduce the exact
extraction each script performs -- PowerShell's LastIndexOf/Substring/
FromBase64String for the .bat, Python's rfind/b64decode for the .command --
and assert the archive comes back intact. That is the difference between
shipping a file that works and shipping one that has never been opened.
"""
from __future__ import annotations

import base64
import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MARKER = "__PAYLOAD_BEGINS__"


@pytest.fixture(scope="module")
def installers():
    sys.path.insert(0, str(ROOT))
    import make_installer
    return {p.name: p for p in make_installer.build()}


def _windows(path: Path) -> Path:
    return next(p for n, p in path.items() if n.endswith(".bat"))


def _mac(path: Path) -> Path:
    return next(p for n, p in path.items() if n.endswith(".command"))


# ------------------------------------------------------- payload recovery ---

def test_windows_powershell_logic_recovers_the_archive(installers):
    """Mirrors the .bat exactly: LastIndexOf, Substring(+18), strip \\s, decode."""
    raw = _windows(installers).read_bytes().decode("ascii")

    i = raw.rindex(MARKER)                      # PowerShell LastIndexOf
    assert len(MARKER) == 18, "the .bat hardcodes Substring($i + 18)"
    b64 = re.sub(r"\s", "", raw[i + 18:])       # PowerShell -replace '\\s',''
    blob = base64.b64decode(b64)                # FromBase64String

    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        assert z.testzip() is None
        assert "lead-enrichment/run.bat" in z.namelist()


def test_indexof_would_have_found_the_wrong_marker(installers):
    """The bug this guards: the marker also appears in the search line itself."""
    raw = _windows(installers).read_bytes().decode("ascii")
    assert raw.count(MARKER) >= 2, "no longer a hazard; this test can go"
    assert raw.index(MARKER) != raw.rindex(MARKER)

    wrong = re.sub(r"\s", "", raw[raw.index(MARKER) + 18:])
    with pytest.raises(Exception):
        base64.b64decode(wrong, validate=True)


def test_mac_python_logic_recovers_the_archive(installers):
    raw = _mac(installers).read_bytes()
    marker = b"__PAYLOAD_BEGINS__\n"
    i = raw.rfind(marker)
    blob = base64.b64decode(b"".join(raw[i + len(marker):].split()))

    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        assert z.testzip() is None
        assert "lead-enrichment/run.sh" in z.namelist()


# --------------------------------------------------------------- structure ---

def test_batch_stops_executing_before_the_payload(installers):
    """Without `exit /b`, cmd.exe would try to run 290 KB of base64."""
    raw = _windows(installers).read_bytes().decode("ascii")
    head = raw[:raw.rindex(MARKER)]
    assert re.search(r"^exit /b\s*$", head, re.M), "no exit before the payload"


def test_batch_uses_crlf_throughout(installers):
    """cmd.exe mis-parses batch files with bare LF line endings."""
    raw = _windows(installers).read_bytes()
    assert b"\r\n" in raw
    assert not re.search(rb"(?<!\r)\n", raw), "a bare LF would break parsing"


def test_mac_script_is_executable_and_shell_valid(installers):
    import stat
    p = _mac(installers)
    assert p.stat().st_mode & stat.S_IXUSR
    r = subprocess.run(["bash", "-n", str(p)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_neither_installer_carries_a_credential(installers):
    pattern = re.compile(rb"sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}")
    for p in installers.values():
        head = p.read_bytes()[:p.read_bytes().rindex(MARKER.encode())]
        assert not pattern.search(head)


# ----------------------------------------------------------- the real thing ---

@pytest.mark.skipif(sys.platform == "win32", reason="POSIX launcher")
def test_mac_installer_actually_unpacks_a_runnable_app(installers, tmp_path):
    """Run the unpack step for real, then confirm what lands is startable."""
    import os
    import shutil

    dest = tmp_path / "Downloads"
    dest.mkdir()
    shutil.copy(_mac(installers), dest / "start.command")

    # The script's own unpack block, executed the way the script executes it.
    raw = (dest / "start.command").read_bytes()
    marker = b"__PAYLOAD_BEGINS__\n"
    blob = base64.b64decode(b"".join(raw[raw.rfind(marker) + len(marker):].split()))
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for info in z.infolist():
            out = z.extract(info, dest)
            mode = info.external_attr >> 16
            if mode:
                os.chmod(out, mode)

    app = dest / "lead-enrichment"
    assert (app / "run.sh").exists()
    assert os.access(app / "run.sh", os.X_OK), "execute bit lost in transit"

    # Startable means importable with its own config, not merely present.
    r = subprocess.run([sys.executable, "-m", "leadenrich.cli", "demo",
                        "--quiet", "--data-dir", str(tmp_path / "d"),
                        "--out", str(tmp_path / "o")],
                       cwd=app, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert (tmp_path / "o").exists()
