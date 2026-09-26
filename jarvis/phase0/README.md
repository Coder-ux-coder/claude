# JARVIS Phase 0: verification kit

Phase 0 checks, on **your** PC, the facts the design depends on before any
JARVIS code is built (see `docs/jarvis/13-build-plan.md`). You run it; nothing
here runs by itself. The results come back to me as one zip, and Phase 1 is
adjusted to whatever they show.

Your choices this kit follows:

| Choice | How the kit applies it |
|---|---|
| Boss model: Claude Opus 5.5 | `boss-eval` uses `claude-opus-5-5` by default |
| General data may go to the cloud model | The boss eval sends only the HYPOTHETICAL test scenarios in `node/boss-eval/scenarios.json` |
| Passwords and API keys stay local | The API key is read from this terminal's environment only and never written anywhere. Claude Code and Codex log in inside the isolated distro; their tokens never leave it. The eval also tests that the model never repeats or remembers a secret (S10, S11, S30) |
| Enable WSL2 | Step 2 |
| Windows Home or Pro | Detected automatically in step 1. Everything here works on Home. Windows Sandbox (Pro only) is recorded, not required |

## What changes your system

| Step | Changes | Undo |
|---|---|---|
| 1, 4, 8, 10, 12 | Nothing (read-only, temporary files cleaned up) | n/a |
| 2 | Turns on WSL2 (Windows features + WSL platform). Usually needs a reboot | `wsl --uninstall`, then turn off "Virtual Machine Platform" in Windows Features |
| 3 | Adds a new WSL distro `jarvis-workshop` (~2 GB) | `wsl --unregister jarvis-workshop` |
| 5 | Installs Claude Code and Codex **inside** that distro only; you log in once | Removed with the distro |
| 6, 7 | One scheduled task `JarvisPhase0-WakeTest`, removed again by step 7 | `Unregister-ScheduledTask JarvisPhase0-WakeTest` |
| 9 | Installs Node.js 22 LTS on Windows if you don't have it; npm packages go into `node\node_modules` only | Uninstall Node.js; delete the folder |
| 11 | Spends API credit (the script shows an estimate first and asks) | n/a |

Every file the kit writes goes to `%LOCALAPPDATA%\JarvisPhase0\`. Result files
have your Windows user name and computer name replaced with `<redacted>`.

## Before you start

1. Get the kit: download this repository branch as a zip (or `git clone`) and
   extract it, e.g. to `C:\jarvis-kit`.
2. Open **PowerShell** (Windows PowerShell 5.1, the blue one; that's what the
   UI Automation step needs) and allow the kit's scripts for this window only:

   ```powershell
   cd C:\jarvis-kit\jarvis\phase0\windows
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   Get-ChildItem .. -Recurse -File | Unblock-File
   ```

## Run order

| # | Command | Window | Time |
|---|---|---|---|
| 1 | `.\01-Invoke-Inventory.ps1` | **Administrator** (for TPM and feature checks) | 1 min |
| 2 | `.\02-Enable-Wsl2.ps1` then **reboot** if it says so | **Administrator** | 5 min |
| 3 | `.\03-New-JarvisWorkshop.ps1` | normal | 5-15 min |
| 4 | `.\04-Test-WorkshopIsolation.ps1` | normal | 2 min |
| 5 | `.\05-Test-CodingWorkers.ps1` | normal | 10 min, interactive logins |
| 6 | `.\06-Register-WakeTest.ps1 -PowerLabel mains` then **Sleep** the PC | normal | 5 min |
| 7 | after it wakes (or you wake it): `.\07-Complete-WakeTest.ps1` | normal | 1 min |
| 6-7 again | laptop only: unplug the charger, repeat with `-PowerLabel battery` | normal | 6 min |
| 8 | open 5 apps you use daily, then `.\08-Test-UiAutomation.ps1 -AppNames msedge,explorer,OUTLOOK,WINWORD,Code -LockTest` (use your own apps' process names; step 8 prints the running ones) | normal | 2 min |
| 9 | Node.js: `node --version` must print v22 or later; if not, `winget install OpenJS.NodeJS.LTS` and open a new window. Then `cd ..\node` and `npm install` | normal | 3 min |
| 10 | `node sqlite-spike.mjs` and `node browser-spike.mjs` (add `--headed` to watch; it uses Edge, or Chrome with `--channel chrome`) | normal | 1 min |
| 11 | Boss eval, below | normal | 5 min |
| 12 | `cd ..\windows` and `.\09-New-Phase0Report.ps1` | normal | 1 min |

### Step 11: the Opus 5.5 boss eval

First check the harness with no API calls: `node boss-eval/run.mjs --mock`
(should report 30/30 and "harness self-test: pass").

Then the real run. Paste your Anthropic API key into **this window only**. It
is not saved anywhere, and it disappears when you close the window:

```powershell
$s = Read-Host 'Anthropic API key' -AsSecureString
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
node boss-eval/run.mjs            # shows the estimated cost and asks before running
Remove-Item Env:ANTHROPIC_API_KEY
```

At Opus 5.5 prices on 2026-09-26 ($4 input / $20 output per million tokens),
the script's worst-case estimate for the 30 scenarios at the default `medium`
effort is about US$2.50; it prints the actual cost at the end. Options:
`--effort high`, `--only S06,S10`, `--model claude-sonnet-5` (no price on
file; it asks you to check).

## If something fails

- Step 2 says virtualization is off: enable Intel VT-x / AMD-V (SVM) in the
  BIOS/UEFI setup, then rerun.
- Step 3 cannot download: download the image yourself from
  `https://cloud-images.ubuntu.com/wsl/releases/noble/current/` and run
  `.\03-New-JarvisWorkshop.ps1 -RootfsPath <file>`. Rerun with `-Recreate` to start over.
