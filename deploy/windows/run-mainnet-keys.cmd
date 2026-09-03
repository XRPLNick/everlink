@echo off
cd /d "%~dp0..\.."
set EV_NETWORK=mainnet
set EVERLINK_STAGE=keys
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\testnet\run.ps1"
echo.
echo (full log in deploy\testnet\out\run.log; addresses also in deploy\testnet\out\keys.log)
timeout /t 900
