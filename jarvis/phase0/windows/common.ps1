# Shared helpers for the JARVIS Phase 0 verification kit.
# Dot-source this file: . "$PSScriptRoot\common.ps1"

Set-StrictMode -Version 3.0

$script:Phase0Root = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'JarvisPhase0' } else { Join-Path $HOME '.jarvis-phase0' }
$script:ResultsDir = Join-Path $script:Phase0Root 'results'
New-Item -ItemType Directory -Force -Path $script:ResultsDir | Out-Null

# Works on Windows PowerShell 5.1 (no $IsWindows variable) and PowerShell 7.
function Test-IsWindowsHost {
    if ($PSVersionTable.PSEdition -eq 'Desktop') { return $true }
    $v = Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue
    return ($v -eq $true)
}

# Runs an external program and returns @{ exit; out } without throwing.
function Invoke-Native {
    param([Parameter(Mandatory)] [string] $File, [string[]] $Arguments = @())
    $cmd = Get-Command $File -ErrorAction SilentlyContinue
    if (-not $cmd) { return @{ exit = $null; out = "$File not found" } }
    $prev = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'   # makes wsl.exe emit UTF-8 instead of UTF-16
    try {
        $out = & $cmd.Source @Arguments 2>&1 | Out-String
        return @{ exit = $LASTEXITCODE; out = $out.Trim() }
    } finally { $env:WSL_UTF8 = $prev }
}

function Test-IsAdmin {
    if (-not (Test-IsWindowsHost)) { return $false }
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Runs a check and never throws: returns @{ status; value; error }.
# status is one of: pass, fail, info, skipped, error
function Invoke-Check {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Script
    )
    try {
        $r = & $Script
        if ($r -is [hashtable] -and $r.ContainsKey('status')) { $r['name'] = $Name; return $r }
        return @{ name = $Name; status = 'info'; value = $r }
    } catch {
        return @{ name = $Name; status = 'error'; error = $_.Exception.Message }
    }
}

# Replaces the Windows user name and computer name so reports can be shared.
function Protect-Text {
    param([string] $Text)
    if (-not $Text) { return $Text }
    $out = $Text
    foreach ($secret in @($env:USERNAME, $env:COMPUTERNAME, $env:USERDOMAIN)) {
        if ($secret -and $secret.Length -ge 3) {
            $out = $out -replace [regex]::Escape($secret), '<redacted>'
        }
    }
    return $out
}

function Save-Result {
    param(
        [Parameter(Mandatory)] [string] $Spike,
        [Parameter(Mandatory)] $Data
    )
    $doc = [ordered]@{
        spike       = $Spike
        kit_version = '0.1.0'
        recorded_at = (Get-Date).ToUniversalTime().ToString('o')
        results     = $Data
    }
    $json = Protect-Text ($doc | ConvertTo-Json -Depth 12)
    $path = Join-Path $script:ResultsDir "$Spike.json"
    # UTF-8 without BOM so Node and Python read it cleanly.
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Saved $path" -ForegroundColor Green
    return $path
}

function Write-Step {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Confirm-Action {
    param([string] $Message)
    $answer = Read-Host "$Message [y/N]"
    return ($answer -match '^(y|yes)$')
}
