#!/usr/bin/env bash
#
# Gmail Workflow Automation — installer
#
# Downloads the Apps Script source, creates the script project in your Google
# account, and uploads it. Run it on any laptop; it installs nothing system-wide
# and needs no administrator rights.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/gmail-workflow-automation/install.sh)
#
# Options:
#   --dir <path>       where to keep the local copy (default ~/gmail-workflow-automation)
#   --title <name>     Apps Script project title
#   --timezone <tz>    IANA timezone; detected from this machine if omitted
#   --no-localhost     for SSH sessions: paste an auth code instead of opening a browser
#   --update           re-upload the code to the existing project, change nothing else
#
set -euo pipefail

# clasp runs on Node and emits deprecation warnings that mean nothing to the
# person installing this. Keep the output readable.
export NODE_NO_WARNINGS=1

REPO_RAW="${GWA_SOURCE:-https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/gmail-workflow-automation}"
CLASP_VERSION="2.4.2"   # pinned: clasp 3.x renamed these commands
TARGET_DIR="${HOME}/gmail-workflow-automation"
TITLE="Gmail Workflow Automation"
TIMEZONE=""
LOGIN_FLAGS=""
UPDATE_ONLY=0

SRC_FILES=(
  Config.gs Store.gs Workflow.gs Transcript.gs Prompt.gs
  Classifier.gs Labels.gs Scanner.gs Digest.gs Main.gs Tests.gs
)

# ---- presentation ----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; Z=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$Z" "$B" "$*" "$Z"; }
warn() { printf '%s !  %s%s\n' "$Y" "$*" "$Z"; }
die()  { printf '\n%s ✗  %s%s\n\n' "$R" "$*" "$Z" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          TARGET_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --title)        TITLE="${2:?--title needs a name}"; shift 2 ;;
    --timezone|--tz) TIMEZONE="${2:?--timezone needs an IANA name}"; shift 2 ;;
    --no-localhost) LOGIN_FLAGS="--no-localhost"; shift ;;
    --update)       UPDATE_ONLY=1; shift ;;
    -h|--help)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown option: $1  (try --help)" ;;
  esac
done

cat <<BANNER

${B}Gmail Workflow Automation${Z}
${DIM}Labels your conversations by whose move it is, and keeps unfinished
matters visible. Runs on Google's servers — so it covers every device
signed in to the mailbox, with nothing installed on any of them.${Z}
BANNER

# ---- 1. preflight ----------------------------------------------------------
step "Checking prerequisites"

command -v curl >/dev/null 2>&1 || die "curl is required but not installed."

if ! command -v node >/dev/null 2>&1; then
  say ""
  say "Node.js is required (version 18 or newer). It is not installed."
  say ""
  case "$(uname -s)" in
    Darwin) say "  Install it with:  ${B}brew install node${Z}" ;;
    Linux)  say "  Install it with:  ${B}sudo apt install nodejs npm${Z}   (Debian/Ubuntu)" ;;
  esac
  say "  Or download it from ${B}https://nodejs.org${Z}"
  say ""
  die "Install Node.js, then run this again."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))."
command -v npm >/dev/null 2>&1 || die "npm is required but not installed."
say "  node $(node -v), npm $(npm -v)"

# ---- 2. timezone -----------------------------------------------------------
if [ -z "$TIMEZONE" ]; then
  if [ -r /etc/timezone ]; then
    TIMEZONE="$(tr -d '[:space:]' < /etc/timezone)"
  elif [ -L /etc/localtime ]; then
    TIMEZONE="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
  elif command -v systemsetup >/dev/null 2>&1; then
    TIMEZONE="$(systemsetup -gettimezone 2>/dev/null | sed 's/.*: //')"
  fi
fi
if [ -z "$TIMEZONE" ] || ! printf '%s' "$TIMEZONE" | grep -q '/'; then
  TIMEZONE="Asia/Karachi"
  warn "Could not detect this machine's timezone — using $TIMEZONE."
  warn "Change it later in the config tab of the state spreadsheet."
else
  say "  timezone $TIMEZONE"
fi

# ---- 3. download -----------------------------------------------------------
step "Downloading the source"
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

fetch() { # fetch <remote-path> <local-path>
  curl -fsSL --retry 3 --retry-delay 2 "$REPO_RAW/$1" -o "$2.part" \
    || die "Could not download $1 — check your internet connection."
  [ -s "$2.part" ] || die "Downloaded $1 but it was empty."
  mv "$2.part" "$2"
}

for f in "${SRC_FILES[@]}"; do
  fetch "src/$f" "$f"
  printf '  %s\n' "$f"
done
fetch "src/appsscript.json" "appsscript.json"

# Stamp the detected timezone into the manifest.
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("appsscript.json", "utf8"));
  m.timeZone = process.argv[1];
  fs.writeFileSync("appsscript.json", JSON.stringify(m, null, 2) + "\n");
' "$TIMEZONE"
say "  appsscript.json (timezone set to $TIMEZONE)"

# ---- 4. clasp --------------------------------------------------------------
step "Installing the Google Apps Script CLI (locally, no admin rights needed)"
[ -f package.json ] || printf '{"name":"gwa-install","private":true}\n' > package.json
npm install --no-fund --no-audit --silent "@google/clasp@${CLASP_VERSION}" >/dev/null 2>&1 \
  || die "Could not install clasp. Check your internet connection and try again."
