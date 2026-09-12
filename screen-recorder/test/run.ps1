#requires -version 5.1
<#
  run.ps1 - unit tests for screenrec's pure logic.

  Screen capture cannot run in CI (no desktop), so these cover the parts that
  do not need a screen: choosing the encoder, building the ffmpeg command
  (and proving it opens NO audio device), and forming the output path. The
  recorder is dot-sourced, so no recording ever starts.

  Run on Windows:  powershell -ExecutionPolicy Bypass -File test\run.ps1
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\bin\screenrec.ps1')

$script:pass = 0; $script:fail = 0; $script:failed = @()
function Test-Eq { param($Name, $Actual, $Expected)
  if ($Actual -eq $Expected) { $script:pass++; Write-Host "  [PASS] $Name" -ForegroundColor Green }
  else { $script:fail++; $script:failed += $Name; Write-Host "  [FAIL] $Name" -ForegroundColor Red; Write-Host "     got:      $Actual"; Write-Host "     expected: $Expected" }
}
function Test-Has { param($Name, $Haystack, $Needle)
  if ($Haystack -like "*$Needle*") { $script:pass++; Write-Host "  [PASS] $Name" -ForegroundColor Green }
  else { $script:fail++; $script:failed += $Name; Write-Host "  [FAIL] $Name (missing: $Needle)" -ForegroundColor Red }
}
function Test-Missing { param($Name, $Haystack, $Needle)
  if ($Haystack -like "*$Needle*") { $script:fail++; $script:failed += $Name; Write-Host "  [FAIL] $Name (should not contain: $Needle)" -ForegroundColor Red }
  else { $script:pass++; Write-Host "  [PASS] $Name" -ForegroundColor Green }
}

Write-Host "`nChoosing the encoder" -ForegroundColor White
$encList = " V..... libx264   ...`n V..... h264_nvenc ...`n V..... h264_qsv ..."
Test-Eq "default is libx264 (works everywhere)"        (Select-Encoder -EncodersText $encList)            'libx264'
Test-Eq "-Hw prefers nvenc when present"               (Select-Encoder -EncodersText $encList -AllowHw)   'h264_nvenc'
Test-Eq "-Hw falls back to libx264 when no hw encoder" (Select-Encoder -EncodersText " V..... libx264" -AllowHw) 'libx264'
$qsvOnly = " V..... libx264`n V..... h264_qsv"
Test-Eq "-Hw picks qsv when that is the hw option"     (Select-Encoder -EncodersText $qsvOnly -AllowHw)   'h264_qsv'

Write-Host "`nBuilding the ffmpeg command (whole desktop)" -ForegroundColor White
$cmd = (Build-FfmpegArgs -Fps 30 -Encoder 'libx264' -Out 'C:\v\out.mp4') -join ' '
Test-Has     "uses the Windows screen grabber"     $cmd '-f gdigrab'
Test-Has     "captures the desktop"                 $cmd '-i desktop'
Test-Has     "passes the frame rate"                $cmd '-framerate 30'
Test-Has     "draws the mouse cursor"               $cmd '-draw_mouse 1'
Test-Has     "web-ready moov placement"             $cmd '+faststart'
Test-Has     "compatible pixel format"              $cmd 'yuv420p'
Test-Has     "writes the requested output"          $cmd 'C:\v\out.mp4'
Test-Missing "screen only - no dshow audio backend" $cmd 'dshow'
Test-Missing "screen only - no audio= device"       $cmd 'audio='
Test-Missing "no audio input mapping"               $cmd ':audio'
Test-Missing "whole-desktop capture uses no crop"   $cmd '-video_size'

Write-Host "`nBuilding the ffmpeg command (one monitor, 60 fps, hardware)" -ForegroundColor White
$cmd2 = (Build-FfmpegArgs -Fps 60 -Encoder 'h264_nvenc' -Out 'C:\v\a.mp4' -OffsetX 1920 -OffsetY 0 -Size '1920x1080') -join ' '
Test-Has "60 fps honoured"                    $cmd2 '-framerate 60'
Test-Has "crops to the chosen monitor size"   $cmd2 '-video_size 1920x1080'
Test-Has "offsets to the monitor origin"      $cmd2 '-offset_x 1920 -offset_y 0'
Test-Has "uses the hardware encoder"          $cmd2 'h264_nvenc'
Test-Missing "no software encoder when hw chosen" $cmd2 'libx264'

# gdigrab input options must come BEFORE -i desktop, or ffmpeg ignores them.
$argsArr = Build-FfmpegArgs -Fps 30 -Encoder 'libx264' -Out 'o.mp4' -OffsetX 0 -OffsetY 0 -Size '800x600'
$idxSize = [array]::IndexOf($argsArr, '-video_size')
$idxInput = [array]::IndexOf($argsArr, 'desktop')
Test-Eq "crop options precede the input" ($idxSize -lt $idxInput -and $idxSize -ge 0) $true

Write-Host "`nOutput path" -ForegroundColor White
Test-Eq "path is composed cleanly" (Get-OutputPath -Dir 'C:\Users\me\Videos' -Stamp '2026-09-12_14-30-00' -Ext 'mp4') 'C:\Users\me\Videos\screen-2026-09-12_14-30-00.mp4'
Test-Eq "a trailing separator on the dir is tolerated" (Get-OutputPath -Dir 'C:\Users\me\Videos\' -Stamp '2026-09-12_14-30-00' -Ext 'mp4') 'C:\Users\me\Videos\screen-2026-09-12_14-30-00.mp4'

$color = if ($script:fail -eq 0) { 'Green' } else { 'Red' }
Write-Host ("`n{0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $color
if ($script:fail -ne 0) { Write-Host "`nFailures:"; $script:failed | ForEach-Object { Write-Host "  - $_" }; exit 1 }
