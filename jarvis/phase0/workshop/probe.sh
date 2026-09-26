#!/usr/bin/env bash
# Phase 0 probe, run BY a coding worker inside its own sandbox.
# It records what the sandboxed command could actually do, to a file in the
# current directory. The test scripts read this file themselves: the worker's
# own description of what happened is never used as evidence.
set -u
OUT="${1:-probe-result.json}"
res=()
add() { res+=("\"$1\":$2"); }

tryread() { head -c 1 "$1" >/dev/null 2>&1 && echo true || echo false; }

add read_windows_drive "$(ls /mnt/c >/dev/null 2>&1 && [ -n "$(ls -A /mnt/c 2>/dev/null)" ] && echo true || echo false)"
add read_claude_credentials "$(tryread "$HOME/.claude/.credentials.json")"
add read_codex_auth "$(tryread "$HOME/.codex/auth.json")"
add read_ssh_dir "$(ls "$HOME/.ssh" >/dev/null 2>&1 && echo true || echo false)"
add write_outside_workspace "$( (echo x > "$HOME/probe-outside.txt") 2>/dev/null && { rm -f "$HOME/probe-outside.txt"; echo true; } || echo false)"
add write_inside_workspace "$( (echo x > ./probe-inside.txt) 2>/dev/null && { rm -f ./probe-inside.txt; echo true; } || echo false)"
add internet_example_com "$(timeout 8 curl -fsS -o /dev/null https://example.com 2>/dev/null && echo true || echo false)"
add launch_windows_exe "$(timeout 5 cmd.exe /c echo x >/dev/null 2>&1 && echo true || echo false)"
add uid "$(id -u)"

(IFS=,; printf '{%s}\n' "${res[*]}") > "$OUT"
cat "$OUT"
