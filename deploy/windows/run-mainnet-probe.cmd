@echo off
cd /d "%~dp0..\.."
set EV_NETWORK=mainnet
node deploy\testnet\probe-peers.js > deploy\testnet\out\probe-peers.log 2>&1
type deploy\testnet\out\probe-peers.log
echo.
echo (log in deploy\testnet\out\probe-peers.log)
timeout /t 120
