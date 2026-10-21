@echo off
rem Adds "Boards" to the Start menu so you can type "boards" in Windows search.
rem Run  install-shortcut.bat remove  to take the shortcuts away again.
cd /d "%~dp0"
if /i "%~1"=="remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\shortcut.ps1" -Remove
  pause
  exit /b
)
set DESK=
choice /C YN /M "  Also put a Boards shortcut on your desktop"
if not errorlevel 2 set DESK=-Desktop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\shortcut.ps1" %DESK%
if errorlevel 1 (
  pause
  exit /b
)
echo.
echo   Done! Press the Windows key and type "boards" to open doodleboard.
echo   (It runs quietly in the background and stops a few minutes after you close its window.)
echo.
pause
