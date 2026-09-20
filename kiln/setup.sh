#!/usr/bin/env bash
# Sets Kiln up on macOS or Linux. Safe to run twice.
#
#   bash setup.sh
#
# It makes a private Python environment beside this file, installs the one
# dependency, checks Blender, and builds a test object to prove it works.
# It never asks for your Claude key -- you type that into the app itself.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m*\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m!\033[0m %s\n' "$1"; }

say "1. Python"
PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      PY="$candidate"; break
    fi
  fi
done
if [ -z "$PY" ]; then
  bad "Python 3.10 or newer is needed."
  echo "     macOS:  brew install python@3.12"
  echo "     Ubuntu: sudo apt install python3 python3-venv"
  exit 1
fi
ok "$($PY --version) at $(command -v "$PY")"

say "2. Kiln's own Python environment"
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/python -m pip install --quiet --upgrade pip
./.venv/bin/python -m pip install --quiet anthropic
ok "ready ($(./.venv/bin/python -c 'import anthropic; print("anthropic " + anthropic.__version__)'))"

say "3. Blender"
BLENDER="$(command -v blender 2>/dev/null || true)"
for guess in \
  "/Applications/Blender.app/Contents/MacOS/Blender" \
  "$HOME/Applications/Blender.app/Contents/MacOS/Blender" \
  "/usr/local/bin/blender" "/usr/bin/blender" "/snap/bin/blender"; do
  [ -n "$BLENDER" ] && break
  [ -x "$guess" ] && BLENDER="$guess"
done
if [ -z "$BLENDER" ]; then
  bad "Blender is not installed yet."
  echo "     Get it free from https://www.blender.org/download/"
  echo "     macOS:  brew install --cask blender"
  echo "     Ubuntu: sudo snap install blender --classic"
  echo
  echo "     Install it, then run this again. Everything else is done."
  exit 1
fi
ok "$("$BLENDER" --version 2>/dev/null | head -1) at $BLENDER"

say "4. Building a test object"
./.venv/bin/python app.py --check

say "Done. Start Kiln with:"
echo "  ./.venv/bin/python app.py"
echo
echo "It opens in your browser and asks for a Claude key on the first run."
echo "Get one at https://console.anthropic.com/settings/keys"
