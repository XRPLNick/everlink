# Everlink on Evernode (testnet or mainnet)

One PowerShell script, `deploy/testnet/run.ps1`, driven by the launchers in `deploy/windows/` (double-click them, or set the same variables and run the script from any shell).
`EV_NETWORK` picks the network (testnet, devnet, mainnet), `EVERLINK_STAGE` the stage
(`hosts`, `keys`, `status`, `deploy`, `demo`, `trace`, `withdraw`). Everything is logged under `deploy/testnet/out/`; when a
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
| `run-mainnet.cmd` | adds an EVR trust line to the tenant if missing (fee only) and stops with `no-evr` until the tenant holds EVR; then `evdevkit cluster-create`: buys 3 leases for 4 moments (about 0.000012 EVR on the cheapest reputable hosts, capped by `EVERLINK_EVR_LIMIT`, default: the whole EVR balance), installs a 3-signer SignerList (2-of-3) on the tenant account and uploads the contract | lease EVR + fees; ~2 XAH of reserve gets locked (SignerList, trust line, 3 lease tokens) |
| *you* | send **1 EVR** to the tenant once the trust line exists (any amount works; the leases cost microscopic sums) | 1 EVR |
| `run-mainnet-demo.cmd` | Alice opens a 5 XAH channel to the cluster account, claims 3 XAH, pays Bob 1 XAH over STREAM; the cluster redeems the claim and pays Bob out with multisigned transactions; Alice then asks to close and the cluster closes the channel, returning her unspent 2 XAH | 1 XAH goes Alice -> Bob (fee 0.0025 XAH stays in the cluster account) |
| `run-mainnet-trace.cmd` | the same payment again (2 XAH channel, 1 XAH claim, 1 XAH over STREAM) with every ILP packet recorded and decoded into `out/stream-trace.txt` / `.json`; Bob is paid out and Alice's channel closed as in the demo | 1 XAH Alice -> Bob (fee 0.0025 XAH) |
| `run-mainnet-2h.cmd` | `run-mainnet.cmd` with `EVERLINK_MOMENTS=2`: two-hour leases, so that with the config's `lifeIncrMomentMinLimit` 4 the cluster's Nomad loop extends the leases itself right after starting — the self-funding test | lease EVR + whatever the cluster then spends on extensions (0.000017 EVR per host on the run below) |
| `run-mainnet-retire.cmd` | **irreversible**: disables the tenant's master key (`AccountSet asfDisableMaster`) so the cluster's signer list is the only control of the account; refuses unless the ledger's signer list is the running cluster's and a quorum of nodes answers | one fee; the account's balance is the connector's from then on |
| `run-mainnet-status.cmd` | asks every node for its ledger height, UNL, contract counters and diagnostics (`out/status.log`) | nothing (read-only) |
| `run-mainnet-withdraw.cmd` | a saved demo peer names its payout address and asks for its unspent connector credit back (`EVERLINK_PEER`, default alice) | nothing beyond the cluster's own fee |

After the demo the tenant account holds its 10 XAH plus the 3 XAH redeemed minus the ~1 XAH
paid to Bob and a few drops of fees; while the master key still controls it you can sweep it
whenever you like. Retiring that key (so no person controls the connector) is a separate,
deliberate launcher because it is irreversible.

Knobs: `EVERLINK_SIZE` (nodes = signers, default 3), `EVERLINK_MOMENTS` (lease length, default 4 =
4 hours on mainnet), `EVERLINK_EVR_LIMIT`. Mainnet-only config patches applied by `run.ps1`:
`reserveDrops` 5 XAH (never paid out), `evrReserve` 0.01 EVR (no DEX top-ups during the demo).

## Testnet

`run-testnet.cmd`: the same stages, but the tenant and the demo peers come from the network
faucet (`tenant.js`, `lib.js`) and the EVR is requested from the foundation's gift account.

1. **tenant.js** - creates a Xahau testnet account, funds it from the faucet, sets an EVR trust
   line and asks for the test EVR gift. Writes `tenant.testnet.json` (git-ignored).
