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
if (-not (Get-Command hpdevkit -ErrorAction SilentlyContinue)) { cmd /c "npm i -g hpdevkit 2>&1" }
cmd /c "hpdevkit --help 2>&1" | Select-Object -First 5

Step "deploy contract to a 3-node cluster"
Set-Location (Join-Path $root "contract")
$env:HP_CLUSTER_SIZE = "3"
$deployLog = Join-Path $out "deploy.log"
# hpdevkit deploy keeps following node logs; run it detached and poll docker instead.
Start-Process -FilePath "cmd.exe" -ArgumentList "/c hpdevkit deploy dist > `"$deployLog`" 2>&1" -WindowStyle Hidden
$deadline = (Get-Date).AddMinutes(10)
do {
  Start-Sleep -Seconds 10
  $names = @(docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "hp" })
  Write-Host ("  containers up: " + $names.Count)
} while (((Get-Date) -lt $deadline) -and ($names.Count -lt 3))
Start-Sleep -Seconds 30
docker ps --format "{{.Names}}  {{.Status}}  {{.Ports}}"

Step "node logs"
foreach ($n in $names) { Write-Host "--- $n"; docker logs --tail 40 $n 2>&1 | Out-String | Write-Host }
Get-Content $deployLog -Tail 30 -ErrorAction SilentlyContinue

Step "peer demo (Alice on node 1, Bob on node 2)"
Set-Location $root
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node deploy\local\demo-real.js wss://localhost:8081 wss://localhost:8082 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
