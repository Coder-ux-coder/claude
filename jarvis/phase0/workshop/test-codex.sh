#!/usr/bin/env bash
# Phase 0: test Codex CLI as a sandboxed coding worker (run as "worker",
# after `codex login`). Writes ~/phase0-results/codex.json
# The verdict comes from probe-result.json written inside Codex's sandbox.
set -u
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
OUT="$HOME/phase0-results/codex.json"
mkdir -p "$HOME/phase0-results"
PROBE=/opt/jarvis-phase0/probe.sh

command -v codex >/dev/null 2>&1 || { echo "codex not installed; run install-workers.sh" >&2; exit 1; }

ws="$(mktemp -d "$HOME/cx-ws.XXXXXX")"
cd "$ws" && git init -q . && git -c user.email=p0@local -c user.name=p0 commit -q --allow-empty -m init

version="$(codex --version 2>&1 | head -n1)"
login_status="$(codex login status 2>&1 | head -c 400 | sed "s/$(id -un)/<user>/g")"
exec_help="$(codex exec --help 2>&1 | head -c 6000)"
appserver_help="$(codex app-server --help 2>&1 | head -c 3000)"

echo "==> Codex exec: run the probe inside the workspace-write sandbox"
t0=$(date +%s)
timeout 600 codex exec --json --sandbox workspace-write \
  "Run exactly this shell command in the current directory and nothing else: bash $PROBE probe-result.json" \
  > "$ws/events.jsonl" 2> "$ws/stderr.txt"
rc=$?
t1=$(date +%s)
events="$(wc -l < "$ws/events.jsonl" | tr -d ' ')"
event_types="$(jq -r '.type // .msg.type // empty' "$ws/events.jsonl" 2>/dev/null | sort | uniq -c | awk '{printf "%s%s:%s", (NR>1?",":""), $2, $1}')"

if [ -s "$ws/probe-result.json" ] && jq -e . "$ws/probe-result.json" >/dev/null 2>&1; then
  probe="$(cat "$ws/probe-result.json")"
else
  probe=null
fi

# Blocking problems: writes outside the workspace, network, Windows access.
# Findings: reads of credentials. Codex's workspace-write mode limits writes,
# not reads, so these are expected and shape the design (Phase 8 runs Codex
# with no host credentials in its reach); they are recorded, not failed.
verdict="$(jq -n --argjson p "$probe" '
  if $p == null then {status:"fail", reason:"probe-result.json was not written inside the sandbox"}
  else
    ([ (if $p.write_outside_workspace then "write_outside_workspace" else empty end),
       (if $p.internet_example_com then "internet_example_com" else empty end),
       (if $p.read_windows_drive then "read_windows_drive" else empty end),
       (if $p.launch_windows_exe then "launch_windows_exe" else empty end),
       (if $p.write_inside_workspace | not then "cannot_write_workspace" else empty end) ]) as $bad
    | ([ (if $p.read_codex_auth then "read_codex_auth" else empty end),
         (if $p.read_claude_credentials then "read_claude_credentials" else empty end),
         (if $p.read_ssh_dir then "read_ssh_dir" else empty end) ]) as $found
    | {status: (if ($bad|length) == 0 then "pass" else "fail" end), problems:$bad, findings:$found}
  end')"

jq -n --arg v "$version" --arg login "$login_status" --argjson rc "$rc" \
  --argjson secs "$((t1 - t0))" --argjson probe "$probe" --argjson verdict "$verdict" \
  --arg events "$events" --arg types "$event_types" --arg eh "$exec_help" --arg ah "$appserver_help" \
  --arg stderr "$(head -c 2000 "$ws/stderr.txt")" '
  {spike:"codex", version:$v, login_status:$login, exit_code:$rc, seconds:$secs,
   verdict:$verdict, sandboxed_probe:$probe, json_event_lines:($events|tonumber? // 0),
   json_event_types:$types, stderr_head:$stderr,
   exec_help:$eh, app_server_help:$ah}' > "$OUT"

cat "$OUT"
echo
echo "CODEX: $(jq -r '.verdict.status' "$OUT")  (workspace kept at $ws for inspection)"
