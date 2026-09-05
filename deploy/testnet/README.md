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
| `run-mainnet-2h.cmd` | `run-mainnet.cmd` with `EVERLINK_MOMENTS=2`: two-moment leases, so the contract's own renewals (`leaseExtendAheadMoments` 2) fall due the moment it starts — the self-funding test | lease EVR + what the cluster then spends on renewals (0.000024 EVR per host: 24 moments) |
| `run-mainnet-2h-known-hosts.cmd` | the same, with `EVERLINK_PREFER_HOSTS` set to the three hosts of the 3 September cluster, which are put first in `hosts.mainnet.txt` if they are active with a free slot (the ranked list follows) — used after the tenth deployment's hosts never formed a mesh | as above |
| `run-mainnet-probe.cmd` | from this machine: TCP and WebSocket probes of every node's peer port and user port (`out/probe-peers.log`) — the first thing to run when the nodes report no peers | nothing (read-only) |
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

### Day two (4 September): the ninth cluster died

At 13:22 UTC it renewed one node's lease with nobody watching (`DDE117FB…`, 0.000022 EVR, three
signers); it never renewed the other two, and at 15:20 UTC their hosts burned the lease tokens
and reclaimed the instances. `run-mainnet-status.cmd` at 15:30 reached one node of three, ledger
stuck at 11265, facts vote 1/3. With two signer keys gone the account is frozen for good (11.98
XAH, 1 EVR, no peers). The full account is in [docs/proof.md](../../docs/proof.md#day-two-how-the-second-cluster-died).
The cause is not on record — the diagnostics kept a minute of history — and two mechanisms fit:
everpocket's serial renewal queue blocked by a host its tenant client would not pay ("Host is
not active."), and the contract's 30-second cap on the housekeeping phase.

### Since then: the last will and the contract's own renewals

The contract now carries a [last will](../../docs/money.md#if-the-cluster-dies-the-last-will)
— when the lease fact shows the signer quorum's hosting ending within `lastWillSec` (30 minutes)
unrenewed, the cluster stops taking money, redeems every claim and pays every peer out while it
can still sign — and [renews its own leases](../../docs/money.md#keeping-the-hosts-paid): most
urgent node first, one per round, per-node backoff, in the submission phase that no timeout cuts
short; everpocket's Nomad keeps prune and grow only. `{"t":"diag","events":500,"filter":"lease"}`
returns a node's whole renewal history, and `run-mainnet-status.cmd` prints each node's lease and
renewal bookkeeping. The dead cluster ran the code from before any of this and had no upgrade
path, so the same evening the new code went out on a **new tenant account**
(`rKJFVrTc3wcnZfVvDDJcB1qo28VJjvNZgA`, funded by hand with 10 XAH and, once `run-mainnet.cmd`
had set the trust line, 1 EVR).

### Tenth deployment (17:30 UTC, 4 September): the mesh never formed

`run-mainnet-2h.cmd` on the three best-ranked hosts of the hour (`zeb-a-nodew-01.xahaud.xyz`,
`evernode2.kimchigraphics.com`, `xrp-arnie14.monster.xrp-arnie1.com`; three operators, three
countries). `cluster-create` finished normally at 17:32 — acquires, extensions, signer list,
bundle uploaded — and the cluster never came to life. Sixteen minutes later the primary had the
contract (it ran one round, lcl 65, then waited for votes that never came), the two secondaries
were still running evdevkit's bootstrap contract with a UNL of one node (the primary), their
ledgers stuck at 27 and 24, and no node reported a peer. From this machine every peer port
answered TCP (`run-mainnet-probe.cmd`, written for the occasion), so it was not a firewall.
evdevkit's handoff is: secondaries follow the primary for thirty seconds, then the bundle goes to
the primary alone and reaches the others through consensus; on these hosts the secondaries never
caught the primary, and the user keys evdevkit gives them are discarded once the create is
over, so the bundle cannot be pushed to them by hand afterwards. Cost: 0.000006 EVR and a few
fees; the instances expire with their two-moment leases. Cause unknown; the same procedure had
worked the day before.

### Eleventh deployment (17:50 UTC): the contract renews its own leases in its second minute

`run-mainnet-2h-known-hosts.cmd`: the same run on the three hosts of the ninth cluster
(`evernode.kimchigraphics.com` as primary, `xrp-arnie13.sbs.xrp-arnie1.com`,
`zeb-a-nodew-04.xahaud.xyz`), all active with a free slot. `cluster-create` ran 17:50–17:53;
the contract's first rounds followed within a minute. Its first renewal attempt, node 1's lease
at about 17:54:04, failed after twenty seconds with everpocket's `No enough signatures: Total
weight: 1, Quorum: 2` — the other two signers had not joined the mesh yet — and the per-node
backoff (20 rounds) did what it was built for: at lcl 72, 73 and 74 the three renewals went
through, 24 moments each, 0.000024 EVR per host, 600-drop fee, `evnExtendLease` hook parameter:

| UTC | Ledger | Hash | Host | Signers |
|---|---|---|---|---|
| 17:54:52 | 25,565,969 | `3B0709064FF392D38B3B70A14B1F7B220675316DA6BBC48B2CFBB73F563C02E2` | `rfW86DFVRKUCc53pKdWTyGFMTfeYNNERhs` evernode.kimchigraphics.com | 2 |
| 17:55:11 | 25,565,974 | `537CE61D0E89307DE21247DEC547D04DF36E4B68FEE7504D76F7EFE418C94AFF` | `rfHECp4mtFnc6Y3jTsknjJocCisCVjtjf9` xrp-arnie13.sbs.xrp-arnie1.com | 3 |
| 17:55:21 | 25,565,976 | `10F6C92ACCD530994F12DFFF9CC36656CE21F0D6763D84A165D014840C057344` | `rLJU57DimMryraUobdL3iiAMhMmHHfCmnf` zeb-a-nodew-04.xahaud.xyz | 3 |

`run-mainnet-status.cmd` at 17:58: three of three nodes reachable and in consensus, every node
`paid until 2026-09-05T19:31:02Z`, each with its `last renewed lcl`. One
reading to distrust: HotPocket's `peers` count in the status line — the primary reported
`peers 0` while voting in step with the other two, so a zero there is not by itself the
tenth deployment's symptom; stuck ledgers and a one-node UNL on the secondaries are.

### Day three (5 September): the first unattended renewals

Due at 17:31 UTC, two moments before the leases' end at 19:31; done at 17:31:12, 17:31:21 and
17:31:30 UTC (ledgers 25,589,511 / 513 / 516; `5CEC3B11…`, `FE18131D…`, `5C26F049…`; 0.000024
EVR each, three signers, 600 drops) — zeb-a-nodew-04 first, then xrp-arnie13, then
evernode.kimchigraphics.com, which is the core's tie-break by node id when the leases end
together. `run-mainnet-status.cmd` at 17:59: 3/3 nodes advancing and vote-synced at round
19,770, each node `paid until 2026-09-06T19:31:02Z`, `last renewed lcl` 19392 / 19393 / 19394,
account 9.991838 XAH and 0.999844 EVR, no errors in the recorded rounds. everpocket's record
reads `life 50/2` per node: two moments bought by evdevkit, two renewals of 24 by the contract.
The abandoned tenth cluster's hosts burned their tokens at 19:30–19:31 UTC the evening before.

The master key is **not** retired. The next renewals fall due about 17:31 UTC on 6 September;
the order that the ninth run taught stands: let the cluster renew all its nodes unattended
at least twice (two days) before `run-mainnet-retire.cmd`, and let it live a week alone
before inviting a peer. Still to check
on the first day with money: that the first redemption and payout — every one of the
contract's own transactions carries an `everlink/intent` memo — are accepted at the usual
multisig fee (a `telINSUF_FEE_P` in the diagnostics would mean `baseFeeDrops` needs raising).

Testnet (`wss://hooks-testnet-v3.xrpl-labs.com`) is blocked at `no-evr`: the foundation's
`giftBetaEvr` requests are answered by hand. Devnet is not live.
