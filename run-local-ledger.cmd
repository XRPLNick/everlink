@echo off
cd /d "%~dp0"
set NOMAD_SKIP_DEMO=1
set NOMAD_REDEPLOY=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\local\run.ps1"
echo.
echo (full log in deploy\local\out\run.log)
timeout /t 900
