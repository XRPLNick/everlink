@echo off
cd /d "%~dp0..\.."
set EVERLINK_SKIP_DEMO=1
set EVERLINK_REDEPLOY=1
set EVERLINK_DIST=dist-local
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\local\run.ps1"
echo.
echo (full log in deploy\local\out\run.log)
timeout /t 900
