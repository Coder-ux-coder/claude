"""Crew: run several AI coding agents as one team on one repository."""

import os
import subprocess

__version__ = "0.1.0"

if os.name == "nt":
    # The app runs without a console window; the programs it starts (Claude Code, Codex, git,
    # the browser driver) must not flash black windows, and Python helpers must speak UTF-8
    # whatever the Windows display language.
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    _NO_WINDOW, _NEW_CONSOLE, _DETACHED = 0x08000000, 0x00000010, 0x00000008
    _popen_init = subprocess.Popen.__init__

    def _quiet_init(self, *args, **kwargs):
        flags = kwargs.get("creationflags") or 0
        if not flags & (_NEW_CONSOLE | _DETACHED):  # a window that was asked for (sign-in) still appears
            kwargs["creationflags"] = flags | _NO_WINDOW
        _popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _quiet_init
