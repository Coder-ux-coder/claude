#!/usr/bin/env bash
# macOS has no way to double-click a .sh from Finder -- it opens a text editor.
# A .command file does open in Terminal and run, so this exists purely to give
# Mac users the same double-click start that run.bat already gives Windows.
cd "$(dirname "$0")"
exec ./run.sh
