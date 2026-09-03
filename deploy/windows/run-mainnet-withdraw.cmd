@echo off
cd /d "%~dp0..\.."
set EV_NETWORK=mainnet
set EVERLINK_STAGE=withdraw
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\testnet\run.ps1"
echo.
echo (full log in deploy\testnet\out\run.log)
timeout /t 900
