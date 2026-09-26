#!/usr/bin/env bash
# Phase 0: install the coding workers for the unprivileged "worker" user.
# Claude Code via Anthropic's native installer (documented at
# code.claude.com/docs/en/setup); Codex via npm (@openai/codex, per the
# openai/codex README); the Claude Code sandbox's optional seccomp filter via
# npm (@anthropic-ai/sandbox-runtime). Nothing is installed as root.
set -euo pipefail
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
OUT="$HOME/phase0-results/workers-install.json"

[ "$(id -u)" -ne 0 ] || { echo "run as worker, not root" >&2; exit 1; }

echo "==> Claude Code (native installer)"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
cc_ver="$(claude --version 2>&1 || true)"

echo "==> Codex CLI (npm)"
if ! command -v codex >/dev/null 2>&1; then
  npm install -g @openai/codex
fi
cx_ver="$(codex --version 2>&1 || true)"

echo "==> Claude Code sandbox seccomp filter (optional component)"
sr_status="installed"
npm install -g @anthropic-ai/sandbox-runtime >/dev/null 2>&1 || sr_status="failed"

jq -n --arg cc "$cc_ver" --arg cx "$cx_ver" --arg sr "$sr_status" \
  '{spike:"workers_install", claude_code_version:$cc, codex_version:$cx, sandbox_runtime:$sr}' > "$OUT"
cat "$OUT"
cat <<'EOF'

NEXT (interactive, one time):
  1. Claude Code login:  claude        (choose your subscription; if the browser
     cannot call back into WSL, paste the code shown in the browser), then /exit
  2. Codex login:        codex login   (if the browser cannot reach WSL, run
     `codex login --help` and use its device/headless option)
Then run: bash /opt/jarvis-phase0/test-claude-code.sh && bash /opt/jarvis-phase0/test-codex.sh
EOF
