<#
.SYNOPSIS
  Phase 0, step 8: measure how well Windows UI Automation can "see" your apps.
.DESCRIPTION
  Read-only. Lists top-level windows and, for the apps you name, counts the
  UI elements UI Automation exposes and which control patterns they support
  (a proxy for how reliably JARVIS could operate that app without pixels).
  It never clicks, types or changes anything; input is tested in Phase 6.
  Window titles are NOT recorded unless you pass -IncludeTitles (they can
  contain email subjects, file names, etc.). Screenshots are analysed in
  memory for "is it black" and never saved.
.PARAMETER AppNames       Process names to inspect deeply, e.g. msedge, OUTLOOK, explorer, WINWORD, Code
.PARAMETER MaxElements    Cap per app (default 3000).
.PARAMETER LockTest       Also test what works while the workstation is locked (you lock it with Win+L).
.PARAMETER IncludeTitles  Record window titles (off by default).
#>
[CmdletBinding()] param(
    [string[]] $AppNames = @(),
    [int] $MaxElements = 3000,
    [switch] $LockTest,
    [switch] $IncludeTitles
)
. "$PSScriptRoot\common.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition

function Get-TopWindows {
    $out = @()
    $children = $AE::RootElement.FindAll($Tree::Children, $True_)
    foreach ($w in $children) {
        try {
            $c = $w.Current
            $proc = try { (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch { '?' }
            $item = [ordered]@{
                process      = $proc
                framework    = $c.FrameworkId
                control_type = $c.ControlType.ProgrammaticName
                offscreen    = $c.IsOffscreen
            }
            if ($IncludeTitles) { $item['title'] = $c.Name }
            $out += $item
        } catch { }
    }
    return $out
}

function Measure-App([string] $Name) {
    $procs = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return [ordered]@{ app = $Name; status = 'skipped'; reason = 'not running' } }
    $ids = $procs | ForEach-Object { $_.Id }
    $windows = @($AE::RootElement.FindAll($Tree::Children, $True_) | Where-Object { $ids -contains $_.Current.ProcessId })
    if ($windows.Count -eq 0) { return [ordered]@{ app = $Name; status = 'skipped'; reason = 'no top-level window' } }

    $patternNames = @{}
    $types = @{}
    $count = 0; $named = 0; $withId = 0; $frameworks = @{}
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    foreach ($win in $windows) {
        $stack = New-Object System.Collections.Stack
        $stack.Push($win)
        while ($stack.Count -gt 0 -and $count -lt $MaxElements -and $sw.Elapsed.TotalSeconds -lt 60) {
            $el = $stack.Pop()
            try {
                $c = $el.Current
                $count++
                if ($c.Name) { $named++ }
                if ($c.AutomationId) { $withId++ }
                $t = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
                $types[$t] = 1 + [int]$types[$t]
                if ($c.FrameworkId) { $frameworks[$c.FrameworkId] = 1 }
                foreach ($p in $el.GetSupportedPatterns()) {
                    $pn = $p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', ''
                    $patternNames[$pn] = 1 + [int]$patternNames[$pn]
                }
                $child = $walker.GetFirstChild($el)
                while ($child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
            } catch { }
        }
    }
    $sw.Stop()
    $actionable = 0
    foreach ($k in @('Invoke', 'Value', 'Toggle', 'SelectionItem', 'ExpandCollapse', 'Text')) {
        if ($patternNames.ContainsKey($k)) { $actionable += $patternNames[$k] }
    }
    $rating = if ($count -lt 15) { 'poor (likely custom-drawn: needs vision fallback)' }
              elseif ($named / [math]::Max($count, 1) -lt 0.3) { 'weak (few named elements)' }
              elseif ($actionable -lt 5) { 'weak (few actionable patterns)' }
              else { 'good' }
    return [ordered]@{
        app = $Name; status = 'info'; windows = $windows.Count
        elements = $count; capped = ($count -ge $MaxElements); seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        named_ratio = [math]::Round($named / [math]::Max($count, 1), 2)
        automation_id_ratio = [math]::Round($withId / [math]::Max($count, 1), 2)
        frameworks = @($frameworks.Keys); control_types = $types; patterns = $patternNames
        rating = $rating
    }
}

function Test-Screenshot {
    try {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $dark = 0; $n = 0
        for ($x = 0; $x -lt $b.Width; $x += [math]::Max(1, [int]($b.Width / 40))) {
            for ($y = 0; $y -lt $b.Height; $y += [math]::Max(1, [int]($b.Height / 40))) {
                $p = $bmp.GetPixel($x, $y); $n++
                if (($p.R + $p.G + $p.B) -lt 30) { $dark++ }
            }
        }
        $g.Dispose(); $bmp.Dispose()
        $ratio = [math]::Round($dark / [math]::Max($n, 1), 2)
        return @{ status = 'info'; captured = $true; width = $b.Width; height = $b.Height; black_ratio = $ratio; looks_black = ($ratio -gt 0.95) }
    } catch {
        return @{ status = 'info'; captured = $false; error = $_.Exception.Message }
    }
}

$result = [ordered]@{}
Write-Step 'Top-level windows'
$tops = Get-TopWindows
$result['top_windows'] = $tops
$result['top_window_count'] = @($tops).Count
Write-Host "  $(@($tops).Count) top-level windows"

Write-Step 'Screen capture check (image is not saved)'
$result['screenshot_unlocked'] = Test-Screenshot
$result['screens'] = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ primary = $_.Primary; width = $_.Bounds.Width; height = $_.Bounds.Height } })

$apps = @()
foreach ($a in $AppNames) {
    Write-Step "Inspecting $a"
    $m = Measure-App $a
    Write-Host "  elements=$($m['elements']) rating=$($m['rating']) $($m['reason'])"
    $apps += $m
}
$result['apps'] = $apps
if ($AppNames.Count -eq 0) {
    Write-Host 'Tip: open 5 apps you use daily and re-run with -AppNames, e.g.' -ForegroundColor Yellow
    Write-Host '  .\08-Test-UiAutomation.ps1 -AppNames msedge,explorer,OUTLOOK,WINWORD,Code'
    $procNames = @($tops | ForEach-Object { $_['process'] } | Sort-Object -Unique)
    Write-Host "  Running now: $($procNames -join ', ')"
}

if ($LockTest) {
    Write-Step 'Lock test: press Win+L within 20 seconds, wait ~40 seconds, then unlock'
    Start-Sleep -Seconds 30
    $lockedTops = try { @(Get-TopWindows).Count } catch { "error: $($_.Exception.Message)" }
    $lockedShot = Test-Screenshot
    Start-Sleep -Seconds 1
    $result['lock_test'] = [ordered]@{
        note = 'Measured ~30 s after the prompt; valid only if you had locked the PC by then.'
        top_windows_while_locked = $lockedTops
        screenshot_while_locked = $lockedShot
    }
    Write-Host 'Lock test recorded. You can unlock now.'
}

Save-Result -Spike 'ui_automation' -Data $result | Out-Null
