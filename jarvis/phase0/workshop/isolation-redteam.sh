#!/usr/bin/env bash
# Phase 0: red-team the jarvis-workshop boundary. Runs as the unprivileged
# "worker" user, outside any coding-tool sandbox, and tries to reach Windows.
# Every "escape" probe is expected to FAIL. Writes ~/phase0-results/isolation.json
#
# Usage: isolation-redteam.sh <canary-file-name> <windows-localhost-port>
set -u

CANARY_NAME="${1:-}"
HOST_PORT="${2:-0}"
OUT_DIR="$HOME/phase0-results"
mkdir -p "$OUT_DIR"

results=()
# add <name> <expected: blocked|info> <escaped: true|false> <detail>
add() {
  local detail
  detail="$(printf '%s' "$4" | head -c 400 | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  results+=("{\"name\":\"$1\",\"expected\":\"$2\",\"escaped\":$3,\"detail\":\"$detail\"}")
}

# 1. Windows drives mounted?
if ls /mnt/c >/dev/null 2>&1 && [ -n "$(ls -A /mnt/c 2>/dev/null)" ]; then
  add windows_drive_mounted blocked true "/mnt/c is mounted and readable"
else
  add windows_drive_mounted blocked false "no /mnt/c content"
fi
mounts="$(grep -iE 'drvfs|9p|virtiofs' /proc/mounts 2>/dev/null | grep -vE ' /usr/lib/wsl| /init' || true)"
if [ -n "$mounts" ]; then add drvfs_mounts_present blocked true "$mounts"; else add drvfs_mounts_present blocked false "none"; fi

# 2. Can we mount a Windows drive ourselves?
mkdir -p /tmp/probe-mnt
if mount -t drvfs 'C:' /tmp/probe-mnt >/dev/null 2>&1; then
  add mount_drvfs blocked true "mount succeeded"; umount /tmp/probe-mnt 2>/dev/null
else
  add mount_drvfs blocked false "mount refused (not root)"
fi

# 3. Privilege escalation available?
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  add sudo_available blocked true "passwordless sudo works"
else
  add sudo_available blocked false "no usable sudo"
fi
[ "$(id -u)" -eq 0 ] && add running_as_root blocked true "uid 0" || add running_as_root blocked false "uid $(id -u)"

# 4. Can we launch Windows programs (WSL interop)?
if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && grep -q enabled /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null; then
  add interop_binfmt_registered blocked true "WSLInterop binfmt handler enabled"
else
  add interop_binfmt_registered blocked false "no enabled WSLInterop handler"
fi
win_exec="no"
for exe in cmd.exe powershell.exe /mnt/c/Windows/System32/cmd.exe; do
  if out="$(timeout 5 "$exe" /c echo escaped 2>/dev/null)" && printf '%s' "$out" | grep -q escaped; then win_exec="$exe"; fi
done
[ "$win_exec" = "no" ] && add launch_windows_exe blocked false "no Windows executable could be launched" \
                       || add launch_windows_exe blocked true "launched $win_exec"
if printf '%s' "$PATH" | grep -qi '/mnt/'; then add windows_path_leak blocked true "$PATH"; else add windows_path_leak blocked false "PATH has no Windows entries"; fi
[ -n "${WSL_INTEROP:-}" ] && add interop_socket_env info true "WSL_INTEROP=${WSL_INTEROP}" || add interop_socket_env info false "not set"

# 5. Canary file created in the Windows user profile: visible anywhere?
if [ -n "$CANARY_NAME" ]; then
  hit="$(timeout 60 find / -xdev -name "$CANARY_NAME" 2>/dev/null | head -n1)"
  [ -n "$hit" ] && add canary_visible blocked true "$hit" || add canary_visible blocked false "canary not found"
fi

# 6. Network reachability (informational: Phase 8 adds an egress allowlist)
gw="$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')"
if [ "$HOST_PORT" != "0" ]; then
  if timeout 3 bash -c "</dev/tcp/127.0.0.1/$HOST_PORT" 2>/dev/null; then
    add windows_localhost_port info true "reached Windows 127.0.0.1:$HOST_PORT (mirrored networking)"
  else
    add windows_localhost_port info false "Windows localhost listener not reachable"
  fi
  if [ -n "$gw" ] && timeout 3 bash -c "</dev/tcp/$gw/$HOST_PORT" 2>/dev/null; then
    add windows_host_via_gateway info true "reached $gw:$HOST_PORT"
  else
    add windows_host_via_gateway info false "gateway ${gw:-none} port $HOST_PORT not reachable"
  fi
fi
if timeout 8 curl -fsS -o /dev/null https://example.com 2>/dev/null; then
  add internet_egress info true "https://example.com reachable (expected until Phase 8 allowlist)"
else
  add internet_egress info false "no internet"
fi

# 7. Environment summary
kernel="$(uname -r)"
is_wsl=false; grep -qi microsoft /proc/version 2>/dev/null && is_wsl=true

escapes=0
for r in "${results[@]}"; do case "$r" in *'"expected":"blocked","escaped":true'*) escapes=$((escapes+1));; esac; done

{
  printf '{"spike":"isolation","is_wsl":%s,"kernel":"%s","user":"%s","escapes":%d,"checks":[' \
    "$is_wsl" "$kernel" "$(id -un)" "$escapes"
  (IFS=,; printf '%s' "${results[*]}")
  printf ']}\n'
} > "$OUT_DIR/isolation.json"

cat "$OUT_DIR/isolation.json"
if [ "$escapes" -eq 0 ]; then echo "ISOLATION: no escapes"; else echo "ISOLATION: $escapes ESCAPE(S) FOUND"; fi
