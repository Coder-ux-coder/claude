<#
.SYNOPSIS
  Phase 0, step 6: schedule a one-time task that wakes the PC from sleep.
.DESCRIPTION
  Registers the scheduled task "JarvisPhase0-WakeTest" (current user, only
  when logged on, WakeToRun) that fires once, N minutes from now. When it
  fires it writes a timestamp to the results folder and plays a Windows alarm
  sound. Put the PC to sleep (Start > Power > Sleep) straight after running this.
  Run 07-Complete-WakeTest.ps1 after it has woken. No Administrator needed.
.PARAMETER Minutes     Delay before the wake (default 5, minimum 3).
.PARAMETER PowerLabel  'mains' or 'battery': what the PC is running on for this test.
#>
[CmdletBinding()] param(
    [ValidateRange(3, 120)] [int] $Minutes = 5,
    [ValidateSet('mains', 'battery')] [string] $PowerLabel = 'mains',
    [switch] $Yes
)
. "$PSScriptRoot\common.ps1"
$TaskName = 'JarvisPhase0-WakeTest'

$fireScript = Join-Path $script:Phase0Root 'wake-fire.ps1'
$logPath = Join-Path $script:ResultsDir 'wake-fired.txt'
Remove-Item $logPath -Force -ErrorAction SilentlyContinue
@"
`$ts = (Get-Date).ToUniversalTime().ToString('o')
Add-Content -Path '$logPath' -Value `$ts
try { (New-Object Media.SoundPlayer 'C:\Windows\Media\Alarm01.wav').PlaySync() } catch { }
"@ | Set-Content -Path $fireScript -Encoding UTF8

$at = (Get-Date).AddMinutes($Minutes)
Write-Host "This registers task '$TaskName' to wake the PC at $($at.ToString('HH:mm:ss')) and play an alarm sound."
if (-not $Yes -and -not (Confirm-Action 'Register it?')) { Write-Host 'Stopped.'; return }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$fireScript`""
$trigger = New-ScheduledTaskTrigger -Once -At $at
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

$state = [ordered]@{
    status       = 'scheduled'
    power_label  = $PowerLabel
    scheduled_at = $at.ToUniversalTime().ToString('o')
    registered_at = (Get-Date).ToUniversalTime().ToString('o')
    minutes      = $Minutes
}
Save-Result -Spike 'wake_test_registered' -Data $state | Out-Null
Write-Host ''
Write-Host "Now put the PC to sleep (Start > Power > Sleep). Do NOT shut down or hibernate." -ForegroundColor Yellow
Write-Host "Leave it for at least $Minutes minutes. If it wakes and you hear an alarm, run 07-Complete-WakeTest.ps1."
Write-Host "If it does not wake, press the power button after $($Minutes + 2) minutes and run 07-Complete-WakeTest.ps1 anyway."
