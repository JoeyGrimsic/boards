@echo off
rem doodleboard - get the latest version (your boards are never touched)
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Git isn't installed. Get it with:  winget install Git.Git
  echo   then close this window and run update.bat again.
  echo.
  pause
  exit /b
)
if not exist ".git" (
  echo.
  echo   This folder came from a zip, not from git, so it can't update itself.
  echo   See "Updating" in README.md for the one-time switch.
  echo.
  pause
  exit /b
)
git pull --ff-only
echo.
echo   Done. Restart doodleboard (close its window, run start.bat) to use the new version.
echo.
pause
