#!/usr/bin/env bash
# Start AFRi Studio: backend + frontend, bound to localhost.
set -euo pipefail
cd "$(dirname "$0")"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'; OFF=$'\033[0m'

[[ -d .venv ]] || { echo "${RED}No .venv. Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt${OFF}"; exit 1; }
[[ -d frontend/node_modules ]] || { echo "${RED}Frontend deps missing. Run: cd frontend && npm install${OFF}"; exit 1; }

BL="${AFRI_BLENDER:-}"
if [[ -z "$BL" ]]; then
  for c in /opt/blender/blender /usr/local/bin/blender /usr/bin/blender \
           "/Applications/Blender.app/Contents/MacOS/Blender"; do
    [[ -x "$c" ]] && { BL="$c"; break; }
  done
  [[ -z "$BL" ]] && BL="$(command -v blender || true)"
fi
if [[ -n "$BL" ]]; then
  echo "${GRN}Blender:${OFF} $("$BL" --version 2>/dev/null | head -1) at $BL"
  export AFRI_BLENDER="$BL"
else
  echo "${YLW}Blender not found.${OFF} The UI will run, but generation will fail."
  echo "Install from https://www.blender.org/download/ or set AFRI_BLENDER."
fi

command -v claude >/dev/null && echo "${GRN}AI assistant:${OFF} Claude Code CLI $(claude --version 2>/dev/null)" \
  || echo "${YLW}Claude Code CLI not found${OFF} — the assistant falls back to manual handoff."

cleanup() { echo; echo "Shutting down…"; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 &
sleep 2
(cd frontend && npm run dev) &

echo
echo "${GRN}AFRi Studio${OFF}"
echo "  UI       http://127.0.0.1:5173"
echo "  API      http://127.0.0.1:8000/api/system"
echo "  API docs http://127.0.0.1:8000/docs"
echo "  Ctrl-C to stop."
wait
