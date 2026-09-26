<#
.SYNOPSIS
  Phase 0, step 3: create the isolated "jarvis-workshop" WSL2 distro.
.DESCRIPTION
  CHANGES YOUR SYSTEM (in a contained way):
    - Downloads the official Ubuntu 24.04 WSL image from cloud-images.ubuntu.com
      and verifies its SHA256 against Ubuntu's published SHA256SUMS.
    - Imports it as a NEW distro named "jarvis-workshop" stored under
      %LOCALAPPDATA%\JarvisPhase0\wsl. Your existing distros are not touched.
    - Provisions it: an unprivileged user "worker" with NO sudo, Windows
      interop disabled, Windows drive auto-mount disabled, plus git, curl,
      bubblewrap, socat and Node.js 22 (checksum-verified).
  Remove it later with:  wsl --unregister jarvis-workshop
  No Administrator rights needed.
#>
[CmdletBinding()] param(
    [string] $RootfsPath,
    [switch] $Recreate,
    [switch] $Yes
)
. "$PSScriptRoot\common.ps1"

$Distro = 'jarvis-workshop'
$InstallDir = Join-Path $script:Phase0Root "wsl\$Distro"
$ImageBase = 'https://cloud-images.ubuntu.com/wsl/releases/noble/current'
$ImageName = 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
$KitRoot = Split-Path $PSScriptRoot -Parent

$v = Invoke-Native 'wsl.exe' @('--version')
if ($v.exit -ne 0) { throw 'WSL is not installed yet. Run 02-Enable-Wsl2.ps1 as Administrator and reboot first.' }

$list = Invoke-Native 'wsl.exe' @('--list', '--quiet')
if ($list.out -match "(?m)^\s*$Distro\s*$") {
    if (-not $Recreate) { Write-Host "$Distro already exists. Use -Recreate to rebuild it." -ForegroundColor Yellow; return }
    if (-not $Yes -and -not (Confirm-Action "Delete and rebuild $Distro? Anything inside it will be lost")) { return }
    Invoke-Native 'wsl.exe' @('--unregister', $Distro) | Out-Null
}

if (-not $Yes -and -not (Confirm-Action "Create WSL distro '$Distro' in $InstallDir (about 1.5 GB download and disk)?")) { return }

# --- 1. Get and verify the Ubuntu image ---------------------------------------
if (-not $RootfsPath) {
    $dl = Join-Path $script:Phase0Root 'downloads'
    New-Item -ItemType Directory -Force -Path $dl | Out-Null
    $RootfsPath = Join-Path $dl $ImageName
    Write-Step "Downloading $ImageName"
    $ProgressPreference = 'SilentlyContinue'   # progress bars make Invoke-WebRequest very slow on 5.1
    Invoke-WebRequest -UseBasicParsing -Uri "$ImageBase/$ImageName" -OutFile $RootfsPath
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$ImageBase/SHA256SUMS").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($ImageName) } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS does not list $ImageName" }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $RootfsPath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { Remove-Item $RootfsPath -Force; throw "Checksum mismatch: expected $expected, got $actual. Download deleted." }
    Write-Host "Checksum OK ($actual)" -ForegroundColor Green
}

# --- 2. Import as a new WSL2 distro ------------------------------------------
Write-Step "Importing $Distro"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$imp = Invoke-Native 'wsl.exe' @('--import', $Distro, $InstallDir, $RootfsPath, '--version', '2')
if ($imp.exit -ne 0) { throw "wsl --import failed: $($imp.out)" }

# --- 3. Copy the Linux-side scripts in and provision as root -----------------
Write-Step 'Copying Phase 0 scripts into the distro'
Invoke-Native 'wsl.exe' @('-d', $Distro, '-u', 'root', '--', 'mkdir', '-p', '/opt/jarvis-phase0') | Out-Null
$unc = $null
foreach ($prefix in @("\\wsl.localhost\$Distro", "\\wsl$\$Distro")) {
    if (Test-Path "$prefix\opt\jarvis-phase0") { $unc = "$prefix\opt\jarvis-phase0"; break }
}
if (-not $unc) { throw 'Cannot reach the distro filesystem through \\wsl.localhost or \\wsl$' }
Copy-Item -Path (Join-Path $KitRoot 'workshop\*') -Destination $unc -Recurse -Force
# Git on Windows may have converted line endings; normalize to LF.
Invoke-Native 'wsl.exe' @('-d', $Distro, '-u', 'root', '--', 'bash', '-c', "sed -i 's/\r$//' /opt/jarvis-phase0/*.sh && chmod 755 /opt/jarvis-phase0/*.sh") | Out-Null

Write-Step 'Provisioning (user without sudo, interop off, automount off, tools)'
$prov = Invoke-Native 'wsl.exe' @('-d', $Distro, '-u', 'root', '--', 'bash', '/opt/jarvis-phase0/provision.sh')
Write-Host $prov.out
if ($prov.exit -ne 0) { throw "Provisioning failed (exit $($prov.exit)). Output above." }

# wsl.conf changes take effect only after the distro restarts.
Invoke-Native 'wsl.exe' @('--terminate', $Distro) | Out-Null

Save-Result -Spike 'workshop_create' -Data @{
    status = 'created'; distro = $Distro; image = $ImageName
    install_dir = $InstallDir; provision_output = $prov.out
} | Out-Null
Write-Host "`nNext: 04-Test-WorkshopIsolation.ps1" -ForegroundColor Yellow
