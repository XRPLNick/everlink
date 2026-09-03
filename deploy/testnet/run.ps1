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
if (-not $env:EV_NETWORK) { $env:EV_NETWORK = "testnet" }
$net = $env:EV_NETWORK
$stage = if ($env:NOMAD_STAGE) { $env:NOMAD_STAGE } else { "deploy" }   # hosts | keys | deploy | demo
Write-Host "Evernode network: $net   stage: $stage"
if ($stage -eq "hosts") {
  Step "hosts with free instance slots ($net) - read-only"
  node (Join-Path $here "hosts.js") 20 2>&1 | Tee-Object -FilePath (Join-Path $out "hosts.log")
  Stop-Transcript | Out-Null; "finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE"); exit 0
}
if ($stage -eq "keys") {
  Step "mainnet key pairs (tenant, Alice, Bob) - nothing is funded or sent"
  node (Join-Path $here "gen-accounts.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "keys.log")
  Stop-Transcript | Out-Null; "finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE"); exit 0
}

Step "1. tenant account"
$tenantFile = Join-Path $here "tenant.$net.json"
if (-not (Test-Path $tenantFile)) {
  if ($net -eq "mainnet") { Fail "no-tenant" "no deploy\testnet\tenant.mainnet.json: run run-mainnet-keys.cmd (or fill in tenant.mainnet.example.json with an account of your own)" }
  node (Join-Path $here "tenant.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "tenant.log")
}
if (-not (Test-Path $tenantFile)) { Fail "no-tenant" "tenant account could not be created (see out\tenant.log)" }
if ($net -eq "mainnet") {
  # Funded by you; this only adds the EVR trust line if it is missing (fee only).
  node (Join-Path $here "prep-tenant.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "prep-tenant.log")
  $prep = $LASTEXITCODE
  if ($prep -eq 3) { Fail "no-xah" "tenant account is not funded yet: send it 10 XAH, then run again (see out\prep-tenant.log)" }
  if ($prep -eq 4) { Fail "no-evr" "tenant has no EVR yet: the trust line exists now, send some EVR and run again (see out\prep-tenant.log)" }
  if ($prep -ne 0) { Fail "no-tenant" "prep-tenant.js failed (see out\prep-tenant.log)" }
}
$tenant = Get-Content $tenantFile -Raw | ConvertFrom-Json
if ($net -eq "mainnet") { $b = Get-Content (Join-Path $out "balance.json") -Raw | ConvertFrom-Json; Write-Host "tenant $($tenant.address) on $($tenant.server): $($b.xah) XAH, $($b.evr) EVR" }
else { Write-Host "tenant $($tenant.address) on $($tenant.server): $($tenant.xah) XAH, $($tenant.evr) EVR" }
$env:EV_TENANT_SECRET = $tenant.secret
$env:EV_XAHAUD_SERVER = $tenant.server

Step "2. user keys"
$keysFile = Join-Path $here "user.$net.keys.json"
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
$hostsFile = Join-Path $here "hosts.$net.txt"
node (Join-Path $here "hosts.js") 12 2>&1 | Tee-Object -FilePath (Join-Path $out "hosts.log")
$addrs = @()
if (Test-Path $hostsFile) { $addrs = @(Get-Content $hostsFile | Where-Object { $_ -match "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" }) }
Write-Host "hosts to use: $($addrs.Count)"
if ($addrs.Count -lt 3) { Fail "no-hosts" "fewer than 3 hosts with free slots on testnet (see out\hosts.log)" }

Step "4. connector config for this tenant"
$cfgPath = Join-Path $dist "nomad.config.json"
node (Join-Path $here "patch-config.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "patch-config.log")
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $cfgPath) -or (Get-Item $cfgPath).Length -lt 100) { Fail "no-config" "could not write contract\dist\nomad.config.json (see out\patch-config.log)" }

if ($stage -eq "demo") {
  Step "6. settlement demo on $net (stage=demo)"
  if (-not (Test-Path (Join-Path $dist "cluster.json"))) { Fail "no-cluster" "no contract\dist\cluster.json - deploy first" }
  $env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
  node (Join-Path $here "demo-testnet.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")
  Stop-Transcript | Out-Null; "finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE"); exit 0
}

