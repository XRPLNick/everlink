@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\local\run.ps1"
echo.
echo (this window closes in 15 minutes; full log in deploy\local\out\run.log)
timeout /t 900
