#requires -version 5.1
<#
  screenrec - a plain screen recorder for Windows. Screen only, no microphone.

  Records the display to a timestamped video file you can upload straight to
  YouTube. It captures the screen and the mouse cursor; it never touches the
  microphone or any other audio input.

    screenrec                 record the whole desktop
    screenrec -Fps 60         smoother motion (60 frames/second)
    screenrec -Display 1      record only the second monitor
    screenrec -List           show which monitors can be recorded
    screenrec -Hw             use a hardware encoder if one is available
    screenrec -Out C:\x.mp4   choose the output file
    screenrec -Help

  Stop a recording by pressing  q  in this window.

  The file is split into pure functions (no recording, no writes - covered by
  test\run.ps1) and an Invoke-Main that does the work. Dot-sourcing the file
  therefore loads the functions without recording anything.
#>
[CmdletBinding()]
param(
  [int]$Fps = 30,
  [int]$Display = -1,        # -1 = whole desktop (all monitors together)
  [string]$Out = "",
  [string]$Dir = "$env:USERPROFILE\Videos\ScreenRecordings",
  [switch]$Hw,
  [switch]$List,
  [switch]$Help
)

# ---------------------------------------------------------------------------
# Pure logic - no side effects. Exercised by test\run.ps1.
# ---------------------------------------------------------------------------

function Get-OutputPath {
  param([string]$Dir, [string]$Stamp, [string]$Ext)
  # Plain string join (not Join-Path) so a trailing separator is tolerated and
  # the result is a well-formed Windows path regardless of where it is computed.
  return ("{0}\screen-{1}.{2}" -f $Dir.TrimEnd('\'), $Stamp, $Ext)
}

# Choose the video encoder. Given the text of `ffmpeg -encoders`, prefer a
# hardware encoder (low CPU while capturing) when -AllowHw is set and one is
# present; otherwise fall back to libx264, which exists in every ffmpeg build.
function Select-Encoder {
  param([string]$EncodersText, [switch]$AllowHw)
  if ($AllowHw) {
    foreach ($e in @('h264_nvenc', 'h264_qsv', 'h264_amf')) {
      if ($EncodersText -match [regex]::Escape($e)) { return $e }
    }
  }
  return 'libx264'
}

# Build the ffmpeg argument list. Screen only: the input is gdigrab's "desktop",
# and no audio device is ever opened. gdigrab input options (framerate, cursor,
# crop offsets, size) must precede -i, so they are emitted first.
function Build-FfmpegArgs {
  param(
    [int]$Fps,
    [string]$Encoder,
    [string]$Out,
    $OffsetX = $null,
    $OffsetY = $null,
    [string]$Size = ""
  )
  $a = @('-hide_banner', '-y', '-f', 'gdigrab', '-framerate', "$Fps", '-draw_mouse', '1')
  if ($null -ne $OffsetX -and $null -ne $OffsetY -and $Size) {
    $a += @('-offset_x', "$OffsetX", '-offset_y', "$OffsetY", '-video_size', $Size)
  }
  $a += @('-i', 'desktop')
  switch ($Encoder) {
    'h264_nvenc' { $a += @('-c:v', 'h264_nvenc', '-b:v', '12M') }
    'h264_qsv'   { $a += @('-c:v', 'h264_qsv', '-b:v', '12M') }
    'h264_amf'   { $a += @('-c:v', 'h264_amf', '-b:v', '12M') }
    default      { $a += @('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23') }
  }
  $a += @('-pix_fmt', 'yuv420p', '-movflags', '+faststart', $Out)
  return , $a
}

# ---------------------------------------------------------------------------
# Impure - talks to the OS. Not exercised by the unit tests.
# ---------------------------------------------------------------------------

function Show-Usage {
  $t = Get-Content -LiteralPath $PSCommandPath -TotalCount 40
  $t | Where-Object { $_ -match '^\s*(screenrec|Stop a recording|Records the|it captures|the microphone)' } | ForEach-Object { $_.Trim() }
}

function Get-Displays {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue | Out-Null
  return [System.Windows.Forms.Screen]::AllScreens
}

function Show-Displays {
  $screens = Get-Displays
  Write-Host "Recordable monitors:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $screens.Count; $i++) {
    $b = $screens[$i].Bounds
    $primary = if ($screens[$i].Primary) { " (primary)" } else { "" }
    Write-Host ("  -Display {0}   {1}x{2} at ({3},{4}){5}" -f $i, $b.Width, $b.Height, $b.X, $b.Y, $primary)
  }
  Write-Host "  (no -Display records the whole desktop across all monitors)"
}

function Show-BlackScreenHint {
  Write-Host ""
  Write-Host "If the recording is black:" -ForegroundColor Yellow
  Write-Host "  - Protected/DRM windows (Netflix, some players) cannot be captured."
  Write-Host "  - A game in exclusive fullscreen may not capture; set it to"
  Write-Host "    borderless/windowed mode, or try -Hw."
  Write-Host "  - To capture a window running as administrator, run this terminal"
  Write-Host "    as administrator too."
}

function Invoke-Main {
  if ($Help) { Show-Usage; return }

  if ($env:OS -ne 'Windows_NT') { Write-Error "screenrec records the Windows screen and only runs on Windows."; exit 1 }

  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ff) { Write-Error "ffmpeg not found. Run the installer, or install ffmpeg (winget install Gyan.FFmpeg)."; exit 1 }

  if ($List) { Show-Displays; return }

  $encodersText = (& ffmpeg -hide_banner -encoders 2>$null | Out-String)
  $encoder = Select-Encoder -EncodersText $encodersText -AllowHw:$Hw

  $ox = $null; $oy = $null; $size = ""
  if ($Display -ge 0) {
    $screens = Get-Displays
    if ($Display -ge $screens.Count) {
      Write-Error ("No monitor {0}. Run 'screenrec -List' to see the {1} available." -f $Display, $screens.Count); exit 1
    }
    $b = $screens[$Display].Bounds
    $ox = $b.X; $oy = $b.Y; $size = ("{0}x{1}" -f $b.Width, $b.Height)
  }

  if ($Out) {
    $outPath = $Out
    $parent = Split-Path -Parent $outPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  } else {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $outPath = Get-OutputPath -Dir $Dir -Stamp $stamp -Ext 'mp4'
  }

  $ffargs = Build-FfmpegArgs -Fps $Fps -Encoder $encoder -Out $outPath -OffsetX $ox -OffsetY $oy -Size $size

  $where = if ($Display -ge 0) { "monitor $Display" } else { "whole desktop" }
  Write-Host ("* Recording {0} at {1} fps ({2}, screen only - no microphone)" -f $where, $Fps, $encoder) -ForegroundColor Green
  Write-Host ("  -> {0}" -f $outPath)
  Write-Host "  Press q to stop and save."
  Write-Host ""

  & ffmpeg @ffargs

  if ((Test-Path $outPath) -and ((Get-Item $outPath).Length -gt 1000)) {
    $mb = [math]::Round((Get-Item $outPath).Length / 1MB, 1)
    Write-Host ""
    Write-Host ("+ Saved {0} ({1} MB)" -f $outPath, $mb) -ForegroundColor Green
    if (Get-Command explorer -ErrorAction SilentlyContinue) { explorer "/select,`"$outPath`"" }
  } else {
    Show-BlackScreenHint
    Write-Error "The recording came out empty."
    exit 1
  }
}

# Run only when executed, not when dot-sourced by the tests.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-Main
}
