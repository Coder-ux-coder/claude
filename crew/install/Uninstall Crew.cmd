@echo off
rem Double-click this file to remove Crew from this computer.
title Uninstall Crew
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1"
