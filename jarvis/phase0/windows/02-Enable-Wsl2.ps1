<#
.SYNOPSIS
  Phase 0, step 2: enable WSL2 (you asked for this). Needs Administrator.
.DESCRIPTION
  CHANGES YOUR SYSTEM: turns on the Windows features WSL2 needs and installs
  the WSL platform, without installing any Linux distribution. A reboot is
  usually required afterwards. Nothing else is modified.
  If WSL is already installed, it only runs "wsl --update".
#>
[CmdletBinding()] param([switch] $Yes)
. "$PSScriptRoot\common.ps1"

if (-not (Test-IsAdmin)) { throw 'Run this from an elevated PowerShell window (right-click > Run as administrator).' }

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
if (-not $cpu.VirtualizationFirmwareEnabled -and -not $hv) {
    Write-Warning 'Hardware virtualization appears to be disabled in firmware (BIOS/UEFI). WSL2 cannot run until you enable it (often called Intel VT-x, AMD-V, or SVM). Enable it, then rerun this script.'
    Save-Result -Spike 'wsl_enable' -Data @{ status = 'blocked'; reason = 'virtualization disabled in firmware' } | Out-Null
    return
}

$current = Invoke-Native 'wsl.exe' @('--version')
if ($current.exit -eq 0) {
    Write-Step 'WSL is already installed; updating it'
    $u = Invoke-Native 'wsl.exe' @('--update')
    $d = Invoke-Native 'wsl.exe' @('--set-default-version', '2')
    Save-Result -Spike 'wsl_enable' -Data @{ status = 'already_installed'; version = $current.out; update = $u.out; default_version = $d.out } | Out-Null
    Write-Host 'Done. No reboot needed. Next: 03-New-JarvisWorkshop.ps1' -ForegroundColor Yellow
    return
}

if (-not $Yes -and -not (Confirm-Action 'This enables WSL2 and Virtual Machine Platform, then you must reboot. Continue?')) { return }

Write-Step 'Installing the WSL platform (no Linux distribution)'
$r = Invoke-Native 'wsl.exe' @('--install', '--no-distribution')
Write-Host $r.out
Save-Result -Spike 'wsl_enable' -Data @{ status = if ($r.exit -eq 0) { 'installed_reboot_required' } else { 'error' }; exit = $r.exit; output = $r.out } | Out-Null

if ($r.exit -ne 0) {
    Write-Warning 'wsl --install failed. The output above says why. A common fix is enabling virtualization in firmware, or running Windows Update first.'
    return
}
Write-Host "`nReboot now, then continue with 03-New-JarvisWorkshop.ps1 (no Administrator needed)." -ForegroundColor Yellow
