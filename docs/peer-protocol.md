# Peer protocol

Peers and the connector exchange small JSON messages over the HotPocket user channel. You
normally never build them yourself — `ilp-plugin-hotpocket` does — but this is the contract
the plugin implements, and anything that can speak to a HotPocket node can implement it too.

## Transport and identity

- A peer connects to any node of the cluster with `hotpocket-js-client` (`wss://<host>:<userPort>`),
  authenticated by its ed25519 key. HotPocket signs every input with that key and delivers
  every output to exactly that user, so the connector never authenticates anything itself:
  **the peer's identity is its HotPocket public key** — `ed` followed by 64 hex characters —
  and everything the connector keeps for a peer (balance, in-flight packets, payout address)
  hangs off that key.
- Three kinds of exchange exist. **Inputs** are submitted to the contract, agreed by consensus
  and processed in the next round; they can change state. **Outputs** are what the contract
  sends back to a user, also per round. **Read requests** are answered by the node you are
  connected to, from the agreed state, without a round; they never change anything.
- Input nonces must be strictly increasing per user (a HotPocket rule); the plugin keeps a
  monotonic one so that packets fired in the same millisecond do not collide.
- Every message is a JSON object with a string field `t` (type). Inputs larger than 64 KiB are
  refused with `bad size`.
- Every peer gets an ILP address `<connector prefix>.<public key>`, e.g.
  `g.everlink.ed7c667b…01ff3e`. Anything after a further dot (`g.everlink.<key>.<anything>`)
  is delivered to that peer unchanged — STREAM uses that for its connection tokens.

## Inputs (peer → connector)

### `ilp` — route a packet, or answer one

```json
{"t":"ilp","id":"<peer-chosen id>","p":"<base64 ILP packet>"}
```

- `id`: 1–64 characters of `A-Z a-z 0-9 _ -`. For a Prepare you send, choose it yourself (the
  plugin uses 16 random hex characters); the reply comes back under the same `id`. For a
  Fulfill or Reject answering a Prepare the connector forwarded to you, reuse the `id` the
  connector sent it under.
- `p`: an ILP packet per RFC 27 (Prepare, Fulfill or Reject), OER-encoded, base64; at most
  48 KiB of base64. `ilp-packet` produces these.

