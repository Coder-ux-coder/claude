#!/usr/bin/env bash
# Phase 0: test Claude Code as a sandboxed coding worker (run as "worker",
# after `claude` login). Writes ~/phase0-results/claude_code.json
#
# Evidence rule: the pass/fail verdict comes from probe-result.json, which
# probe.sh writes from inside Claude Code's sandbox. What the model says about
# the run is recorded but never used to decide the result.
set -u
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
OUT="$HOME/phase0-results/claude_code.json"
mkdir -p "$HOME/phase0-results"
PROBE=/opt/jarvis-phase0/probe.sh

command -v claude >/dev/null 2>&1 || { echo "claude not installed; run install-workers.sh" >&2; exit 1; }

ws="$(mktemp -d "$HOME/cc-ws.XXXXXX")"
cd "$ws" && git init -q . && git -c user.email=p0@local -c user.name=p0 commit -q --allow-empty -m init

echo "==> Baseline: probe.sh WITHOUT any coding-tool sandbox (for comparison)"
bash "$PROBE" "$ws/baseline.json" >/dev/null
baseline="$(cat "$ws/baseline.json")"

version="$(claude --version 2>&1 | head -n1)"
doctor="$(timeout 60 claude doctor </dev/null 2>&1 | head -c 4000 || true)"

# Settings passed on the command line; --setting-sources user keeps any
# project settings in the workspace from changing them.
settings="$(jq -n --arg home "$HOME" '{
  disableAllHooks: true,
  permissions: { deny: [
    ("Read(" + $home + "/.claude/.credentials.json)"),
    ("Read(" + $home + "/.codex/**)"),
    ("Read(" + $home + "/.ssh/**)") ] },
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
    credentials: { files: [
      { path: ($home + "/.claude/.credentials.json"), mode: "deny" },
      { path: ($home + "/.codex/auth.json"), mode: "deny" } ] }
  } }')"

schema='{"type":"object","properties":{"ran_probe":{"type":"boolean"},"note":{"type":"string"}},"required":["ran_probe","note"],"additionalProperties":false}'

echo "==> Claude Code run 1: run the probe inside the sandbox (structured output)"
t0=$(date +%s)
run1="$(timeout 600 claude -p \
  "Run exactly this shell command in the current directory: bash $PROBE probe-result.json . Then reply with ran_probe=true if it ran. Also remember the word PAPAYA for a later question." \
  --setting-sources user --settings "$settings" \
  --allowedTools "Bash(bash $PROBE*)" \
  --output-format json --json-schema "$schema" 2>&1)"
rc1=$?
t1=$(date +%s)
printf '%s\n' "$run1" > "$ws/run1.json"
session_id="$(printf '%s' "$run1" | jq -r '.session_id // empty' 2>/dev/null)"
structured="$(printf '%s' "$run1" | jq -c '.structured_output // null' 2>/dev/null || echo null)"
cost="$(printf '%s' "$run1" | jq -c '.total_cost_usd // null' 2>/dev/null || echo null)"

if [ -s "$ws/probe-result.json" ] && jq -e . "$ws/probe-result.json" >/dev/null 2>&1; then
  probe="$(cat "$ws/probe-result.json")"
else
  probe=null
fi

echo "==> Claude Code run 2: --resume keeps context"
resume_ok=false
if [ -n "$session_id" ]; then
  run2="$(timeout 300 claude -p "What word did I ask you to remember? Reply with the word only." \
    --resume "$session_id" --setting-sources user --settings "$settings" --output-format json 2>&1)"
  printf '%s' "$run2" | jq -r '.result // ""' 2>/dev/null | grep -qi papaya && resume_ok=true
fi

# Verdict from the probe file only.
verdict="$(jq -n --argjson p "$probe" --argjson rc "$rc1" '
  if $p == null then {status:"fail", reason:"probe-result.json was not written inside the sandbox"}
  else
    ([ (if $p.read_claude_credentials then "read_claude_credentials" else empty end),
       (if $p.read_codex_auth then "read_codex_auth" else empty end),
       (if $p.read_ssh_dir then "read_ssh_dir" else empty end),
       (if $p.write_outside_workspace then "write_outside_workspace" else empty end),
       (if $p.internet_example_com then "internet_example_com" else empty end),
       (if $p.read_windows_drive then "read_windows_drive" else empty end),
       (if $p.launch_windows_exe then "launch_windows_exe" else empty end),
       (if $p.write_inside_workspace | not then "cannot_write_workspace" else empty end) ]) as $bad
    | if ($bad|length) == 0 then {status:"pass", problems:[]} else {status:"fail", problems:$bad} end
  end')"

jq -n --arg v "$version" --arg doctor "$doctor" --argjson baseline "$baseline" \
  --argjson probe "$probe" --argjson verdict "$verdict" --argjson structured "$structured" \
  --argjson cost "$cost" --argjson resume "$resume_ok" --argjson rc "$rc1" \
  --argjson secs "$((t1 - t0))" --arg sid_present "$([ -n "$session_id" ] && echo yes || echo no)" '
  {spike:"claude_code", version:$v, exit_code:$rc, seconds:$secs,
   verdict:$verdict, sandboxed_probe:$probe, unsandboxed_baseline:$baseline,
   structured_output:$structured, structured_output_ok:($structured != null),
   session_id_returned:($sid_present=="yes"), resume_ok:$resume,
   total_cost_usd:$cost, doctor:$doctor}' > "$OUT"

cat "$OUT"
echo
echo "CLAUDE_CODE: $(jq -r '.verdict.status' "$OUT")  (workspace kept at $ws for inspection)"
