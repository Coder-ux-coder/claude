#!/usr/bin/env bash
#
# screenrec installer — macOS screen recorder for YouTube content.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder/install.sh)
#
# Installs the `screenrec` command into ~/.local/bin, makes sure a recording
# engine is present (ffmpeg if it can, the built-in macOS recorder otherwise),
# and then starts recording your screen. Screen only — it never records the mic.
#
# Nothing is installed system-wide and no administrator password is needed
# (unless you choose to let it install Homebrew/ffmpeg for higher quality).
#
set -euo pipefail
export NODE_NO_WARNINGS=1

REPO_RAW="${SCREENREC_SOURCE:-https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder}"
BIN_DIR="${HOME}/.local/bin"
NO_START=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
else B=""; DIM=""; G=""; Y=""; R=""; Z=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$Z" "$B" "$*" "$Z"; }
warn() { printf '%s !  %s%s\n' "$Y" "$*" "$Z"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$*" "$Z" >&2; exit 1; }
ask()  { local a; printf '%s [y/N] ' "$1" > /dev/tty; read -r a < /dev/tty || a=""; [[ "$a" =~ ^[Yy]$ ]]; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1; shift ;;
    --dir)      BIN_DIR="${2:?--dir needs a path}"; shift 2 ;;
    -h|--help)  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *)          die "Unknown option: $1" ;;
  esac
done

cat <<BANNER

${B}screenrec — macOS screen recorder${Z}
${DIM}Records your screen to a video file ready to upload to YouTube.
Screen only: it does not record the microphone or any audio.${Z}
BANNER

# ---- 1. platform -----------------------------------------------------------
step "Checking your Mac"
[ "$(uname -s)" = "Darwin" ] || die "This recorder is for macOS. (Detected: $(uname -s).)"
command -v curl >/dev/null 2>&1 || die "curl is required but not found."
say "  macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"

# ---- 2. recording engine ---------------------------------------------------
step "Checking the recording engine"
if command -v ffmpeg >/dev/null 2>&1; then
  say "  ffmpeg found — best quality, full control over frame rate."
elif command -v brew >/dev/null 2>&1; then
  say "  ffmpeg gives the best quality (chosen frame rate, hardware encoding)."
  if ask "  Install it now with Homebrew?"; then
    brew install ffmpeg || warn "ffmpeg install failed — will use the built-in recorder instead."
  else
    say "  Skipping — the built-in macOS recorder will be used."
  fi
else
  warn "Homebrew (and ffmpeg) not found."
  say  "  The built-in macOS recorder will be used — it works with no install."
  say  "  ${DIM}For higher quality later, install Homebrew from https://brew.sh then: brew install ffmpeg${Z}"
fi

# ---- 3. install the command ------------------------------------------------
step "Installing the screenrec command"
mkdir -p "$BIN_DIR"
curl -fsSL --retry 3 --retry-delay 2 "$REPO_RAW/bin/screenrec" -o "$BIN_DIR/screenrec.part" \
  || die "Could not download screenrec — check your internet connection."
[ -s "$BIN_DIR/screenrec.part" ] || die "Downloaded screenrec but it was empty."
head -1 "$BIN_DIR/screenrec.part" | grep -q '^#!/usr/bin/env bash' \
  || die "Downloaded screenrec looks wrong (not a shell script)."
mv "$BIN_DIR/screenrec.part" "$BIN_DIR/screenrec"
chmod +x "$BIN_DIR/screenrec"
say "  installed → $BIN_DIR/screenrec"

# ---- 4. PATH ---------------------------------------------------------------
if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  case "${SHELL##*/}" in zsh) PROFILE="${HOME}/.zshrc" ;; bash) PROFILE="${HOME}/.bash_profile" ;; *) PROFILE="${HOME}/.profile" ;; esac
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
  grep -qsF "$LINE" "$PROFILE" 2>/dev/null || printf '\n# added by screenrec installer\n%s\n' "$LINE" >> "$PROFILE"
  export PATH="$BIN_DIR:$PATH"
  say "  added $BIN_DIR to your PATH (in ${PROFILE##*/})"
fi

# ---- 5. one-time permission note -------------------------------------------
step "One-time macOS permission"
cat <<PERM
  macOS asks each app for permission before it may record the screen. The first
  time you record, either macOS will pop a request, or the video will come out
  black. If that happens:

    ${B}System Settings → Privacy & Security → Screen & System Audio Recording${Z}
    → turn it on for your terminal (Terminal or iTerm)
    → quit the terminal fully and reopen it

  This is a normal one-time step for every screen recorder on macOS.
PERM

# ---- 6. go -----------------------------------------------------------------
if [ "$NO_START" -eq 1 ]; then
  cat <<DONE

${G}Done.${Z} Start recording any time with:

    ${B}screenrec${Z}                 record the main screen
    ${B}screenrec --fps 60${Z}        smoother, 60 fps
    ${B}screenrec --list${Z}          show your displays
    ${B}screenrec --help${Z}

Stop a recording with ${B}q${Z} (ffmpeg) or ${B}Ctrl+C${Z} (built-in). Videos are
saved to ${B}~/Movies/ScreenRecordings${Z}.
DONE
  exit 0
fi

step "Starting your first recording"
say "  ${DIM}(If this is black, grant the permission above and run 'screenrec' again.)${Z}"
say ""
exec "$BIN_DIR/screenrec"
