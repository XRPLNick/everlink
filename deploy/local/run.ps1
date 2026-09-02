# Runs the Nomad Connector on a local 3-node HotPocket cluster (hpdevkit + Docker) and pays
# through it with a real ILP/STREAM client. Everything is logged to deploy\local\out\.
#   powershell -ExecutionPolicy Bypass -File deploy\local\run.ps1
$ErrorActionPreference = "Continue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$out = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out "run.log"
Start-Transcript -Path $log -Force | Out-Null
function Step($name) { Write-Host "`n=== $name ===" }

Step "versions"
node -v; npm -v; docker version --format "docker {{.Server.Version}}"
docker ps --format "{{.Names}}" | Out-Null

Step "hpdevkit"
if (-not (Get-Command hpdevkit -ErrorAction SilentlyContinue)) { npm i -g hpdevkit }
hpdevkit --version

Step "deploy contract (3 nodes)"
Set-Location (Join-Path $root "contract")
$env:HP_CLUSTER_SIZE = "3"
hpdevkit deploy dist
Start-Sleep -Seconds 20

Step "node 1 log (tail)"
$l1 = Join-Path $out "node1.log"
hpdevkit logs 1 2>&1 | Select-Object -Last 60 | Tee-Object -FilePath $l1

Step "peer demo"
Set-Location $root
if (-not (Test-Path (Join-Path $root "node_modules\hotpocket-js-client"))) { npm install --ignore-scripts --no-audit --no-fund }
node deploy\local\demo-real.js 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
