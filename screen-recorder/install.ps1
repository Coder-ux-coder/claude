#requires -version 5.1
<#
  screenrec installer - Windows screen recorder for YouTube content.

  Paste into PowerShell:
    irm https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder/install.ps1 | iex

  Installs the screenrec command into %LOCALAPPDATA%\Programs\screenrec, makes
  sure ffmpeg is present (via winget), adds screenrec to your PATH, and starts
  recording your screen. Screen only - it never records the microphone.

  Nothing needs administrator rights except, if you allow it, the winget
  install of ffmpeg.
#>
[CmdletBinding()]
param([switch]$NoStart)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Note($m) { Write-Host "  $m" }
function Warn($m) { Write-Host " !  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`nX $m`n" -ForegroundColor Red; exit 1 }
function Ask($m) {
  $a = Read-Host ("{0} [y/N]" -f $m)
  return ($a -match '^(y|yes)$')
}

Write-Host ""
Write-Host "screenrec - Windows screen recorder" -ForegroundColor White
Write-Host "Records your screen to a video file ready for YouTube." -ForegroundColor DarkGray
Write-Host "Screen only: it does not record the microphone or any audio." -ForegroundColor DarkGray

# ---- 1. platform ----------------------------------------------------------
# Checked first, before touching any Windows-only environment variable.
Step "Checking Windows"
if ($env:OS -ne 'Windows_NT') { Die "This installer is for Windows. (Detected a non-Windows system.)" }
Note ("Windows PowerShell {0}" -f $PSVersionTable.PSVersion)

$Repo = if ($env:SCREENREC_SOURCE) { $env:SCREENREC_SOURCE } else {
  'https://raw.githubusercontent.com/Coder-ux-coder/claude/refs/heads/claude/sleepy-newton-7a6g09/screen-recorder'
}
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\screenrec' 

# ---- 2. ffmpeg ------------------------------------------------------------
Step "Checking for ffmpeg (the recording engine)"
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  Note "ffmpeg found."
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
  Note "ffmpeg is needed. It can be installed with winget (Microsoft's package manager)."
  if (Ask "  Install ffmpeg now?") {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements --disable-interactivity
    # Refresh PATH for this session so ffmpeg is usable immediately.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
      Warn "ffmpeg was installed but is not on PATH in this window yet."
      Warn "Close this window, open a new PowerShell, and run: screenrec"
    } else {
      Note "ffmpeg installed."
    }
  } else {
    Die "ffmpeg is required. Install it later with:  winget install Gyan.FFmpeg"
  }
} else {
  Die "ffmpeg is required and winget was not found. Install ffmpeg from https://ffmpeg.org/download.html (add it to PATH), then run this installer again."
}

# ---- 3. install the command ----------------------------------------------
Step "Installing the screenrec command"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Fetch($rel, $dest) {
  $tmp = "$dest.part"
  Invoke-WebRequest -Uri "$Repo/$rel" -OutFile $tmp -UseBasicParsing
  if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) { Die "Downloaded $rel but it was empty." }
  Move-Item -Force $tmp $dest
}
Fetch 'bin/screenrec.ps1' (Join-Path $InstallDir 'screenrec.ps1')
Fetch 'bin/screenrec.cmd' (Join-Path $InstallDir 'screenrec.cmd')
if (-not (Select-String -Path (Join-Path $InstallDir 'screenrec.ps1') -Pattern 'screenrec - a plain screen recorder' -Quiet)) {
  Die "The downloaded screenrec looks wrong."
}
Note ("installed -> {0}" -f $InstallDir)

# ---- 4. PATH --------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $InstallDir), 'User')
  $env:Path = $env:Path.TrimEnd(';') + ';' + $InstallDir
  Note "added screenrec to your PATH"
}

# ---- 5. note about protected content --------------------------------------
Step "Good to know"
Note "Windows needs no special permission to record the screen."
Note "But protected/DRM windows (Netflix and some players) record as black,"
Note "and a game in exclusive-fullscreen may not capture - use borderless mode."

# ---- 6. go ----------------------------------------------------------------
if ($NoStart) {
  Write-Host ""
  Write-Host "Done. Start recording any time with:" -ForegroundColor Green
  Write-Host "    screenrec              record the whole desktop"
  Write-Host "    screenrec -Fps 60      smoother, 60 fps"
  Write-Host "    screenrec -List        show your monitors"
  Write-Host "    screenrec -Help"
  Write-Host ""
  Write-Host "Stop a recording with q. Videos save to %USERPROFILE%\Videos\ScreenRecordings."
  return
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Setup finished, but ffmpeg is not on PATH in THIS window yet." -ForegroundColor Yellow
  Write-Host "Open a new PowerShell window and run:  screenrec" -ForegroundColor Yellow
  return
}

Step "Starting your first recording"
Note "(Press q in this window to stop and save.)"
Write-Host ""
& (Join-Path $InstallDir 'screenrec.ps1')
