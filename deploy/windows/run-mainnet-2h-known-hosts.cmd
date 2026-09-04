@echo off
cd /d "%~dp0..\.."
set EV_NETWORK=mainnet
set EVERLINK_MOMENTS=2
set EVERLINK_STAGE=deploy
rem the three hosts of the 3 September cluster, which formed a mesh within a minute; ranked list after them
set EVERLINK_PREFER_HOSTS=rfW86DFVRKUCc53pKdWTyGFMTfeYNNERhs,rLJU57DimMryraUobdL3iiAMhMmHHfCmnf,rfHECp4mtFnc6Y3jTsknjJocCisCVjtjf9
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\testnet\run.ps1"
echo.
echo (full log in deploy\testnet\out\run.log)
timeout /t 900
