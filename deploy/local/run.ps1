# Runs the Nomad Connector on a local 3-node HotPocket cluster (hpdevkit + Docker Desktop)
# and pays through it with a real ILP/STREAM client. Everything is logged to deploy\local\out\.
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\local\run.ps1
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$out = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item (Join-Path $out "DONE") -ErrorAction SilentlyContinue
Start-Transcript -Path (Join-Path $out "run.log") -Force | Out-Null
function Step($name) { Write-Host ""; Write-Host "=== $name  $(Get-Date -Format HH:mm:ss) ===" }

Step "versions"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "ERROR: node is not installed on this machine (needed for hpdevkit and the peer demo)."; "no-node" | Out-File (Join-Path $out "DONE"); Stop-Transcript | Out-Null; exit 1 }
node -v; npm -v
docker version --format "docker server {{.Server.Version}}"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: docker is not reachable."; "no-docker" | Out-File (Join-Path $out "DONE"); Stop-Transcript | Out-Null; exit 1 }

Step "hpdevkit"
# Installed locally (not -g) with --ignore-scripts: its evernode-js-client dependency tries to
# build native modules on install, which needs VS build tools on Windows; hpdevkit itself is an
# ncc bundle and does not need them for a local cluster.
$hpkPrefix = Join-Path $out "hpk"
$hpk = Join-Path $hpkPrefix "node_modules\.bin\hpdevkit.cmd"
if (-not (Test-Path $hpk)) {
  New-Item -ItemType Directory -Force -Path $hpkPrefix | Out-Null
  cmd /c "npm install hpdevkit@0.6.9 --ignore-scripts --no-audit --no-fund --prefix `"$hpkPrefix`" > `"$out\npm-hpdevkit.log`" 2>&1"
  Get-Content (Join-Path $out "npm-hpdevkit.log") -Tail 15
}
if (-not (Test-Path $hpk)) { Write-Host "ERROR: hpdevkit did not install (see out\npm-hpdevkit.log)"; "no-hpdevkit" | Out-File (Join-Path $out "DONE"); Stop-Transcript | Out-Null; exit 1 }
cmd /c "`"$hpk`" version 2>&1"

Step "deploy contract to a 3-node cluster"
Set-Location (Join-Path $root "contract")
$env:HP_CLUSTER_SIZE = "3"
$env:HP_DEFAULT_NODE = "0"   # 0 = do not stream node logs after deploy (deploy returns)
$deployLog = Join-Path $out "deploy.log"
cmd /c "`"$hpk`" deploy dist > `"$deployLog`" 2>&1"
Get-Content $deployLog -Tail 40 -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 10
  $names = @(docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "hpdevkit_default_node" })
  Write-Host ("  hotpocket nodes up: " + $names.Count)
} while (((Get-Date) -lt $deadline) -and ($names.Count -lt 3))
Start-Sleep -Seconds 25
docker ps --format "{{.Names}}  {{.Status}}  {{.Ports}}"

Step "node logs"
foreach ($n in $names) { Write-Host "--- $n"; docker logs --tail 60 $n 2>&1 | Out-String | Write-Host }

Step "peer demo (Alice on node 1, Bob on node 2)"
Set-Location $root
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node deploy\local\demo-real.js wss://localhost:8081 wss://localhost:8082 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