A Prepare is checked in this order, and the first failure is returned as an ILP Reject under the
same `id` (see the table of codes below): connector winding down (its
[last will](money.md#if-the-cluster-dies-the-last-will)) → `F02`; duplicate `id` for this peer → `F00`; malformed
destination → `F00`; destination outside the connector's prefix → `F02`; unknown peer → `F02`;
addressed to yourself → `F02`; destination peer not currently connected → `T01`; amount
above `maxPacketAmount` → `F08`; `expiresAt` not later than *now + 2 × minExpiryWindowMs*
→ `R02`; amount above your balance plus the probe credit → `T04`; more than
`maxPendingPerPeer` packets already in flight → `T03`.

A Prepare to `peer.config` is an **ILDCP** request (RFC 31) and is answered at once from
configuration with your address, asset code and scale; it costs nothing and needs no balance.

If the Prepare passes, the amount is moved from your balance into a hold, the fee is computed
(`ceil(amount × feeBps / 10000) + feeFlat` drops), and the packet is forwarded to the
destination peer with the amount minus the fee, the same condition and data, and an expiry one
`minExpiryWindowMs` earlier than yours. When the destination answers:

- **Fulfill** whose SHA-256 matches the condition: the hold is released, the destination is
  credited the forwarded amount, the fee stays in the treasury, and the Fulfill is relayed to
  you under your `id`.
- **Fulfill** that does not match: ignored (an `err` output tells the destination); the packet
  stays pending until it expires, exactly as `ilp-connector` behaves.
- **Reject**: the hold is refunded and the Reject relayed to you, with `triggeredBy` set to the
  connector's address if the destination left it empty.
- Nothing before the outgoing expiry: at the start of the round after it, the hold is refunded
  and you receive `R00 transfer timed out`.
- The destination disconnects while the packet is pending: the hold is refunded and you
  receive `T01 peer disconnected` in that round.

### `claim` — fund your balance

```json
{"t":"claim","ch":"<64 hex channel id>","amt":"<cumulative drops>","sig":"<hex signature>"}
```

A Xahau payment-channel claim on a channel whose **destination** is the connector's account.
`amt` is the cumulative amount in drops (digits only), `sig` the channel owner's signature over
the standard claim signing data (`CLM\0` + channel id + amount as uint64) made with the key
whose public key is on the channel — what `ripple-binary-codec`'s `encodeForSigningClaim` plus
`ripple-keypairs`' `sign` produce, and what `signClaim` in the plugin does.

Answered with a `claim_ack` output. The checks, in order, and the `reason` you get if one
fails:

| reason | meaning |
|---|---|
| `connector is winding down` | The connector's [last will](money.md#if-the-cluster-dies-the-last-will) is executing: it takes no new money; `deadline` (ms since the epoch) says when its hosting ends. |
| `channel not (yet) observed on ledger` | The cluster has not seen the channel in its last ledger observation. It looks every `factsEvery` rounds; retry in ~10 s. Also what you get if the channel's destination is not the connector's account. |
| `channel is bound to another peer` | A channel is bound to the first peer that presents a valid claim on it and cannot be used by another identity afterwards. |
| `claim amount must exceed previous claim` | `amt` must be larger than the last accepted claim (`last` is returned). |
| `claim exceeds channel funding` | `amt` is more than the channel holds (`funded` is returned). |
| `channel is expired` | The channel's expiration has passed. |
| `settle delay too short` | The channel's `SettleDelay` is below `minSettleDelaySec` (returned). |
| `bad signature` | The signature does not verify against the channel's `PublicKey`. |

On success: `{"t":"claim_ack","ch":…,"amt":…,"ok":true,"credited":"<drops>","balance":"<drops>"}`
— `credited` is `amt` minus the previous claim, and is added to your balance immediately.

### `settle_to` — where to pay you out

```json
{"t":"settle_to","addr":"r…","tag":12345}
```

A Xahau classic address and an optional destination tag (0…2³²−1, or `null`). Answered with
`{"t":"ack","of":"settle_to","addr":…,"tag":…}`. Can be changed at any time; a payout already
planned keeps the address it was planned with. A different address or tag also resets the retry
backoff of a payout that failed. It is where the connector's last will pays you — without it, the
last will falls back to the account that owned the first channel you funded from, and if there is
none it cannot pay you at all (`balance` shows the answer as `lastWillTo`).

### `withdraw` — pay me out now

```json
{"t":"withdraw"}
```

Marks your balance for payout in the next planning step if it is at least `minPayoutDrops`
and the account has the funds on-ledger. Requires a payout address (`err` otherwise). Answered
with `{"t":"ack","of":"withdraw"}`; the payout itself is reported by `payout` outputs.

## Read requests (peer → node, answered immediately)

Sent with the HotPocket client's read-request call, not as inputs. Sending one as an input
returns `err: read-only request sent as input`.

| request | answer |
|---|---|
| `{"t":"info"}` | `ilpAddress` (yours), `connectorAddress` (the prefix), `assetCode`, `assetScale`, `feeBps`, `feeFlat`, `maxPacketAmount`, `minExpiryWindowMs`, `masterAddress` (the account to open channels to), `redeemThresholdDrops`, `payoutThresholdDrops`, `minPayoutDrops`, `lastWillSec`, `rounds` (rounds the contract has run), `stats` (`prepares`, `fulfills`, `rejects`, `expiries`, `claims`), `winding` (`true` while the last will executes), `lastWill` (`{ sinceLcl, sinceTs, deadlineMs }` or `null`), `lease` (the latest lease fact: `deadlineMs` when the signer quorum's hosting ends, `quorum`, `signers`, `momentMs`, `expiries` per signer node, latest first; `null` until observed), `leaseNote` (why the fact is missing or partial, e.g. a signer node without lease data; `null` when all is well) |
| `{"t":"balance"}` | `balance` (drops available), `held` (drops in flight), `payoutAddress`, `pendingPayout` (the payout record in progress, or `null`), `lastWillTo` (`{ address, tag, source: "settle_to" \| "channel" }` — where the last will would pay you — or `null`) |
| `{"t":"channels"}` | the channels bound to you — `id`, `owner`, `publicKey`, `fundedAmount`, `ledgerBalance` (already redeemed on-ledger), `lastClaimAmount`, `expiration`, `settleDelay`, `redeemPending`, `closePending` |

Amounts are decimal strings of drops throughout. `balance` can dip below zero by at most the
probe credit (0.01 XAH) while a probe packet is in flight; it is never charged beyond what you
prepaid.

## Outputs (connector → peer)

| output | meaning |
|---|---|
| `{"t":"ilp","id":…,"p":…}` | Either the reply (Fulfill/Reject) to a Prepare you sent under that `id`, or a Prepare forwarded to you, which you must answer under that `id`. |
| `{"t":"claim_ack",…}` | Result of a `claim` (above). |
| `{"t":"payout","status":"submitted","amt":…,"tx":…}` | A Payment to your payout address has been co-signed and submitted; `tx` is its hash. Every transaction the cluster submits carries a memo of type `everlink/intent` naming the intent it fulfils (`p<n>` for payouts). |
| `{"t":"payout","status":"validated","amt":…,"tx":…}` | The ledger validated it. |
| `{"t":"payout","status":"failed","amt":…,"tx":…,"reason":…,"retryAfterRounds":…}` | It was rejected, never validated, or (`reason: submission lost`) planned by a round that died before submitting it; the amount is back in your balance and will be tried again after `retryAfterRounds` rounds (20, doubling per failure, at most 2 000; 0 for a lost submission, which is nobody's fault). |
| `{"t":"last_will","active":true,"deadline":…,"balance":…,"payoutTo":…,"payoutSource":…}` | The connector is winding down: its hosting ends at `deadline` (ms since the epoch) and your `balance` is being paid to `payoutTo` (`payoutSource` `settle_to` or `channel`). With no known home, `payoutTo` is `null` and a `hint` asks for a `settle_to`. Payouts made this way carry `"lastWill":true`. Sent to every connected peer when the wind-down starts. |
| `{"t":"last_will","active":false,"deadline":…}` | The hosting was extended after all; normal operation has resumed. |
| `{"t":"ack","of":"settle_to"\|"withdraw",…}` | Acknowledgement of a setting. |
| `{"t":"err","reason":…,"ref":…}` | Something malformed or impossible: `not json`, `missing type`, `bad id`, `bad packet`, `bad channel`, `bad amount`, `bad signature`, `bad address`, `bad tag`, `unknown type`, `bad size`, `connector is full`, `undecodable ILP packet`, `no such pending packet`, `fulfillment does not match condition`, `set a payout address first (settle_to)`, `read-only request sent as input`. |

## ILP rejection codes the connector emits

| code | message | when |
|---|---|---|
| `F00` | `duplicate packet id` / `invalid destination address` / `invalid amount` | Malformed or repeated Prepare. |
| `F02` | `destination not reachable through this connector` / `unknown peer` / `cannot route to self` | The destination is not one of the connector's peers. |
| `F02` | `connector is winding down: its hosting ends soon and balances are being paid out` | The connector's last will is executing; it routes nothing any more. Final, so STREAM stops rather than retrying; your balance is on its way to your payout address. |
| `F08` | `packet exceeds maximum amount` | Amount above `maxPacketAmount`; the data field carries the received and maximum amounts (RFC 27 F08 format), which STREAM uses to size its packets. |
| `R00` | `transfer timed out` | The forwarded packet expired without a reply. |
| `R02` | `insufficient timeout` | Your `expiresAt` leaves less than two expiry windows. |
| `T01` | `peer is not connected` / `peer disconnected` | The destination peer has no connection to the cluster (now, or it dropped while your packet was pending). |
| `T03` | `too many packets in flight` | More than `maxPendingPerPeer` (500) of your Prepares are pending. |
| `T04` | `insufficient prepaid balance; send a payment-channel claim` | Amount exceeds your balance plus the 0.01 XAH probe credit. |

Rejects generated by the *destination* (for example STREAM's `F99` on its rate probes, or `T99`
when a server shuts down) are relayed as they are, `triggeredBy` filled in if empty. The
plugin itself produces two local rejects that never went through the cluster: `R00 no reply
from connector before expiry` (from `local.plugin`) when a reply has not arrived by the
packet's expiry plus a 2-second grace, and `T00 plugin disconnected` for packets pending when
you disconnect.

## Limits and timing

- Round time: 3 s on the deployed configuration; a Prepare and its reply take two rounds each
  way, so a payment costs four rounds end to end, plus the time until the round that carries it.
- `minExpiryWindowMs` (8 s deployed): a Prepare must expire more than two windows after the
  consensus timestamp, and is forwarded with one window less. STREAM's 30-second default is fine.
- `maxPacketAmount`: 1 000 XAH by default and as deployed.
- `maxPendingPerPeer`: 500 packets in flight per peer.
- Probe credit: 0.01 XAH per peer, so receivers with no balance can answer rate probes.
- Peers that owe nothing, hold nothing and have been silent for `idlePeerRounds` (20 000 rounds
  ≈ 17 hours at 3 s) are forgotten; a channel bound to a peer keeps its record alive.
