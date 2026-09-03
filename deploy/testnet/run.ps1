# Nomad Connector on Evernode TESTNET, end to end. Staged and re-runnable: every stage that has
# already produced its output is skipped, so after a failure you fix the cause and run again.
#   deploy\testnet\run.ps1   (or double-click run-testnet.cmd)
# Logs: deploy\testnet\out\ ; secrets (testnet only): deploy\testnet\tenant.json, user.keys.json
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$here = $PSScriptRoot
$out = Join-Path $here "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item (Join-Path $out "DONE") -ErrorAction SilentlyContinue
Start-Transcript -Path (Join-Path $out "run.log") -Force | Out-Null
function Step($name) { Write-Host ""; Write-Host "=== $name  $(Get-Date -Format HH:mm:ss) ===" }
function Fail($code, $msg) { Write-Host "ERROR: $msg"; $code | Out-File (Join-Path $out "DONE"); Stop-Transcript | Out-Null; exit 1 }
Set-Location $root
$evdk = Join-Path $root "node_modules\evdevkit\index.js"
$dist = Join-Path $root "contract\dist"

Step "versions"
node -v
if (-not (Test-Path $evdk)) { Fail "no-evdevkit" "node_modules\evdevkit\index.js missing (install from the Linux side with --ignore-scripts)" }
if (-not (Test-Path (Join-Path $root "node_modules\xrpl"))) { Fail "no-xrpl" "node_modules\xrpl missing" }
if (-not (Test-Path (Join-Path $dist "index.js"))) { Fail "no-dist" "contract\dist\index.js missing (npm run build:testnet --workspace contract)" }
$env:EV_NETWORK = "testnet"

Step "1. tenant account (faucet XAH + EVR gift)"
$tenantFile = Join-Path $here "tenant.json"
if (-not (Test-Path $tenantFile)) { node (Join-Path $here "tenant.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "tenant.log") }
if (-not (Test-Path $tenantFile)) { Fail "no-tenant" "tenant account could not be created (see out\tenant.log)" }
$tenant = Get-Content $tenantFile -Raw | ConvertFrom-Json
Write-Host "tenant $($tenant.address) on $($tenant.server): $($tenant.xah) XAH, $($tenant.evr) EVR"
$env:EV_TENANT_SECRET = $tenant.secret
$env:EV_XAHAUD_SERVER = $tenant.server

Step "2. user keys"
$keysFile = Join-Path $here "user.keys.json"
if (-not (Test-Path $keysFile)) {
  $kg = cmd /c "node `"$evdk`" keygen --no-color 2>&1"
  $priv = ($kg | Select-String -Pattern "privateKey:\s*'?([0-9a-fA-F]+)'?" | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1)
  $pub  = ($kg | Select-String -Pattern "publicKey:\s*'?([0-9a-fA-F]+)'?"  | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1)
  if (-not $priv) { Write-Host $kg; Fail "no-keys" "could not parse evdevkit keygen output" }
  @{ privateKey = $priv; publicKey = $pub } | ConvertTo-Json | Out-File $keysFile
}
$keys = Get-Content $keysFile -Raw | ConvertFrom-Json
$env:EV_USER_PRIVATE_KEY = $keys.privateKey
Write-Host "user public key $($keys.publicKey)"

Step "3. hosts with free instance slots"
$hostsFile = Join-Path $here "hosts.txt"
node (Join-Path $here "hosts.js") 12 2>&1 | Tee-Object -FilePath (Join-Path $out "hosts.log")
$addrs = @()
if (Test-Path $hostsFile) { $addrs = @(Get-Content $hostsFile | Where-Object { $_ -match "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" }) }
Write-Host "hosts to use: $($addrs.Count)"
if ($addrs.Count -lt 3) { Fail "no-hosts" "fewer than 3 hosts with free slots on testnet (see out\hosts.log)" }

Step "4. connector config for this tenant"
$cfgPath = Join-Path $dist "nomad.config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$cfg.connector.masterAddress = $tenant.address
$cfg.connector.evrIssuer = $tenant.evrIssuer
$cfg.xahau.rippleServer = $tenant.server
$cfg.nomad.preferredHosts = @($addrs | Select-Object -First 12)
$cfg | ConvertTo-Json -Depth 8 | Out-File -Encoding ascii $cfgPath
Write-Host (Get-Content $cfgPath -Raw)

Step "5. cluster-create (3 nodes, 3 signers, 80% quorum)"
node (Join-Path $here "balance.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "balance.log")
$bal = Get-Content (Join-Path $out "balance.json") -Raw | ConvertFrom-Json
if ([double]$bal.evr -le 0) { Fail "no-evr" "tenant $($tenant.address) has no EVR; leases cannot be bought (see out\balance.log)" }
$clusterFile = Join-Path $dist "cluster.json"
if (-not (Test-Path $clusterFile)) {
  $env:EV_HP_OVERRIDE_CFG_PATH = Join-Path $here "hp.cfg.testnet.override"
  cmd /c "node `"$evdk`" cluster-create 3 `"$dist`" /usr/bin/node `"$hostsFile`" -a index.js --signer-count 3 --signer-quorum 0.8 -m 4 --no-color > `"$out\cluster-create.log`" 2>&1"
  Get-Content (Join-Path $out "cluster-create.log") -Tail 80
}
if (-not (Test-Path $clusterFile)) { Fail "no-cluster" "cluster-create did not produce cluster.json (see out\cluster-create.log)" }
Copy-Item $clusterFile (Join-Path $out "cluster.json") -Force
$cl = Get-Content $clusterFile -Raw | ConvertFrom-Json
foreach ($n in $cl.nodes) { Write-Host ("node " + $n.pubkey.Substring(0,12) + "… host " + $n.host + " " + $n.domain + ":" + $n.userPort + " signer " + $n.signerAddress) }
Write-Host "letting the cluster start and sync (90 s) …"
Start-Sleep -Seconds 90

Step "6. settlement demo on Xahau testnet"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node (Join-Path $here "demo-testnet.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
