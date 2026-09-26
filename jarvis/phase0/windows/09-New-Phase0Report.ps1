<#
.SYNOPSIS
  Phase 0, step 12: merge every result into one report you can send back.
.DESCRIPTION
  Reads %LOCALAPPDATA%\JarvisPhase0\results\*.json and writes
  phase0-report.md (summary table) and phase0-results.zip (all JSON) to the
  same folder. Your Windows user name and computer name are already redacted
  in each file; open the report and check it before sharing.
#>
[CmdletBinding()] param()
. "$PSScriptRoot\common.ps1"

$files = @(Get-ChildItem -Path $script:ResultsDir -Filter '*.json' | Sort-Object Name)
if ($files.Count -eq 0) { throw "No results in $($script:ResultsDir). Run the other steps first." }

function Get-Status($doc) {
    $r = $doc.results
    if ($null -eq $r) { return '?' }
    if ($r -is [array]) {
        $bad = @($r | Where-Object { $_.status -in @('fail', 'error') }).Count
        return $(if ($bad -gt 0) { 'partial' } else { 'pass' })
    }
    $p = $r.PSObject.Properties['status']
    if ($p) { return [string]$p.Value }
    $v = $r.PSObject.Properties['verdict']
    if ($v -and $v.Value.PSObject.Properties['status']) { return [string]$v.Value.status }
    return 'recorded'
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# JARVIS Phase 0 report')
$lines.Add('')
$lines.Add("Generated $((Get-Date).ToUniversalTime().ToString('u')). User and computer names are redacted.")
$lines.Add('')
$lines.Add('| Result file | Spike | Status | Recorded |')
$lines.Add('|---|---|---|---|')
$failures = New-Object System.Collections.Generic.List[string]
foreach ($f in $files) {
    try {
        $doc = Get-Content $f.FullName -Raw | ConvertFrom-Json
        # Linux-side files have no envelope: wrap them so one reader works.
        if (-not $doc.PSObject.Properties['results']) { $doc = [pscustomobject]@{ spike = $doc.spike; recorded_at = ''; results = $doc } }
        $st = Get-Status $doc
        $when = $doc.recorded_at
        if ($when -is [datetime]) { $when = $when.ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + 'Z' }
        $lines.Add("| $($f.Name) | $($doc.spike) | $st | $when |")
        if ($st -in @('fail', 'error', 'partial', 'inconclusive')) { $failures.Add("$($f.Name): $st") }
    } catch {
        $lines.Add("| $($f.Name) | ? | unreadable | |")
        $failures.Add("$($f.Name): unreadable")
    }
}

$inv = Join-Path $script:ResultsDir 'inventory.json'
if (Test-Path $inv) {
    $lines.Add('')
    $lines.Add('## Inventory checks')
    $lines.Add('')
    $lines.Add('| Check | Status | Value |')
    $lines.Add('|---|---|---|')
    $doc = Get-Content $inv -Raw | ConvertFrom-Json
    foreach ($c in @($doc.results)) {
        $val = if ($c.PSObject.Properties['value']) { ($c.value | ConvertTo-Json -Compress -Depth 4) } elseif ($c.PSObject.Properties['error']) { "error: $($c.error)" } else { '' }
        $val = ($val -replace '\s+', ' ')
        if ($val.Length -gt 160) { $val = $val.Substring(0, 157) + '...' }
        $lines.Add("| $($c.name) | $($c.status) | $($val -replace '\|', '/') |")
    }
}

$lines.Add('')
$lines.Add('## Needs attention')
$lines.Add('')
if ($failures.Count -eq 0) { $lines.Add('Nothing: every recorded spike passed.') } else { foreach ($x in $failures) { $lines.Add("- $x") } }

$missing = @('inventory', 'wsl_enable', 'workshop_create', 'workshop_isolation', 'coding_workers', 'wake_test_mains', 'wake_test_battery', 'ui_automation', 'sqlite', 'browser', 'boss_eval') |
    Where-Object { -not (Test-Path (Join-Path $script:ResultsDir "$_.json")) }
$lines.Add('')
$lines.Add('## Not run yet')
$lines.Add('')
if (@($missing).Count -eq 0) { $lines.Add('None.') } else { foreach ($m in $missing) { $lines.Add("- $m") } }

$reportPath = Join-Path $script:Phase0Root 'phase0-report.md'
[IO.File]::WriteAllText($reportPath, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding($false)))
$zipPath = Join-Path $script:Phase0Root 'phase0-results.zip'
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $script:ResultsDir '*.json'), $reportPath -DestinationPath $zipPath
Write-Host "Report: $reportPath" -ForegroundColor Green
Write-Host "Bundle: $zipPath  (check it, then send it back)" -ForegroundColor Green
