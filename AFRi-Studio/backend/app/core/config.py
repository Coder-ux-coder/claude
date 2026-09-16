"""Paths, Blender discovery and runtime limits.

Blender's location is resolved at runtime. Nothing here is hardcoded to a
particular install directory.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROJECTS_DIR = ROOT / "projects"
TMP_DIR = ROOT / "tmp"
DB_PATH = ROOT / "afri_studio.db"
BLENDER_SCRIPT = ROOT / "blender_worker" / "scripts" / "build_scene.py"
DELIVERABLES = ROOT / "deliverables"

# Candidate Blender locations, in priority order. AFRI_BLENDER wins.
BLENDER_CANDIDATES = [
    os.environ.get("AFRI_BLENDER"),
    "/opt/blender/blender",
    "/usr/local/bin/blender",
    "/usr/bin/blender",
    "/Applications/Blender.app/Contents/MacOS/Blender",
    r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
]

MAX_CONCURRENT_JOBS = int(os.environ.get("AFRI_MAX_JOBS", "1"))
JOB_TIMEOUT_SECONDS = {"preview": 420, "standard": 1200, "high": 3600}
MAX_DISK_MB = int(os.environ.get("AFRI_MAX_DISK_MB", "4096"))
HOST = os.environ.get("AFRI_HOST", "127.0.0.1")
PORT = int(os.environ.get("AFRI_PORT", "8000"))
ALLOW_PUBLIC = os.environ.get("AFRI_ALLOW_PUBLIC", "") == "1"


@dataclass
class BlenderInfo:
    path: str | None
    version: str | None
    available: bool
    engines: list
    error: str | None = None


@lru_cache(maxsize=1)
def find_blender() -> BlenderInfo:
    """Locate Blender and verify it actually runs."""
    for cand in BLENDER_CANDIDATES:
        if not cand:
            continue
        exe = cand if os.path.isfile(cand) else shutil.which(cand)
        if not exe:
            continue
        try:
            out = subprocess.run([exe, "--version"], capture_output=True,
                                 text=True, timeout=30)
            first = (out.stdout or "").strip().splitlines()
            if out.returncode == 0 and first:
                return BlenderInfo(path=exe, version=first[0].strip(),
                                   available=True,
                                   engines=["CYCLES"])
        except Exception as exc:
            return BlenderInfo(path=exe, version=None, available=False,
                               engines=[], error=repr(exc))
    return BlenderInfo(
        path=None, version=None, available=False, engines=[],
        error="Blender was not found. Install it from https://www.blender.org/download/ "
              "and either put it on PATH or set the AFRI_BLENDER environment variable "
              "to its executable.")


def ensure_dirs():
    for d in (PROJECTS_DIR, TMP_DIR, DELIVERABLES):
        d.mkdir(parents=True, exist_ok=True)
