# screenrec — macOS screen recorder

A one-command screen recorder for making YouTube videos on your Mac. It records
the screen (and the mouse cursor) to a video file ready to upload. **Screen
only — it never records the microphone or any audio.**

## Install and start recording

Paste this into the Terminal on your Mac:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder/install.sh)
```

It installs the `screenrec` command into `~/.local/bin`, makes sure a recording
engine is present, and starts recording. Nothing is installed system-wide and no
administrator password is needed — unless you let it install ffmpeg for higher
quality, which it will ask about first.

## Using it after install

```bash
screenrec                 # record the main screen
screenrec --fps 60        # smoother motion — good for fast on-screen action
screenrec --display 1     # record the second display
screenrec --list          # show which displays can be recorded
screenrec --out ~/Desktop/take1.mp4
screenrec --help
```

**To stop and save:** press `q` (with ffmpeg) or `Ctrl+C` (built-in engine).

Videos are saved to **`~/Movies/ScreenRecordings/`** with a timestamped name
like `screen-2026-09-12_14-30-00.mp4`, and Finder opens to show the file when
you stop.

## The one-time macOS permission

macOS asks each app for permission before it may record the screen. The **first**
time you record, either macOS pops a request, or the video comes out black. If
that happens:

1. **System Settings → Privacy & Security → Screen &amp; System Audio Recording**
2. Turn it on for your terminal (Terminal or iTerm)
3. **Quit the terminal completely and reopen it**, then run `screenrec` again

This is a normal one-time step for every screen recorder on macOS, not something
specific to this tool.

## Two engines

The recorder uses whichever is available, preferring the first:

| Engine | Quality | Frame-rate control | Multi-display pick | Needs installing |
|---|---|---|---|---|
| **ffmpeg** | Best — hardware H.264 (`h264_videotoolbox`) when your Mac supports it, `libx264` otherwise | Yes (`--fps`) | Yes (`--display`) | `brew install ffmpeg` (installer offers this) |
| **built-in** (`screencapture -v`) | Good | Fixed | Main display | No — ships with macOS |

For YouTube, ffmpeg is worth the one-time install: it lets you choose 60 fps for
fast motion, uses the GPU so recording does not bog the machine down, and writes
a web-optimised file (`+faststart`). The built-in engine is the zero-install
fallback and is perfectly fine for straightforward screencasts.

## What it records, and what it does not

- **Records:** the display you choose, plus the mouse cursor.
- **Does not record:** the microphone, system audio, the webcam, or any other
  device. The audio input is hard-wired to "none" — there is no flag to turn on
  the mic, by design.

If you later want your voice on a YouTube video, the clean way is to record the
narration separately and add it in a video editor, which also gives you far
better control over levels than capturing live.

## Tips for YouTube

- **1080p or 1440p** display resolution records sharpest; scale the desktop down
  first if your panel is very high-DPI, so text stays crisp after YouTube
  re-encodes.
- **`--fps 60`** for anything with fast motion (scrolling, animation, games);
  **30** is smoother on the CPU and fine for talking-head tutorials.
- Record a few seconds, stop, and check the file before recording something long
  — that is also the quickest way to confirm the screen permission is granted.

## Testing

```bash
bash test/run.sh      # 28 assertions, no screen or macOS required
```

Screen capture itself cannot run in CI, so the tests cover the fragile logic
that does not need a display: parsing ffmpeg's device listing (the screen-capture
device index is read, never assumed), selecting the right display, building the
ffmpeg command, and forming the output path. The recorder is written so this
logic can be sourced and tested without ever starting a recording — and the
tests assert that the built command opens **no** audio device.

## Layout

| File | Purpose |
|---|---|
| `install.sh` | The one-command installer |
| `bin/screenrec` | The recorder — pure logic up top, `main()` below |
| `test/run.sh` | Unit tests for the pure logic |

## Removing it

```bash
rm ~/.local/bin/screenrec
```

Delete `~/Movies/ScreenRecordings` if you want the videos gone too. Nothing else
is left on the system. (If you let the installer add `ffmpeg`, remove it with
`brew uninstall ffmpeg`.)
