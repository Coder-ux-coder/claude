@echo off
REM One command to start on Windows. Double-click this file, or run it from
REM PowerShell / Command Prompt. The bash equivalent is run.sh.
setlocal

cd /d "%~dp0"

REM Windows installs the launcher as "python", not "python3".
set PY=python
where python >nul 2>nul || set PY=py
where %PY% >nul 2>nul || (
  echo.
  echo   Python was not found.
  echo   Install it from https://www.python.org/downloads/ and tick
  echo   "Add python.exe to PATH" on the first screen of the installer.
  echo.
  pause
  exit /b 1
)

%PY% -c "import flask, requests, yaml, phonenumbers" >nul 2>nul
if errorlevel 1 (
  echo Installing dependencies ^(first run only^)...
  %PY% -m pip install --quiet -r requirements.txt
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo.
  echo   Created .env for your API keys.
  echo   You can paste them into the Setup page once the app opens.
  echo.
)

echo.
echo   Starting. Your browser should open at http://127.0.0.1:8000
echo   Paste your API keys at http://127.0.0.1:8000/setup
echo   Leave this window open while you use it. Press Ctrl+C to stop.
echo.

start "" http://127.0.0.1:8000
%PY% -m leadenrich.cli ui

endlocal
