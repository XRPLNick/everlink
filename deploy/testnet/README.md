# Nomad Connector on Evernode (testnet or mainnet)

One PowerShell script, `deploy/testnet/run.ps1`, driven by the launchers in the repo root.
`EV_NETWORK` picks the network (testnet, devnet, mainnet), `NOMAD_STAGE` the stage
(`hosts`, `keys`, `deploy`, `demo`). Everything is logged under `deploy/testnet/out/`; when a
stage fails, the `DONE` file names the reason (`no-tenant`, `no-xah`, `no-evr`, `no-hosts`,
`no-cluster`, ...). Fix the cause and run again: finished stages are skipped.

## Mainnet, step by step (real XAH and EVR)

Nothing here moves money on its own. You fund three addresses from your own wallet; the
scripts only ever spend from the tenant account when *you* launch the deploy or the demo.

| launcher | what it does | spends |
|---|---|---|
| `run-mainnet-hosts.cmd` | lists active hosts with free slots and their lease prices (`out/hosts.log`, `hosts.mainnet.txt`) | nothing (read-only) |
| `run-mainnet-keys.cmd` | generates the tenant (= the connector's multisig account), Alice and Bob key pairs into git-ignored files on this machine and prints the addresses to fund | nothing |
| *you* | send **10 XAH** to the tenant, **8 XAH** to Alice, **2 XAH** to Bob | 20 XAH stay yours, minus fees |
| `run-mainnet.cmd` | adds an EVR trust line to the tenant if missing (fee only) and stops with `no-evr` until the tenant holds EVR; then `evdevkit cluster-create`: buys 3 leases for 4 moments (about 0.000012 EVR on the cheapest reputable hosts, capped by `NOMAD_EVR_LIMIT`, default: the whole EVR balance), installs a 3-signer SignerList (2-of-3) on the tenant account and uploads the contract | lease EVR + fees; ~2 XAH of reserve gets locked (SignerList, trust line, 3 lease tokens) |
| *you* | send **1 EVR** to the tenant once the trust line exists (any amount works; the leases cost microscopic sums) | 1 EVR |
| `run-mainnet-demo.cmd` | Alice opens a 5 XAH channel to the cluster account, claims 3 XAH, pays Bob 1 XAH over STREAM; the cluster redeems the claim and pays Bob out with multisigned transactions; Alice then asks to close and the cluster closes the channel, returning her unspent 2 XAH | 1 XAH goes Alice -> Bob (fee 0.0025 XAH stays in the cluster account) |

After the demo the tenant account holds its 10 XAH + 3 XAH redeemed - 0.9975 XAH paid to Bob;
the master key still controls it, so you can sweep it whenever you like. Retiring that key
(so no person controls the connector) is deliberately not automated: it is irreversible.

Knobs: `NOMAD_SIZE` (nodes = signers, default 3), `NOMAD_MOMENTS` (lease length, default 4 =
4 hours on mainnet), `NOMAD_EVR_LIMIT`. Mainnet-only config patches applied by `run.ps1`:
`reserveDrops` 5 XAH (never paid out), `evrReserve` 0.01 EVR (no DEX top-ups during the demo).

## Testnet

`run-testnet.cmd`: the same stages, but the tenant and the demo peers come from the network
faucet (`tenant.js`, `lib.js`) and the EVR is requested from the foundation's gift account.

1. **tenant.js** - creates a Xahau testnet account, funds it from the faucet, sets an EVR trust
   line and asks for the test EVR gift. Writes `tenant.testnet.json` (git-ignored).
2. **user keys** - `evdevkit keygen` -> `user.testnet.keys.json` (the tenant's HotPocket user identity).
3. **hosts.js** - hosts with free slots -> `hosts.testnet.txt` (best candidates first).
4. **config** - patches `contract/dist/nomad.config.json` with the tenant address, EVR issuer,
   Xahau server and preferred hosts (build the dist first: `npm run build:testnet --workspace contract`).
5. **cluster-create** - `evdevkit cluster-create 3 ... --signer-count 3 --signer-quorum 0.6 -m 4`:
   acquires 3 instances, generates one signer key per node, sets the SignerList on the tenant
   account, uploads the contract. Writes `contract/dist/cluster.json`.
6. **demo-testnet.js** - Alice and Bob get faucet accounts; Alice opens a 5 XAH payment channel
   to the master account and streams a 3 XAH claim; she pays Bob 1 XAH with `ilp-protocol-stream`
   through the cluster; the script then watches Xahau for the cluster's multisigned
   `PaymentChannelClaim` (channel redeemed) and `Payment` (Bob paid out), and finally has Alice
   close the channel.

## Status (3 September 2026)

* Testnet (`wss://hooks-testnet-v3.xrpl-labs.com`, network id 21338): stages 1-4 ran; the
  tenant `rDin6EpnMJqJL2HkWyu7F3K47qUseGBTY2` holds 1000 faucet XAH and an EVR trust line, six
  active hosts were found. Blocked at stage 5 with `no-evr`: the `giftBetaEvr` request is
  answered by hand, not by a bot (dozens of unanswered requests on the foundation account).
  Devnet is not live (its governor has no configuration).
* Mainnet (`wss://xahau.network`, network id 21337): `run-mainnet-hosts.cmd` found 12,106
  registered hosts, 5,842 active, 5,834 with free slots; lease prices from 0.000001 to 1
  EVR/moment (median 0.0005). The twenty best-reputed hosts (reputation 252 on the 0-255 scale) all charge
  0.000001 EVR/moment, so a 3-node cluster for 4 moments costs 0.000012 EVR. Next: keys,
  funding, deploy, demo (see the table above).
