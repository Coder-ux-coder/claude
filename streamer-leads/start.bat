@echo off
REM Streamer Lead Workspace - double-click launcher for Windows.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
