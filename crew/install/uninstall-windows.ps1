# Removes Crew's program files and shortcuts. Your projects, captures, settings and sign-ins
# (in your user folder, under .crew) are kept unless you choose to delete them too.

$ErrorActionPreference = 'Continue'
$Target = Join-Path $env:LOCALAPPDATA 'Programs\Crew'
$CrewHome = Join-Path $env:USERPROFILE '.crew'

Write-Host ''
Write-Host '  Crew - uninstall' -ForegroundColor White
Write-Host ''
Get-CimInstance Win32_Process -Filter "Name like 'python%.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*crewlib*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($folder in @('Desktop', 'Programs', 'Startup')) {
  $link = Join-Path ([Environment]::GetFolderPath($folder)) 'Crew.lnk'
  if (Test-Path $link) { Remove-Item $link -Force }
}
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
Write-Host '  Crew and its shortcuts were removed.' -ForegroundColor Green
$answer = Read-Host "  Also delete your Crew projects, captures, settings and sign-ins in $CrewHome ? [y/N]"
if ($answer -and $answer.Trim().ToLower().StartsWith('y')) {
  Remove-Item $CrewHome -Recurse -Force
  Write-Host '  Deleted.' -ForegroundColor Green
} else {
  Write-Host '  Kept. Reinstalling Crew later picks them up again.' -ForegroundColor Gray
}
Write-Host ''
Read-Host 'Press Enter to close' | Out-Null
