"""Filesystem and input guards."""
from __future__ import annotations

import re
from pathlib import Path

from backend.app.core.config import ROOT

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,80}$")


class UnsafePath(Exception):
    pass


def safe_asset_path(*parts: str) -> Path:
    """Resolve a path and assert it stays inside the project root.

    Symlinks are resolved *before* the containment check, so a symlink planted
    inside the project cannot be used to read outside it.
    """
    for p in parts:
        if p is None or ".." in str(p) or str(p).startswith(("/", "\\")):
            raise UnsafePath(f"rejected path component: {p!r}")
    candidate = ROOT.joinpath(*[str(p) for p in parts]).resolve()
    root = ROOT.resolve()
    if not (candidate == root or root in candidate.parents):
        raise UnsafePath(f"path escapes the project root: {candidate}")
    return candidate


def safe_name(name: str, field: str = "name") -> str:
    name = (name or "").strip()
    if not SAFE_NAME.match(name):
        raise ValueError(
            f"{field} must be 1-80 characters of letters, digits, spaces, "
            f"dots, underscores or hyphens")
    return name
