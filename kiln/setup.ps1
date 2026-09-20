# Sets Kiln up on Windows. Safe to run twice.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# It makes a private Python environment beside this file, installs the one
# dependency, checks Blender, and builds a test object to prove it works.
# It never asks for your Claude key -- you type that into the app itself.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Say($m) { Write-Host "`n$m" -ForegroundColor White }
function Ok($m)  { Write-Host "  * $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  ! $m" -ForegroundColor Red }

Say "1. Python"
$py = $null
foreach ($c in @("python", "python3", "py")) {
  if (Get-Command $c -ErrorAction SilentlyContinue) {
    $v = & $c -c "import sys; print(1 if sys.version_info >= (3,10) else 0)" 2>$null
    if ($v -eq "1") { $py = $c; break }
  }
}
if (-not $py) {
  Bad "Python 3.10 or newer is needed."
  Write-Host "     Get it from https://www.python.org/downloads/  (tick 'Add to PATH')"
  exit 1
}
Ok (& $py --version)

Say "2. Kiln's own Python environment"
if (-not (Test-Path ".venv")) { & $py -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
& .\.venv\Scripts\python.exe -m pip install --quiet anthropic
Ok "ready"

Say "3. Blender"
$blender = $null
$cmd = Get-Command blender -ErrorAction SilentlyContinue
if ($cmd) { $blender = $cmd.Source }
if (-not $blender) {
  $found = Get-ChildItem "C:\Program Files\Blender Foundation" -Filter blender.exe `
           -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $blender = $found.FullName }
}
if (-not $blender) {
  Bad "Blender is not installed yet."
  Write-Host "     Get it free from https://www.blender.org/download/"
  Write-Host "     Or: winget install BlenderFoundation.Blender"
  Write-Host ""
  Write-Host "     Install it, then run this again. Everything else is done."
  exit 1
}
Ok $blender

Say "4. Building a test object"
& .\.venv\Scripts\python.exe app.py --check

Say "Done. Start Kiln with:"
Write-Host "  .\.venv\Scripts\python.exe app.py"
Write-Host ""
Write-Host "It opens in your browser and asks for a Claude key on the first run."
Write-Host "Get one at https://console.anthropic.com/settings/keys"
