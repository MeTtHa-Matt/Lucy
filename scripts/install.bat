@echo off
setlocal
cd /d "%~dp0\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo L'installation a echoue. Lis le message ci-dessus et relance le script.
  pause
)
endlocal
