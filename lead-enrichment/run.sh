#!/usr/bin/env bash
# One command to start. Opens the browser interface on http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! "$PY" -c "import flask, requests, yaml, phonenumbers" >/dev/null 2>&1; then
  echo "Installing dependencies (first run only)..."
  "$PY" -m pip install --quiet -r requirements.txt
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "  Created .env for your API keys."
  echo "  To fill it in without editing files by hand, run:"
  echo "      $PY -m leadenrich.cli keys"
  echo "  Until then, the 'Run the demo' button works with no keys at all."
  echo
fi

exec "$PY" -m leadenrich.cli ui "$@"