2. **user keys** - `evdevkit keygen` -> `user.testnet.keys.json` (the tenant's HotPocket user identity).
3. **hosts.js** - hosts with free slots -> `hosts.testnet.txt` (best candidates first).
4. **config** - patches `contract/dist/everlink.config.json` with the tenant address, EVR issuer,
   Xahau server and preferred hosts (build the dist first: `npm run build:testnet --workspace contract`).
5. **cluster-create** - `evdevkit cluster-create 3 ... --signer-count 3 --signer-quorum 0.6 -m 4`:
   acquires 3 instances, generates one signer key per node, sets the SignerList on the tenant
   account, uploads the contract. Writes `contract/dist/cluster.json`.
6. **demo-testnet.js** - Alice and Bob get faucet accounts; Alice opens a 5 XAH payment channel
   to the master account and streams a 3 XAH claim; she pays Bob 1 XAH with `ilp-protocol-stream`
   through the cluster; the script then watches Xahau for the cluster's multisigned
   `PaymentChannelClaim` (channel redeemed) and `Payment` (Bob paid out), and finally has Alice
   close the channel.

## Status (3 September 2026): settled on Xahau mainnet

Eighth deployment, cluster `evernode4.kimchigraphics.com` / `zeb-a-nodew-01.xahaud.xyz` /
`evernode12.laurenka.nl`, tenant `r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC` (10 XAH + 1 EVR):

```
04:38:02 channel 34EE69A2... (Alice -> cluster, 5 XAH)
04:38:20 claim_ack ok, credited 3 XAH               (cluster observed the channel on-ledger)
04:39:14 STREAM connection established in 35857 ms
04:39:38 Alice paid Bob 1.000000 XAH in 23990 ms; Bob received 0.997500 XAH
04:39:53 payout validated: 0.996499 XAH tx 2BFB084E2ECA77F01F2E9E8C821D84C3303B6EB1D0AB4966076300784498836D
04:40:55 channel redeemed 3 XAH, Bob on-ledger 2.996499 XAH (was 2); master 11.984604 XAH
04:41:11 channel closed by the cluster; Alice on-ledger 4.999976 XAH (was 2.999988)
```

The payout is a Payment in ledger 25,528,756 multi-signed by the three signer accounts evdevkit
generated (one key file per host, outside consensus state). Alice's unspent 2 XAH of connector
credit stayed under her (then ephemeral) HotPocket identity; the demo now saves the peers'
identities in `peers.mainnet.json` and withdraws leftover credit at the end
(`run-mainnet-withdraw.cmd` does it on its own for a saved peer).

`run-mainnet-trace.cmd` (`trace-stream.js`) repeats a 1 XAH payment and records every ILP
packet both peers see — decoded with `ilp-packet`, STREAM frames decrypted with the receiver's
secret, fulfillments checked against conditions — into `out/stream-trace.txt` / `.json`. The
trace of the 05:48 UTC run is in `docs/proof/`; `docs/proof.md` walks through it.

What the seven failed deployments before it found, all fixed in this kit:

* Windows PowerShell 5.1 read em dashes in `run.ps1` as quotes (ASCII + BOM now) and its
  `ConvertTo-Json` threw `OutOfMemoryException` on the config (patched by node now).
* evdevkit `cluster-create` stops if a host's extend-lease acknowledgement times out; the
  `--recover` flag changes the argv hash its cache is keyed on, so `recover-cluster.js` copies
  the partial cluster file to the name the recovery run will look for.
* Hosts that answer on the ledger but not on their instance ports, and same-operator instances
  that cannot reach each other's peer ports: `hosts.js` probes a window of instance ports and
  spreads the list across operators; the HotPocket override sets `threshold` 60 so 2-of-3
  keeps closing ledgers (evdevkit's 0.8 quorum on three signers is 3-of-3; 0.6 is 2-of-3).
  Spreading by domain alone was not enough: `evernode4.kimchigraphics.com` and
  `evernode12.laurenka.nl`, two of the three hosts of the successful run, resolve to the same
  IP (the nodes' own probes show it), so one operator may hold two of the three signer keys.
  `hosts.js` now also treats hosts in the same /24 as one operator.
* The one that cost the most time: `ncc` copies prebuilt native add-ons from several packages
  under colliding names, `ws` loaded the wrong one as `bufferutil`, and every WebSocket frame
  to Xahau longer than 48 bytes crashed the node process. From outside that looks like a round
  that takes HotPocket's whole 5-minute `exec_timeout`. `index.js` now forces `ws` onto its
  JavaScript implementations and the build externalizes those add-ons. It was found with the
  contract's own diagnostics: `{"t":"diag","probe":true,"layers":true}` (read request) returns
  per-node round timings, crash traces and a DNS/TCP/TLS/WebSocket/xrpl/evernode probe run in a
  child process; `run-mainnet-status.cmd` prints it.
* xrpl.js 4 derives an ed25519 key from a seed unless told `ecdsa-secp256k1`.

### Ninth deployment (20:19 UTC): the cluster pays for its own hosting

`run-mainnet-2h.cmd` on three new hosts (`evernode.kimchigraphics.com`, `zeb-a-nodew-04.xahaud.xyz`,
`xrp-arnie13.sbs.xrp-arnie1.com` — three domains, three networks this time). Two-hour leases; the
contract's Nomad settings make the first extension due at once. Within four minutes of the nodes
starting, the cluster multisigned three EVR payments of 0.000017 to its hosts (`evnExtendLease`
hook parameter, three signers, 600-drop fee) — hashes in `docs/proof.md` — and its diagnostics
read `nomad lcl 120: 3 nodes [… life 19/19 1133 min left …]`: nineteen hours of hosting bought by
the contract itself. The bridge now records every Nomad decision (`nomad lcl N: …` and
`nomad says: …` marks in the diag events), which is what `run-mainnet-status.cmd` shows.

At 20:43 UTC, with all three nodes answering, `run-mainnet-retire.cmd` disabled the master key
(`AccountSet` `F008B4708261BC55A67505004B246181661D89B0CA9040BE765BE2DD23D3C6B0`, ledger
25,544,790). The tenant secret in `tenant.mainnet.json` can no longer sign anything; the stages
that need it (`deploy`, `keys`) are finished for this account, and `demo`, `trace`, `withdraw`
and `status` never needed it.

Testnet (`wss://hooks-testnet-v3.xrpl-labs.com`) is blocked at `no-evr`: the foundation's
`giftBetaEvr` requests are answered by hand. Devnet is not live.
