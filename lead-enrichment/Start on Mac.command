#!/usr/bin/env bash
# macOS has no way to double-click a .sh from Finder -- it opens a text editor.
# A .command file does open in Terminal and run, so this exists purely to give
# Mac users the same double-click start that run.bat already gives Windows.
cd "$(dirname "$0")"
# `bash ./run.sh` rather than `./run.sh`: some unzip tools drop the execute
# bit, and a "permission denied" on a double-click is unrecoverable for the
# person it happens to.
exec bash ./run.sh
