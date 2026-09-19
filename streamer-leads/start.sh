#!/usr/bin/env bash
# Streamer Lead Workspace - launcher for macOS and Linux.
set -euo pipefail
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "ERROR: Python 3.10+ is required but was not found." >&2
  exit 1
fi

exec "$PY" run.py "$@"
