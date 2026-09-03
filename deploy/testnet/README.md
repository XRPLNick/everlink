# Nomad Connector on Evernode testnet

`run-testnet.cmd` (repo root) → `deploy/testnet/run.ps1`, staged and re-runnable:

1. **tenant.js** – creates a Xahau *testnet* account, funds it from the network faucet, sets an
   EVR trust line and asks the Evernode foundation for the test EVR gift. Writes `tenant.json`
   (git-ignored; testnet only). This account is the cluster's multisig **master address**.
2. **user keys** – `evdevkit keygen` → `user.keys.json` (the tenant's HotPocket user identity).
3. **hosts** – `evdevkit list` → `hosts.txt` (hosts with free slots, in the order listed).
4. **config** – patches `contract/dist/nomad.config.json` with the tenant address, EVR issuer,
   Xahau server and preferred hosts (build the dist first: `npm run build:testnet --workspace contract`).
5. **cluster-create** – `evdevkit cluster-create 3 … --signer-count 3 --signer-quorum 0.8 -m 4`:
   acquires 3 instances, generates one signer key per node, sets the SignerList on the tenant
   account, uploads the contract. Writes `contract/dist/cluster.json`.
6. **demo-testnet.js** – Alice and Bob get faucet accounts; Alice opens a 5 XAH payment channel
   to the master account and streams a 3 XAH claim; she pays Bob 1 XAH with `ilp-protocol-stream`
   through the cluster; the script then watches Xahau for the cluster's multisigned
   `PaymentChannelClaim` (channel redeemed) and `Payment` (Bob paid out).

Everything is logged under `deploy/testnet/out/`. If a stage fails, the `DONE` file names it
(`no-tenant`, `no-hosts`, `no-cluster`, …); fix and rerun — completed stages are skipped.

Retiring the tenant's master key after the SignerList is set (so no person controls the
account) is deliberately **not** automated here: it is irreversible and is a decision for a
real deployment, not a testnet run.

## Status (3 September 2026)

Stages 1–4 ran against the live Evernode testnet (`wss://hooks-testnet-v3.xrpl-labs.com`,
network id 21338): the tenant `rDin6EpnMJqJL2HkWyu7F3K47qUseGBTY2` was created and funded with
1000 XAH by the faucet, the EVR trust line is set, and six active hosts were found (five with
free slots, leases at 0.000001 EVR/moment). What is missing is **EVR**: the `giftBetaEvr`
request that Evernode's own test-account generator sends is answered by hand, not by a bot —
the foundation account shows dozens of unanswered requests and two 500 EVR gifts in the last
three months. Devnet is not live (its governor has no configuration). The run stops at stage 5
with `no-evr` until the tenant holds any EVR at all (3 nodes × 4 moments need 0.000012 EVR).
