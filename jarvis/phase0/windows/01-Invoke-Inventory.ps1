<#
.SYNOPSIS
  Phase 0, step 1: read-only inventory of this PC for the JARVIS design.
.DESCRIPTION
  Changes nothing. Records Windows edition and build, hardware, virtualization,
  WSL, Windows Sandbox, BitLocker, power and wake-timer settings, displays,
  audio devices, installed tools, and Defender Controlled Folder Access.
  Some checks need an elevated (Administrator) window. They are marked
  "skipped" otherwise, so run it elevated for a complete picture.
  Output: %LOCALAPPDATA%\JarvisPhase0\results\inventory.json
#>
[CmdletBinding()] param()
. "$PSScriptRoot\common.ps1"

if (-not (Test-IsWindowsHost)) { Write-Warning 'This script is meant for Windows. Running in limited mode.' }
$admin = Test-IsAdmin
Write-Step "Inventory (elevated: $admin)"

$checks = New-Object System.Collections.ArrayList

# --- Operating system ---------------------------------------------------------
[void]$checks.Add((Invoke-Check 'os' {
    $os = Get-CimInstance Win32_OperatingSystem
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $edition = $cv.EditionID
    $sandboxCapable = $edition -match 'Professional|Enterprise|Education'
    @{ status = 'info'; value = @{
        caption = $os.Caption; version = $os.Version; build = $os.BuildNumber
        display_version = $cv.DisplayVersion; edition_id = $edition
        ubr = $cv.UBR
        windows_sandbox_edition_ok = $sandboxCapable
        note = if ($sandboxCapable) { 'Edition supports Windows Sandbox' } else { 'Home edition: Windows Sandbox unavailable; Workshop uses WSL2 plus a restricted local account' }
    } }
}))

[void]$checks.Add((Invoke-Check 'session' {
    @{ status = 'info'; value = @{
        session_name = $env:SESSIONNAME
        is_remote = ($env:SESSIONNAME -like 'RDP*')
        ps_version = $PSVersionTable.PSVersion.ToString()
        ps_edition = $PSVersionTable.PSEdition
        elevated = $admin
    } }
}))

# --- Hardware -----------------------------------------------------------------
[void]$checks.Add((Invoke-Check 'hardware' {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $cs = Get-CimInstance Win32_ComputerSystem
    $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driver = $_.DriverVersion } })
    $sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    @{ status = if ($ramGb -ge 8) { 'pass' } else { 'fail' }; value = @{
        cpu = $cpu.Name; cores = $cpu.NumberOfCores; logical = $cpu.NumberOfLogicalProcessors
        ram_gb = $ramGb; gpus = $gpus
        system_drive_free_gb = [math]::Round($sys.FreeSpace / 1GB, 1)
        virtualization_firmware_enabled = $cpu.VirtualizationFirmwareEnabled
        hypervisor_present = $cs.HypervisorPresent
        is_laptop = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
        requirement = '8 GB RAM minimum for JARVIS plus a WSL2 workshop; 16 GB recommended'
    } }
}))

# --- TPM and Windows Hello ----------------------------------------------------
[void]$checks.Add((Invoke-Check 'tpm' {
    if (-not $admin) { return @{ status = 'skipped'; value = 'Needs an elevated window' } }
    $t = Get-Tpm
    @{ status = if ($t.TpmPresent -and $t.TpmReady) { 'pass' } else { 'fail' }; value = @{ present = $t.TpmPresent; ready = $t.TpmReady } }
}))

[void]$checks.Add((Invoke-Check 'windows_hello' {
    if ($PSVersionTable.PSEdition -ne 'Desktop') { return @{ status = 'skipped'; value = 'Run in Windows PowerShell 5.1 to test (WinRT access)' } }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
        Select-Object -First 1
    $op = [Windows.Security.Credentials.KeyCredentialManager]::IsSupportedAsync()
    $task = $asTask.MakeGenericMethod([bool]).Invoke($null, @($op))
    $supported = $task.GetAwaiter().GetResult()
    @{ status = if ($supported) { 'pass' } else { 'fail' }; value = @{ key_credential_supported = $supported; note = 'Used for protected rule changes in M6' } }
}))

