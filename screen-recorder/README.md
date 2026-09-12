# screenrec — screen recorder for YouTube

A one-command screen recorder for making YouTube videos. It records the screen
(and the mouse cursor) to a video file ready to upload. **Screen only — it never
records the microphone or any audio.** Works on Windows and macOS.

---

## Windows

Open **PowerShell** and paste:

```powershell
irm https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder/install.ps1 | iex
```

It checks for **ffmpeg** (and offers to install it with `winget` if missing),
installs a `screenrec` command into `%LOCALAPPDATA%\Programs\screenrec`, adds it
to your PATH, and starts recording. Only the optional ffmpeg install may ask for
administrator rights.

Then, any time:

```powershell
screenrec                 # record the whole desktop
screenrec -Fps 60         # smoother motion — good for fast action
screenrec -Display 1      # record only the second monitor
screenrec -List           # show your monitors
screenrec -Hw             # use a hardware encoder (nvenc/qsv/amf) if present
screenrec -Out C:\Users\you\Desktop\take1.mp4
screenrec -Help
```

**Stop and save:** press **`q`** in the window. Videos save to
`%USERPROFILE%\Videos\ScreenRecordings\`.

**Good to know on Windows:** no special permission is needed, but protected/DRM
windows (Netflix and some players) record as **black**, and a game in
**exclusive-fullscreen** may not capture — switch it to *borderless windowed*
mode, or try `-Hw`.

> If PowerShell says it "cannot be loaded because running scripts is disabled",
> the `irm … | iex` line above still works (it runs in memory, not from a file),
> and the installed `screenrec` command uses a `.cmd` wrapper that sidesteps the
> policy. Nothing to change.

---

## macOS

Open **Terminal** and paste:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder/install.sh)
```

It installs `screenrec` into `~/.local/bin`, ensures a recording engine (offers
`brew install ffmpeg`, or uses the built-in macOS recorder with no install), and
starts recording. Then:

```bash
screenrec                 # record the main screen
screenrec --fps 60
screenrec --display 1
screenrec --list
screenrec --help
```

**Stop and save:** press **`q`** (ffmpeg) or **`Ctrl+C`** (built-in engine).
Videos save to `~/Movies/ScreenRecordings/`.

**One-time macOS permission:** the first recording may be black until you grant
**System Settings → Privacy & Security → Screen &amp; System Audio Recording** for
your terminal, then quit and reopen it. Normal for every Mac screen recorder.

---

## What it records, and what it does not

- **Records:** the display you choose, plus the mouse cursor.
- **Does not record:** the microphone, system audio, the webcam, or any other
  device. On both platforms the recorder opens no audio input at all — there is
  no flag to turn the mic on, by design.

If you later want your voice on a video, record the narration separately and add
it in a video editor. You get far better control over levels that way than
capturing a live mic.

## Tips for YouTube

- **1080p or 1440p** records sharpest; on a very high-DPI screen, scale the
  desktop down first so text stays crisp after YouTube re-encodes it.
- **60 fps** (`-Fps 60` / `--fps 60`) for fast motion — scrolling, animation,
  games. **30** is easier on the machine and fine for tutorials.
- On Windows, `-Hw` moves encoding to the GPU, which keeps recording smooth on a
  busy CPU. On macOS the ffmpeg engine already uses the hardware encoder when it
  can.
- Record a few seconds and check the file before a long take — it is also the
  quickest way to confirm capture is working (and, on macOS, that the permission
  is granted).

## Testing

```bash
bash test/run.sh                                  # macOS logic — 28 assertions
powershell -ExecutionPolicy Bypass -File test\run.ps1   # Windows logic — 23 assertions
```

Screen capture itself cannot run in CI (no display), so the tests cover the
fragile logic that does not need a screen: choosing the encoder, building the
recording command, selecting a monitor, and forming the output path — and both
suites assert that the built command opens **no audio device**. Each recorder is
written so this logic can be sourced and tested without ever starting a
recording.

## Layout

| File | Purpose |
|---|---|
| `install.ps1` / `install.sh` | One-command installers (Windows / macOS) |
| `bin/screenrec.ps1` | Windows recorder — pure functions, then `Invoke-Main` |
| `bin/screenrec.cmd` | Windows launcher so `screenrec` runs from any shell |
| `bin/screenrec` | macOS recorder — pure logic, then `main` |
| `test/run.ps1`, `test/run.sh` | Unit tests for the pure logic |

Windows uses ffmpeg's `gdigrab`; macOS prefers ffmpeg's `avfoundation` and falls
back to the built-in `screencapture`.

## Removing it

**Windows:** delete `%LOCALAPPDATA%\Programs\screenrec` and remove that folder
from your PATH (System → *Edit environment variables for your account*).
**macOS:** `rm ~/.local/bin/screenrec`.

Delete the `ScreenRecordings` folder if you want the videos gone too. Nothing
else is left behind. (If you let the installer add ffmpeg: `winget uninstall
Gyan.FFmpeg` on Windows, `brew uninstall ffmpeg` on macOS.)
