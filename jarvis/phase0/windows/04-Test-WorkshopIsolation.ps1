<#
.SYNOPSIS
  Phase 0, step 4: prove the jarvis-workshop distro cannot reach Windows.
.DESCRIPTION
  Creates a harmless canary file in your user profile and a temporary
  listener on 127.0.0.1, then runs isolation-redteam.sh inside the distro as
  the unprivileged "worker" user. Every escape probe should fail.
  Cleans up the canary and listener afterwards. No Administrator needed.
#>
[CmdletBinding()] param()
. "$PSScriptRoot\common.ps1"
$Distro = 'jarvis-workshop'

$canaryName = "jarvis-canary-$([guid]::NewGuid().ToString('N').Substring(0,12)).txt"
$canaryPath = Join-Path $env:USERPROFILE $canaryName
Set-Content -Path $canaryPath -Value 'JARVIS Phase 0 canary. Safe to delete.' -Encoding ASCII

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
# Accept connections in the background so a successful connect is observable.
$acceptJob = $listener.BeginAcceptTcpClient($null, $null)

try {
    Write-Step "Running the red-team script inside $Distro (canary $canaryName, port $port)"
    $r = Invoke-Native 'wsl.exe' @('-d', $Distro, '-u', 'worker', '--', 'bash', '/opt/jarvis-phase0/isolation-redteam.sh', $canaryName, "$port")
    Write-Host $r.out
    $windowsSawConnection = $acceptJob.IsCompleted
    $jsonLine = ($r.out -split "`n") | Where-Object { $_ -match '^\{"spike":"isolation"' } | Select-Object -First 1
    $parsed = if ($jsonLine) { $jsonLine | ConvertFrom-Json } else { $null }
    $escapes = if ($parsed) { $parsed.escapes } else { -1 }
    Save-Result -Spike 'workshop_isolation' -Data @{
        status = if ($escapes -eq 0) { 'pass' } elseif ($escapes -gt 0) { 'fail' } else { 'error' }
        escapes = $escapes
        windows_listener_saw_connection = $windowsSawConnection
        linux_report = $parsed
        raw = if ($parsed) { $null } else { $r.out }
    } | Out-Null
    if ($escapes -eq 0) { Write-Host 'PASS: no escape from the workshop distro' -ForegroundColor Green }
    else { Write-Warning "Isolation problems found ($escapes). The report lists each one." }
}
finally {
    $listener.Stop()
    Remove-Item $canaryPath -Force -ErrorAction SilentlyContinue
}
