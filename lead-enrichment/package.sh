#!/usr/bin/env bash
# Build the handover archive of the *system* -- the thing you send to a client
# who is buying the pipeline rather than a one-off list.
#
#   ./package.sh
#
# Refuses to run if anything secret is staged for inclusion. That check is the
# whole point of having a script instead of a zip command in your history.
set -euo pipefail
cd "$(dirname "$0")"

NAME="lead-enrichment"
STAMP="$(date +%Y%m%d)"
DIST="dist"
STAGE="$DIST/$NAME"
ARCHIVE="$DIST/$NAME-$STAMP.zip"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE"

# Everything a recipient needs to run it, and nothing that identifies you.
# tar-to-tar rather than rsync, which is absent on stock macOS and most images.
tar -cf - \
  --exclude='./.env' \
  --exclude='./.git' \
  --exclude='./dist' \
  --exclude='./data' \
  --exclude='./data_uitest' \
  --exclude='./out' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache' \
  --exclude='*.sqlite3*' \
  . | ( cd "$STAGE" && tar -xf - )

# --- the check that matters -------------------------------------------------
# A key pasted into a config file, a committed .env, a real spreadsheet id: any
# of these leaves your account in someone else's hands. Look before sealing.
LEAKS=$(grep -rIlE \
  '(sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|BEGIN [A-Z ]*PRIVATE KEY)' \
  "$STAGE" 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  echo "REFUSING TO PACKAGE -- credential-shaped strings found in:" >&2
  echo "$LEAKS" >&2
  exit 1
fi
if [ -e "$STAGE/.env" ]; then
  echo "REFUSING TO PACKAGE -- .env made it into the staging folder." >&2
  exit 1
fi

# python3 rather than the zip binary: python3 is already a hard requirement of
# this project, and `zip` is absent from many minimal images.
python3 - "$DIST" "$NAME" "$ARCHIVE" <<'PYZIP'
import sys, zipfile
from pathlib import Path
dist, name, archive = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
stage = dist / name
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(stage.rglob("*")):
        if not f.is_file():
            continue
        arcname = str(Path(name) / f.relative_to(stage))
        info = zipfile.ZipInfo.from_file(f, arcname)
        # from_file drops the mode on some paths; set it explicitly so the
        # launchers survive the round trip. A run.sh that arrives without its
        # execute bit is a support request from every recipient on macOS.
        info.external_attr = (f.stat().st_mode & 0xFFFF) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, f.read_bytes())
PYZIP
rm -rf "$STAGE"

echo
echo "  Package ready:  $ARCHIVE"
echo "  Size:           $(du -h "$ARCHIVE" | cut -f1)"
echo
echo "  It contains the code, the tests, the Make.com blueprints, the sheet"
echo "  template and all documentation. It contains no keys and no run data."
echo
echo "  Tell the recipient to start with START_HERE.md."
