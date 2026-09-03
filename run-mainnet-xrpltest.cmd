@echo off
cd /d "%~dp0"
set EV_NETWORK=mainnet
set NOMAD_STAGE=xrpltest
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\testnet\run.ps1"
echo.
echo (full log in deploy\testnet\out\run.log)
timeout /t 900
