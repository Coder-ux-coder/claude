<#
.SYNOPSIS
  Phase 0, step 7: record whether the scheduled wake worked, then remove the task.
.DESCRIPTION
  Reads the fire log and the System event log (Kernel-Power 42 = entered sleep,
  Power-Troubleshooter 1 = resumed, with its wake source), writes
  wake_test_<mains|battery>.json and unregisters the task.
#>
[CmdletBinding()] param()
. "$PSScriptRoot\common.ps1"
$TaskName = 'JarvisPhase0-WakeTest'

$regPath = Join-Path $script:ResultsDir 'wake_test_registered.json'
if (-not (Test-Path $regPath)) { throw 'Run 06-Register-WakeTest.ps1 first.' }
$reg = (Get-Content $regPath -Raw | ConvertFrom-Json).results
# PowerShell 7 turns ISO strings in JSON into DateTime; 5.1 leaves them as text.
function ConvertTo-LocalTime($v) {
    if ($v -is [datetime]) { return $v.ToLocalTime() }
    return [datetime]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
}
$since = ConvertTo-LocalTime $reg.registered_at
$scheduled = ConvertTo-LocalTime $reg.scheduled_at

$logPath = Join-Path $script:ResultsDir 'wake-fired.txt'
$firedAt = if (Test-Path $logPath) { (Get-Content $logPath | Select-Object -First 1) } else { $null }

$sleepEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42; StartTime = $since } -ErrorAction SilentlyContinue)
$wakeEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1; StartTime = $since } -ErrorAction SilentlyContinue)
$wakeInfo = @($wakeEvents | ForEach-Object { @{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); message = ($_.Message -split "`n" | Select-Object -Last 3) -join ' ' } })

$slept = $sleepEvents.Count -gt 0
$fired = [bool]$firedAt
$firedOnTime = $false
if ($fired) {
    $delta = ((ConvertTo-LocalTime $firedAt) - $scheduled).TotalSeconds
    $firedOnTime = ($delta -ge -5 -and $delta -le 180)
}
$status = if (-not $slept) { 'inconclusive' } elseif ($fired -and $firedOnTime) { 'pass' } else { 'fail' }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$lastResult = if ($task) { ($task | Get-ScheduledTaskInfo).LastTaskResult } else { $null }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path $script:Phase0Root 'wake-fire.ps1') -Force -ErrorAction SilentlyContinue

Save-Result -Spike "wake_test_$($reg.power_label)" -Data ([ordered]@{
    status            = $status
    note              = if ($status -eq 'inconclusive') { 'No sleep event was logged after registration: the PC may not have gone to sleep.' } else { $null }
    power_label       = $reg.power_label
    scheduled_at      = $scheduled.ToUniversalTime().ToString('o')
    fired_at          = $firedAt
    fired_on_time     = $firedOnTime
    entered_sleep     = $slept
    wake_events       = $wakeInfo
    task_last_result  = $lastResult
}) | Out-Null
Remove-Item $logPath -Force -ErrorAction SilentlyContinue
Write-Host "Wake test ($($reg.power_label)): $status" -ForegroundColor $(if ($status -eq 'pass') { 'Green' } else { 'Yellow' })
