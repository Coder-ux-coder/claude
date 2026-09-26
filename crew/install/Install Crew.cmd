@echo off
rem Double-click this file to install Crew, or to update it after downloading a newer version.
title Crew installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