CLASP="$TARGET_DIR/node_modules/.bin/clasp"
[ -x "$CLASP" ] || die "clasp did not install correctly at $CLASP"
say "  clasp $("$CLASP" --version 2>/dev/null || echo "$CLASP_VERSION")"

# ---- 5. sign in ------------------------------------------------------------
step "Signing in to Google"

# Note: `clasp login --status` exits 0 whether or not you are signed in, and
# only says which in its output — so check the text and the credentials file,
# never the exit code.
clasp_identity() {
  "$CLASP" login --status 2>/dev/null | grep -iv 'deprecat' | grep -i 'logged in' | head -1 || true
}
IDENTITY="$(clasp_identity)"

if [ -f "$HOME/.clasprc.json" ] && [ -n "$IDENTITY" ] \
   && ! printf '%s' "$IDENTITY" | grep -qi 'not logged in'; then
  say "  $IDENTITY"
else
  if [ -n "$LOGIN_FLAGS" ]; then
    cat <<'NOTE'

  Open the link below in any browser, sign in with the Google account
  whose mailbox you want automated, allow access, then paste the code
  back here.

NOTE
  else
    cat <<'NOTE'

  A browser window will open. Sign in with the Google account whose
  mailbox you want automated, and allow access.

  If nothing opens — over SSH, or on a machine with no browser — press
  Ctrl+C and run this again with --no-localhost to paste a code instead.

NOTE
  fi
  # shellcheck disable=SC2086
  "$CLASP" login $LOGIN_FLAGS || die "Sign-in failed or was cancelled."

  IDENTITY="$(clasp_identity)"
  if [ ! -f "$HOME/.clasprc.json" ] || printf '%s' "$IDENTITY" | grep -qi 'not logged in'; then
    die "Sign-in did not complete. Run it again, or use --no-localhost over SSH."
  fi
  say "  $IDENTITY"
fi

# ---- 6. create or update ---------------------------------------------------
if [ -f .clasp.json ]; then
  step "Updating the existing script project"
else
  [ "$UPDATE_ONLY" -eq 1 ] && die "--update was given, but no project exists here yet."
  step "Creating the script project in your Google account"
  if ! "$CLASP" create --type standalone --title "$TITLE" --rootDir "$TARGET_DIR" 2>/tmp/gwa_create.log; then
    if grep -qi "user has not enabled the Apps Script API" /tmp/gwa_create.log; then
      cat <<'APIFIX'

  Google needs one switch turned on before a script can be created
  from the command line. It takes about ten seconds:

      1. Open  https://script.google.com/home/usersettings
      2. Turn ON "Google Apps Script API"
      3. Run this installer again

APIFIX
      die "Apps Script API is switched off for this account."
    fi
    if grep -qi "Could not read API credentials" /tmp/gwa_create.log; then
      rm -f "$HOME/.clasprc.json"
      die "Google sign-in has expired. Run this installer again to sign in afresh."
    fi
    grep -iv 'deprecat' /tmp/gwa_create.log | sed 's/^/  /' >&2
    die "Could not create the script project."
  fi
fi

step "Uploading the code"
"$CLASP" push -f >/dev/null 2>&1 || die "Upload failed. Run '$CLASP push -f' here to see why."
say "  12 files uploaded"

SCRIPT_ID="$(node -p 'JSON.parse(require("fs").readFileSync(".clasp.json","utf8")).scriptId' 2>/dev/null || echo "")"
SCRIPT_URL="https://script.google.com/d/${SCRIPT_ID}/edit"

# ---- 7. hand off to the browser -------------------------------------------
cat <<FINISH

${G}────────────────────────────────────────────────────────────${Z}
${B}The code is installed. Three things left, all in the browser.${Z}
${G}────────────────────────────────────────────────────────────${Z}

Your project:
  ${B}${SCRIPT_URL}${Z}

${B}1. Add your Anthropic API key${Z}
   In that project: the gear icon (Project Settings) → Script Properties
   → Add script property.
       Property:  ${B}ANTHROPIC_API_KEY${Z}
       Value:     your key from https://console.anthropic.com
   → Save script properties.

${B}2. Run setup${Z}
   Back in the editor, pick ${B}setup${Z} from the function dropdown → Run.
   Google will ask for permission — choose the account, then
   "Advanced" → "Go to ${TITLE} (unsafe)" → "Allow".
   That warning is normal for a private script you installed yourself.

${B}3. Look before you trust it${Z}
   Run ${B}testApiConnection${Z}  — one real call, proves the key works.
   Run ${B}previewScan${Z}        — decides everything, changes nothing.
   Read the log, then let the 15-minute timer take over.

${DIM}Local copy:     ${TARGET_DIR}
To re-upload:   bash ${TARGET_DIR}/install.sh --update
To stop it:     run removeAllTriggers() in the editor${Z}

FINISH

if command -v open >/dev/null 2>&1; then open "$SCRIPT_URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$SCRIPT_URL" >/dev/null 2>&1 || true
fi

cp "$0" "$TARGET_DIR/install.sh" 2>/dev/null || true
exit 0
