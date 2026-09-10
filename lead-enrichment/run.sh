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

echo
echo "  Starting. Open http://127.0.0.1:8000 if your browser does not."
echo "  Paste your API keys at http://127.0.0.1:8000/setup"
echo "  Leave this window open while you use it. Press Ctrl+C to stop."
echo

# Best effort -- harmless if neither exists (a headless box, say).
(command -v open >/dev/null 2>&1 && sleep 2 && open http://127.0.0.1:8000) &
(command -v xdg-open >/dev/null 2>&1 && sleep 2 && xdg-open http://127.0.0.1:8000) &

exec "$PY" -m leadenrich.cli ui "$@"
