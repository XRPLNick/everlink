@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nomad-connector\deploy\local\run.ps1"
echo.
echo (this window closes in 15 minutes; full log in nomad-connector\deploy\local\out\run.log)
timeout /t 900
