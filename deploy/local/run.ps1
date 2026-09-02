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
# npm on this machine is broken ("Class extends value undefined"), so hpdevkit is not installed
# with npm here: it was installed into node_modules from the Linux side of the Cowork bridge
# (--ignore-scripts: its evernode-js-client dependency would otherwise try a native build) and
# is run straight through node. hpdevkit is a self-contained ncc bundle that only shells out to docker.
$hpkIndex = Join-Path $root "node_modules\hpdevkit\index.js"
if (-not (Test-Path $hpkIndex)) { Write-Host "ERROR: node_modules\hpdevkit\index.js is missing"; "no-hpdevkit" | Out-File (Join-Path $out "DONE"); Stop-Transcript | Out-Null; exit 1 }
cmd /c "node `"$hpkIndex`" version 2>&1"

Step "deploy contract to a 3-node cluster"
Set-Location (Join-Path $root "contract")
$env:HP_CLUSTER_SIZE = "3"
$env:HP_DEFAULT_NODE = "0"   # 0 = do not stream node logs after deploy (deploy returns)
$deployLog = Join-Path $out "deploy.log"
$names = @(docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "hpdevkit_default_node" })
if ($names.Count -ge 3 -and -not $env:NOMAD_REDEPLOY) {
  Write-Host "cluster already running ($($names.Count) nodes); set NOMAD_REDEPLOY=1 to redeploy the contract"
} else {
  cmd /c "node `"$hpkIndex`" deploy dist > `"$deployLog`" 2>&1"
  Get-Content $deployLog -Tail 25 -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "Pulling|Download|Extracting" }
  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 10
    $names = @(docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "hpdevkit_default_node" })
    Write-Host ("  hotpocket nodes up: " + $names.Count)
  } while (((Get-Date) -lt $deadline) -and ($names.Count -lt 3))
  Start-Sleep -Seconds 25
}
docker ps --format "{{.Names}}  {{.Status}}  {{.Ports}}"

Step "node logs"
foreach ($n in $names) { Write-Host "--- $n"; cmd /c "docker logs --tail 12 $n 2>&1" }

Step "peer demo (Alice on node 1, Bob on node 2)"
Set-Location $root
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node deploy\local\demo-real.js wss://localhost:8081 wss://localhost:8082 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "node logs after the demo"
foreach ($n in (docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "hpdevkit_default_node" })) { cmd /c "docker logs --since 6m $n > `"$out\$n.log`" 2>&1" }

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
