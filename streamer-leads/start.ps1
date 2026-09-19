# Streamer Lead Workspace - Windows launcher
# Right-click this file and choose "Run with PowerShell", or run:
#     powershell -ExecutionPolicy Bypass -File .\start.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Find-Python {
    foreach ($candidate in @("py", "python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            if ($candidate -eq "py") { return @("py", "-3") }
            return @($candidate)
        }
    }
    return $null
}

$python = Find-Python
if (-not $python) {
    Write-Host ""
    Write-Host "ERROR: Python was not found." -ForegroundColor Red
    Write-Host "       Install it from https://www.python.org/downloads/"
    Write-Host "       During setup, tick 'Add python.exe to PATH'."
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: Node.js was not found." -ForegroundColor Red
    Write-Host "       Install the LTS build from https://nodejs.org/ then open a new window."
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# run.py does the real work: it checks versions, installs anything missing on
# the first run, starts both servers and prints the address to open.
$exe = $python[0]
$prefix = @()
if ($python.Count -gt 1) { $prefix = $python[1..($python.Count - 1)] }
& $exe @prefix "run.py" @args

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Read-Host "Something went wrong. Press Enter to close"
}