$size = if ($env:NOMAD_SIZE) { [int]$env:NOMAD_SIZE } else { 3 }
$moments = if ($env:NOMAD_MOMENTS) { [int]$env:NOMAD_MOMENTS } else { 4 }
# evdevkit rounds quorum*signers up: 0.8 on 3 signers is 3-of-3, which lets one dead host freeze
# the account. Use 2-of-3 for tiny clusters, 80% from 5 nodes on (everpocket's default).
$quorum = if ($size -le 4) { 0.6 } else { 0.8 }
Step "5. cluster-create ($size nodes, $size signers, quorum $quorum, $moments moments)"
if ($net -ne "mainnet") { node (Join-Path $here "balance.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "balance.log") }
$bal = Get-Content (Join-Path $out "balance.json") -Raw | ConvertFrom-Json
if ([double]$bal.evr -le 0) {
  node (Join-Path $here "inspect.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "inspect.log")
  Fail "no-evr" "tenant $($tenant.address) has no EVR; leases cannot be bought (see out\balance.log, out\inspect.log)"
}
# Hard cap on what cluster-create may spend on leases: evdevkit refuses to start if the estimated
# cost (cheapest preferred hosts x moments) exceeds it. Default: the tenant's whole EVR balance,
# override with NOMAD_EVR_LIMIT.
$evrLimit = if ($env:NOMAD_EVR_LIMIT) { $env:NOMAD_EVR_LIMIT } else { $bal.evr }
Write-Host "EVR limit for leases: $evrLimit"
$clusterFile = Join-Path $dist "cluster.json"
if (-not (Test-Path $clusterFile)) {
  $env:EV_HP_OVERRIDE_CFG_PATH = Join-Path $here "hp.cfg.testnet.override"
  $partial = @(Get-ChildItem (Join-Path $env:TEMP "evdevkit-cluster\partial-cluster-*.json") -ErrorAction SilentlyContinue)
  if ($partial.Count -gt 0) {
    Write-Host "resuming the cluster-create that stopped earlier (nodes already acquired)"
    cmd /c "node `"$(Join-Path $here 'recover-cluster.js')`" $size `"$dist`" `"$hostsFile`" $quorum $evrLimit > `"$out\cluster-create.log`" 2>&1"
  } else {
    cmd /c "node `"$evdk`" cluster-create $size `"$dist`" /usr/bin/node `"$hostsFile`" -a index.js --signer-count $size --signer-quorum $quorum -m $moments -e $evrLimit --no-color > `"$out\cluster-create.log`" 2>&1"
  }
  Get-Content (Join-Path $out "cluster-create.log") -Tail 80
}
if (-not (Test-Path $clusterFile)) { Fail "no-cluster" "cluster-create did not produce cluster.json (see out\cluster-create.log)" }
Copy-Item $clusterFile (Join-Path $out "cluster.json") -Force
$cl = Get-Content $clusterFile -Raw | ConvertFrom-Json
foreach ($n in $cl.nodes) { Write-Host ("node " + $n.pubkey.Substring(0,12) + "... host " + $n.host + " " + $n.domain + ":" + $n.userPort + " signer " + $n.signerAddress) }
if ($net -eq "mainnet") {
  Write-Host "cluster deployed. The settlement demo moves real XAH; run it deliberately with run-mainnet-demo.cmd"
  Stop-Transcript | Out-Null; "finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE"); exit 0
}
Write-Host "letting the cluster start and sync (90 s) ..."
Start-Sleep -Seconds 90

Step "6. settlement demo on Xahau testnet"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node (Join-Path $here "demo-testnet.js") 2>&1 | Tee-Object -FilePath (Join-Path $out "demo.log")

Step "done"
Stop-Transcript | Out-Null
"finished $(Get-Date -Format o)" | Out-File (Join-Path $out "DONE")