- Step 5, Codex login cannot finish in the browser: in the distro run
  `codex login --help` and use the device/headless option it lists
  (`wsl -d jarvis-workshop -u worker` opens a shell there).
- Any step can be rerun; it overwrites its own result file.

Send back `%LOCALAPPDATA%\JarvisPhase0\phase0-results.zip` from step 12, plus the
manual checklist below. Open `phase0-report.md` first if you want to see what's in it.

## Manual checklist (answer in chat)

1. Windows edition shown in step 1 (Home or Pro), and whether this PC is a laptop.
2. Which Claude plan and which ChatGPT plan you log in with in step 5 (names only).
3. Google account for calendar/Gmail later: personal Gmail or Google Workspace?
4. Upwork: do you use it as a freelancer, a client, or both? Any Upwork API access already?
5. The 5 apps you used in step 8, and which ones JARVIS most needs to operate.
6. Anything in a step that surprised you or that you stopped.

## Coverage of the M0 spikes

The spike numbers are from [13 §18.3](../../docs/jarvis/13-build-plan.md#m0-verification-and-decisions).

| M0 spike | This kit | Still open after this kit |
|---|---|---|
| 1 Claude Code worker | Step 5: subscription login in WSL2, sandbox with credential denies, structured output, `--resume`, probe evidence | `stream-json` streaming, MCP Gateway, interrupt (Phase 8) |
| 2 Codex worker | Step 5: login in WSL2, `codex exec --json` in `workspace-write`, probe evidence, `exec`/`app-server` help captured | app-server schema, turn lifecycle, approvals (Phase 8) |
| 3 Terms | Checklist item 2 | Reading the plan terms with you |
| 4 Boss model | Step 11: 30 scenarios on Opus 5.5 (`--model claude-opus-5` to compare) | Grounding scenarios need real tools (Phase 5) |
| 5 WSL isolation | Steps 3-4 | Coordinator pipes and network allowlist exist from Phase 8 |
| 6 Windows Sandbox | Step 1 records the edition and feature | Home has no Windows Sandbox: fallback W3 applies |
| 7 Session Agent | Step 8: UI Automation survey, locked-screen behaviour, displays | Input injection, focus and takeover checks (Phase 6) |
| 8 Browser | Step 10: persistent profile with Edge/Chrome, accessibility snapshot, profile lock, persistence | Identity probes on real sites |
| 9 Wake and alarm | Steps 6-7, mains and battery | None |
| 10 Voice | Step 1 lists audio devices | Speech-to-text latency (Phase 7) |
| 11 Google OAuth | Checklist item 3 | Your Cloud project (Phase 9) |
| 12 Upwork | Checklist item 4 | Sample alert email |
| 13 SQLite | Step 10 (WAL, FTS5, rollback, backup, integrity, `sqlite-vec`) | None |
| 14 Emergency stop | None | Needs the Coordinator (Phase 5) |

## Files

```text
windows/   PowerShell steps (01-09) and common.ps1
workshop/  Linux scripts copied into jarvis-workshop: provisioning, red-team,
           worker install, Claude Code / Codex sandbox tests, probe.sh
node/      SQLite, browser and boss-eval spikes (Node.js 22+)
```
