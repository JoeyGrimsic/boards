@echo off
rem doodleboard - double-click me to start
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python isn't installed yet. Grab it from https://www.python.org/downloads/
  echo   ^(tick "Add python.exe to PATH" during install^), then run this again.
  echo.
  pause
  exit /b
)
python server.py --app %*
pause
