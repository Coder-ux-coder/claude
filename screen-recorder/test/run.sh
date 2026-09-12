#!/usr/bin/env bash
#
# run.sh — unit tests for screenrec's pure logic.
#
# Screen capture itself cannot run in CI (no display, no macOS), so these test
# the fragile parts that do not need a screen: parsing ffmpeg's device listing,
# picking the right display, building the ffmpeg command, and forming the output
# path. The recorder is sourced, so main() never runs.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../bin/screenrec"

pass=0; fail=0; failures=()
eq() { # eq <name> <actual> <expected>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"
  else fail=$((fail+1)); failures+=("$1"); printf '  \033[31m✗ %s\033[0m\n     got:      %s\n     expected: %s\n' "$1" "$2" "$3"; fi
}
has() { # has <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"
  else fail=$((fail+1)); failures+=("$1"); printf '  \033[31m✗ %s\033[0m (missing: %s)\n' "$1" "$3"; fi
}
missing() { # missing <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then fail=$((fail+1)); failures+=("$1"); printf '  \033[31m✗ %s\033[0m (should not contain: %s)\n' "$1" "$3"
  else pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; fi
}

# A realistic dump from `ffmpeg -f avfoundation -list_devices true -i ""`.
SAMPLE='ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
[AVFoundation indev @ 0x14e004f00] AVFoundation video devices:
[AVFoundation indev @ 0x14e004f00] [0] FaceTime HD Camera
[AVFoundation indev @ 0x14e004f00] [1] Capture screen 0
[AVFoundation indev @ 0x14e004f00] [2] Capture screen 1
[AVFoundation indev @ 0x14e004f00] AVFoundation audio devices:
[AVFoundation indev @ 0x14e004f00] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x14e004f00] [1] Capture screen 0
: Input/output error'

printf '\n\033[1mParsing ffmpeg device listing\033[0m\n'
PARSED="$(printf '%s\n' "$SAMPLE" | parse_screen_devices)"
eq   "finds both screen-capture devices" "$(printf '%s\n' "$PARSED" | grep -c "Capture screen")" "2"
has  "keeps the avfoundation index for screen 0" "$PARSED" "1	Capture screen 0"
has  "keeps the avfoundation index for screen 1" "$PARSED" "2	Capture screen 1"
missing "excludes the camera" "$PARSED" "FaceTime"
missing "excludes the microphone (audio section ignored)" "$PARSED" "Microphone"

printf '\n\033[1mPicking a display\033[0m\n'
eq "no selector picks the first screen"        "$(printf '%s\n' "$PARSED" | pick_device_index '')"  "1"
eq "selector 0 maps to 'Capture screen 0'"     "$(printf '%s\n' "$PARSED" | pick_device_index '0')" "1"
eq "selector 1 maps to 'Capture screen 1'"     "$(printf '%s\n' "$PARSED" | pick_device_index '1')" "2"
eq "an out-of-range selector falls back safely" "$(printf '%s\n' "$PARSED" | pick_device_index '9')" "1"

# A machine with the screen listed before the camera — index must not be assumed.
ALT='[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] Capture screen 0
[AVFoundation indev @ 0x1] [1] FaceTime HD Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:'
eq "index is read, never assumed to be 1" \
  "$(printf '%s\n' "$ALT" | parse_screen_devices | pick_device_index '')" "0"

printf '\n\033[1mBuilding the ffmpeg command\033[0m\n'
CMD="$(build_ffmpeg_cmd 2 30 /tmp/out.mp4 videotoolbox 1)"
has "records the chosen avfoundation device"  "$CMD" "2:none"
has "screen only — audio input is ':none'"    "$CMD" "2:none"
has "uses avfoundation"                        "$CMD" "avfoundation"
has "passes the frame rate"                     "$CMD" $'-framerate\n30'
has "captures the cursor"                        "$CMD" $'-capture_cursor\n1'
has "uses the hardware encoder when available"  "$CMD" "h264_videotoolbox"
has "writes the requested output file"           "$CMD" "/tmp/out.mp4"
has "web-ready moov placement"                    "$CMD" "+faststart"
has "compatible pixel format"                      "$CMD" "yuv420p"
missing "never opens an audio device"               "$CMD" ":default"
missing "no microphone capture"                      "$CMD" "-i :"

CMD60="$(build_ffmpeg_cmd 1 60 /tmp/a.mp4 x264 1)"
has "60 fps is honoured"           "$CMD60" $'-framerate\n60'
has "falls back to libx264"        "$CMD60" "libx264"
missing "no hardware encoder in the fallback" "$CMD60" "videotoolbox"

printf '\n\033[1mOutput path\033[0m\n'
eq "path is composed cleanly" \
  "$(output_path /Users/me/Movies 2026-09-12_14-30-00 mp4)" \
  "/Users/me/Movies/screen-2026-09-12_14-30-00.mp4"
eq "a trailing slash on the dir is tolerated" \
  "$(output_path /Users/me/Movies/ 2026-09-12_14-30-00 mov)" \
  "/Users/me/Movies/screen-2026-09-12_14-30-00.mov"

printf '\n\033[1mArgument parsing\033[0m\n'
( parse_args --fps 60 --display 1; [ "$FPS" = 60 ] && [ "$DISPLAY_SEL" = 1 ] ) \
  && { pass=$((pass+1)); printf '  \033[32m✓\033[0m --fps and --display are read\n'; } \
  || { fail=$((fail+1)); failures+=("arg parse"); printf '  \033[31m✗ arg parse\033[0m\n'; }
( parse_args --fps abc 2>/dev/null ) \
  && { fail=$((fail+1)); failures+=("rejects bad fps"); printf '  \033[31m✗ rejects non-numeric fps\033[0m\n'; } \
  || { pass=$((pass+1)); printf '  \033[32m✓\033[0m a non-numeric --fps is rejected\n'; }

printf '\n%s%d passed, %d failed%s\n' "$([ $fail -eq 0 ] && printf '\033[32m' || printf '\033[31m')" "$pass" "$fail" $'\033[0m'
if [ $fail -ne 0 ]; then printf '\nFailures:\n'; for f in "${failures[@]}"; do printf '  - %s\n' "$f"; done; exit 1; fi
