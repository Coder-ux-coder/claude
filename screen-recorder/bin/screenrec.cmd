@echo off
REM screenrec launcher - lets "screenrec" run from cmd.exe and PowerShell alike.
REM Calls the PowerShell recorder sitting next to this file, bypassing the
REM execution policy so it works on a default Windows install.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0screenrec.ps1" %*