# --- BitLocker / device encryption -------------------------------------------
[void]$checks.Add((Invoke-Check 'disk_encryption' {
    # Non-admin method via the Shell property; values: 1 on, 2 off, 3 encrypting, 5 unlocked-on, 6 on (locked)
    $shell = New-Object -ComObject Shell.Application
    $v = $shell.NameSpace("$($env:SystemDrive)\").Self.ExtendedProperty('System.Volume.BitLockerProtection')
    $meaning = switch ($v) { 1 { 'on' } 2 { 'off' } 3 { 'encrypting' } 4 { 'decrypting' } 5 { 'on' } 6 { 'on' } default { "unknown ($v)" } }
    @{ status = if ($meaning -eq 'on') { 'pass' } else { 'fail' }; value = @{ system_drive = $env:SystemDrive; bitlocker = $meaning; why = 'Protects JARVIS data if the PC is stolen while off' } }
}))

# --- Virtualization features, WSL, Windows Sandbox ---------------------------
[void]$checks.Add((Invoke-Check 'optional_features' {
    if (-not $admin) { return @{ status = 'skipped'; value = 'Needs an elevated window' } }
    $names = 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform', 'Containers-DisposableClientVM'
    $r = @{}
    foreach ($n in $names) {
        $f = Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction SilentlyContinue
        $r[$n] = if ($f) { [string]$f.State } else { 'NotAvailableOnThisEdition' }
    }
    @{ status = 'info'; value = $r }
}))

[void]$checks.Add((Invoke-Check 'wsl' {
    $ver = Invoke-Native 'wsl.exe' @('--version')
    $list = Invoke-Native 'wsl.exe' @('--list', '--verbose')
    $installed = ($ver.exit -eq 0)
    $hasWorkshop = $list.out -match 'jarvis-workshop'
    @{ status = if ($installed) { 'pass' } else { 'fail' }; value = @{
        installed = $installed; version_output = $ver.out; distros = $list.out
        jarvis_workshop_present = $hasWorkshop
        next_step = if ($installed) { 'Run 03-New-JarvisWorkshop.ps1' } else { 'Run 02-Enable-Wsl2.ps1 as Administrator, then reboot' }
    } }
}))

# --- Power, sleep, wake timers ------------------------------------------------
[void]$checks.Add((Invoke-Check 'wake_timers' {
    # SUB_SLEEP / "Allow wake timers". Output text is localized, so read the two hex indexes (AC, then DC).
    $q = Invoke-Native 'powercfg.exe' @('/query', 'SCHEME_CURRENT', '238c9fa8-0aad-41ed-83f4-97be242c8f20', 'bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d')
    $hex = @([regex]::Matches($q.out, '0x[0-9a-fA-F]{8}') | ForEach-Object { [Convert]::ToInt32($_.Value, 16) })
    $map = @{ 0 = 'disabled'; 1 = 'enabled'; 2 = 'important_only' }
    if ($hex.Count -lt 2) { return @{ status = 'error'; value = $q.out } }
    $ac = $map[$hex[$hex.Count - 2]]; $dc = $map[$hex[$hex.Count - 1]]
    @{ status = if ($ac -ne 'disabled') { 'pass' } else { 'fail' }; value = @{ on_mains = $ac; on_battery = $dc; note = 'Setting only; 06-Register-WakeTest.ps1 proves whether wake actually works' } }
}))

[void]$checks.Add((Invoke-Check 'sleep_states' {
    $a = Invoke-Native 'powercfg.exe' @('/a')
    @{ status = 'info'; value = @{ raw = $a.out; modern_standby = ($a.out -match 'S0') } }
}))

# --- Displays -----------------------------------------------------------------
[void]$checks.Add((Invoke-Check 'displays' {
    Add-Type -AssemblyName System.Windows.Forms
    $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        @{ primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
    })
    $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -ErrorAction SilentlyContinue).AppliedDPI
    @{ status = 'info'; value = @{ count = $screens.Count; screens = $screens; applied_dpi = $dpi; note = 'Bounds may be DPI-virtualized in this process; Phase 6 measures per-monitor DPI precisely' } }
}))

# --- Audio --------------------------------------------------------------------
[void]$checks.Add((Invoke-Check 'audio' {
    $ep = @(Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object Status -eq 'OK')
    $mics = @($ep | Where-Object { $_.FriendlyName -match 'Microphone|Mic|Headset' } | ForEach-Object FriendlyName)
    $outs = @($ep | Where-Object { $_.FriendlyName -notmatch 'Microphone|Mic' } | ForEach-Object FriendlyName)
    @{ status = if ($mics.Count -gt 0) { 'pass' } else { 'fail' }; value = @{ microphones = $mics; outputs = $outs; note = 'Voice input needs a microphone' } }
}))

# --- Tools already installed --------------------------------------------------
[void]$checks.Add((Invoke-Check 'tools' {
    $r = [ordered]@{}
    foreach ($t in @(
        @{ n = 'node'; a = @('--version') }, @{ n = 'npm'; a = @('--version') }, @{ n = 'git'; a = @('--version') },
        @{ n = 'dotnet'; a = @('--list-sdks') }, @{ n = 'python'; a = @('--version') }, @{ n = 'winget'; a = @('--version') },
        @{ n = 'claude'; a = @('--version') }, @{ n = 'codex'; a = @('--version') })) {
        $x = Invoke-Native $t.n $t.a
        $r[$t.n] = if ($null -eq $x.exit) { 'not installed' } else { $x.out }
    }
    $browsers = @{}
    foreach ($b in @(
        @{ n = 'edge'; p = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" },
        @{ n = 'edge64'; p = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" },
        @{ n = 'chrome'; p = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" },
        @{ n = 'chrome_user'; p = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" })) {
        if ($b.p -and (Test-Path $b.p)) { $browsers[$b.n] = (Get-Item $b.p).VersionInfo.ProductVersion }
    }
    $r['browsers'] = $browsers
    @{ status = 'info'; value = $r }
}))

# --- Defender -----------------------------------------------------------------
[void]$checks.Add((Invoke-Check 'defender' {
    $p = Get-MpPreference -ErrorAction Stop
    $cfa = switch ($p.EnableControlledFolderAccess) { 0 { 'off' } 1 { 'on' } 2 { 'audit' } default { "$($p.EnableControlledFolderAccess)" } }
    @{ status = 'info'; value = @{ controlled_folder_access = $cfa; note = 'If on, JARVIS executables must be allowed before they can write to protected folders' } }
}))

$path = Save-Result -Spike 'inventory' -Data @($checks)
$summary = $checks | ForEach-Object { '{0,-18} {1}' -f $_.name, $_.status }
Write-Host ($summary -join "`n")
Write-Host "`nNext: see README.md step 2." -ForegroundColor Yellow
