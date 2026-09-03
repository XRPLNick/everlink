# Configuration reference

The contract reads `everlink.config.json` from its own directory at start-up (the build copies
it into `dist/`; the Evernode kit's `patch-config.js` fills in the tenant-specific fields).
Three sections: `connector` (the deterministic core), `xahau` (the ledger bridge) and `nomad`
(everpocket's cluster self-management). Every node of a cluster must run the same file — the
configuration is part of what makes rounds deterministic.

Peers can read the values that matter to them with the `info` read request; they are marked
*info* below. Amounts are strings of drops unless stated otherwise.

## `connector`

| key | default | deployed on mainnet | meaning |
|---|---|---|---|
| `ilpAddress` *info* | `g.everlink` | `g.everlink` (the run itself used `g.nomad`) | The connector's ILP prefix; peers are `<ilpAddress>.<public key>`. |
| `assetCode` *info* | `XAH` | `XAH` | Asset code reported by ILDCP. |
| `assetScale` *info* | `6` | `6` | Asset scale reported by ILDCP (drops). |
| `feeBps` *info* | `10` | `25` | Spread taken from every fulfilled packet, in basis points, rounded up per packet. |
| `feeFlat` *info* | `"0"` | `"0"` | Extra drops taken per fulfilled packet. |
| `minExpiryWindowMs` *info* | `5000` | `8000` | Shaved off the expiry at each hop; a Prepare must expire more than two windows after the consensus timestamp. Must exceed a round comfortably. |
| `maxPacketAmount` *info* | `"1000000000"` | same | Largest Prepare accepted (1 000 XAH); larger ones get `F08` with the limit in the data. |
| `maxPendingPerPeer` | `500` | `500` | Prepares one peer may have in flight (`T03` beyond). |
| `probeCreditDrops` | `"10000"` | `"10000"` | Credit every peer gets on top of its balance so unfunded receivers can answer STREAM's rate probes. |
| `devFaucetDrops` | `"0"` | `"0"` | **Development only**: starting balance handed to every new peer on clusters without a ledger. Never set on a real deployment. |
| `maxPeers` | `10000` | `10000` | Cap on peer records (`err: connector is full` beyond). |
| `idlePeerRounds` | `20000` | `20000` | Peers that owe nothing, hold nothing and have been silent this many rounds are forgotten (checked every 100 rounds). |
| `minSettleDelaySec` | `3600` | `600` | Channels with a shorter `SettleDelay` are refused for claims. |
| `masterAddress` *info* | `null` | the tenant account | The cluster's multisig Xahau account: peers open channels to it, payouts come from it. Required when `xahau.enabled`; with `null` the core routes packets but plans no settlement. |
| `redeemThresholdDrops` *info* | `"10000000"` | `"1000000"` | Redeem a channel once this much is claimed but unredeemed (and always when the owner starts closing). |
| `payoutThresholdDrops` *info* | `"5000000"` | `"500000"` | Pay a peer out automatically once it is owed this much. |
| `minPayoutDrops` *info* | `"1000000"` | `"100000"` | Smallest payout on an explicit `withdraw`. |
| `reserveDrops` | `"20000000"` | `"5000000"` | Never spend the account below this (Xahau reserve plus a buffer). |
| `baseFeeDrops` | `"12"` | `"12"` | Per-signer transaction fee; everpocket multiplies it by signers + 2 (60 drops on the 3-node cluster). |
| `evrIssuer` | Evernode's EVR issuer | same | Issuer of the EVR trust line the treasury watches. |
| `evrReserve` | `"20"` | `"0.01"` | Keep at least this many EVR for lease payments; below it the treasury buys more. |
| `evrTopUpXahDrops` | `"5000000"` | `"1000000"` | Most XAH to spend per DEX top-up. |
| `evrTopUpMinEvr` | `"10"` | `"1"` | Least EVR to accept for it (limit price of the immediate-or-cancel offer). |

## `xahau`

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` runs the connector without a ledger: no facts, no settlement, `masterAddress` forced to `null`. Used by the local development cluster together with `devFaucetDrops`. |
| `network` | `mainnet` | `mainnet` or `testnet` (`devnet` is accepted but has no network id yet): selects the Xahau network id (21337 / 21338) and the built-in ledger definitions. |
| `rippleServer` | `null` (network default) | WebSocket endpoint the nodes query, e.g. `wss://xahau.network`. |
| `factsEvery` | `5` | Observe the ledger (balances, channels, EVR line, transaction results) and vote on it every this many rounds; also whenever a settlement is pending. Deployed: 3. |
| `nomadEvery` | `10` | Run everpocket's Nomad housekeeping every this many rounds. |

## `nomad`

Passed to everpocket's `NomadContext`, which keeps the cluster alive from the master account:
prunes dead nodes, acquires replacements from `preferredHosts`, extends leases that are near
expiry. The keys are everpocket's own:

| key | example | meaning |
|---|---|---|
| `targetNodeCount` | `3` | Cluster size to maintain (also the number of signers). |
| `lifeIncrMomentMinLimit` | `2` | Extend a lease when fewer than this many moments remain. |
| `maxLifeMomentLimit` | `12` | Never extend beyond this many moments ahead. |
| `preferredHosts` | `["rHost1…", …]` | Host accounts to acquire from, in order; the Evernode kit fills this from `hosts.<network>.txt`. |
| `instanceCfg` | `{ "config": { "log": { "log_level": "inf" } } }` | HotPocket instance configuration for newly acquired nodes. |

Set `nomad` to `null` to run without self-management (the local ledger soak test does this).

## HotPocket settings that matter to peers

Not in this file but in the HotPocket override (`hp.cfg.override`, `deploy/testnet/hp.cfg.testnet.override`):
`consensus.roundtime` 3000 ms (the clock everything above is measured in), `consensus.threshold`
60 (a 3-node cluster keeps closing ledgers with one node down), `round_limits` (4 MiB caps on
user input, user output and NPL output per round; the wire protocol's own 64 KiB per-input cap
is stricter), and `mesh.msg_forwarding` / `peer_discovery` so nodes that cannot reach each
other directly still form a mesh. HotPocket's own `round_limits.exec_timeout` (5 minutes on the
hosts) is how long one round may run before the node gives up on the contract — a round that
hits it is a fault, and the diagnostics exist to find why.
