<#
.SYNOPSIS
  Phase 0, step 5: install Claude Code and Codex inside jarvis-workshop, log in
  once, and test that each one's sandbox actually holds.
.DESCRIPTION
  Everything runs inside the distro as the unprivileged "worker" user.
  Logins are interactive and use your subscriptions; the tokens stay inside
  the distro (they are never copied to Windows or to the results folder).
  No API key is needed or stored. No Administrator needed.
.PARAMETER SkipInstall   Skip install-workers.sh (already installed).
.PARAMETER SkipLogin     Skip the interactive login prompts (already logged in).
.PARAMETER Only          'claude', 'codex' or 'both' (default).
#>
[CmdletBinding()] param(
    [switch] $SkipInstall,
    [switch] $SkipLogin,
    [ValidateSet('claude', 'codex', 'both')] [string] $Only = 'both'
)
. "$PSScriptRoot\common.ps1"
$Distro = 'jarvis-workshop'
$KitRoot = Split-Path $PSScriptRoot -Parent

function Get-DistroPath([string] $LinuxPath) {
    foreach ($prefix in @("\\wsl.localhost\$Distro", "\\wsl$\$Distro")) {
        $p = $prefix + ($LinuxPath -replace '/', '\')
        if (Test-Path $p) { return $p }
    }
    return $null
}

$list = Invoke-Native 'wsl.exe' @('--list', '--quiet')
if ($list.out -notmatch [regex]::Escape($Distro)) { throw "$Distro not found. Run 03-New-JarvisWorkshop.ps1 first." }

Write-Step 'Refreshing the Phase 0 scripts inside the distro'
$opt = Get-DistroPath '/opt/jarvis-phase0'
if (-not $opt) { throw 'Cannot reach /opt/jarvis-phase0 in the distro' }
Copy-Item -Path (Join-Path $KitRoot 'workshop\*') -Destination $opt -Recurse -Force
Invoke-Native 'wsl.exe' @('-d', $Distro, '-u', 'root', '--', 'bash', '-c', "sed -i 's/\r$//' /opt/jarvis-phase0/*.sh && chmod 755 /opt/jarvis-phase0/*.sh") | Out-Null

if (-not $SkipInstall) {
    Write-Step 'Installing the coding workers (as worker, not root)'
    Write-Host 'This downloads Claude Code (claude.ai/install.sh) and Codex (npm @openai/codex) into the distro only.'
    if (-not (Confirm-Action 'Continue?')) { Write-Host 'Stopped.'; return }
    & wsl.exe -d $Distro -u worker -- bash /opt/jarvis-phase0/install-workers.sh
    if ($LASTEXITCODE -ne 0) { throw "install-workers.sh failed (exit $LASTEXITCODE)" }
}

if (-not $SkipLogin) {
    if ($Only -ne 'codex') {
        Write-Step 'Claude Code login (interactive)'
        Write-Host 'Claude Code will start. Choose your Claude subscription, finish the login in your browser'
        Write-Host '(copy the URL it shows if no browser opens; paste the code back if asked), then type /exit.'
        Read-Host 'Press Enter to start' | Out-Null
        & wsl.exe -d $Distro -u worker -- bash -ic 'cd ~ && claude'
    }
    if ($Only -ne 'claude') {
        Write-Step 'Codex login (interactive)'
        Write-Host 'Open the URL Codex prints in your Windows browser. If the browser cannot finish the'
        Write-Host 'login, run "codex login --help" in the distro and use the device / headless option it lists.'
        Read-Host 'Press Enter to start' | Out-Null
        & wsl.exe -d $Distro -u worker -- bash -ic 'codex login'
    }
}

$summary = [ordered]@{}
if ($Only -ne 'codex') {
    Write-Step 'Testing Claude Code sandbox (uses a few cents of your Claude plan)'
    & wsl.exe -d $Distro -u worker -- bash /opt/jarvis-phase0/test-claude-code.sh
    $summary['claude_code_exit'] = $LASTEXITCODE
}
if ($Only -ne 'claude') {
    Write-Step 'Testing Codex sandbox'
    & wsl.exe -d $Distro -u worker -- bash /opt/jarvis-phase0/test-codex.sh
    $summary['codex_exit'] = $LASTEXITCODE
}

Write-Step 'Copying Linux-side results to Windows'
$res = Get-DistroPath '/home/worker/phase0-results'
if (-not $res) { throw 'Cannot reach /home/worker/phase0-results' }
foreach ($f in Get-ChildItem -Path $res -Filter '*.json') {
    $text = Protect-Text ([IO.File]::ReadAllText($f.FullName))
    $dest = Join-Path $script:ResultsDir ("linux_" + $f.Name)
    [IO.File]::WriteAllText($dest, $text, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Saved $dest" -ForegroundColor Green
    $summary[$f.BaseName] = $f.Name
}
Save-Result -Spike 'coding_workers' -Data $summary | Out-Null
