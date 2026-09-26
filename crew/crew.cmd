@echo off
rem Crew launcher for Windows
set "DIR=%~dp0"
set "PYTHONPATH=%DIR%;%PYTHONPATH%"
where py >nul 2>nul && (py -3 -m crewlib %* & exit /b %errorlevel%)
python -m crewlib %*
