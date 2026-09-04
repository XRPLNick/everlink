# Troubleshooting

What you will see, what it means, what to do. Messages are quoted as the plugin surfaces them
(ILP reject code and message, `claim_ack.reason`, or `err.reason`).

## Connecting

**`could not connect to the connector cluster`** — none of the `servers` accepted a WebSocket.
Check the endpoint is a *user* port (`wss://host:userPort`, from `cluster.json`), that the lease
has not expired (an Evernode instance disappears with its lease; the mainnet demo cluster lived
four hours), and that nothing between you and the host blocks the port. Hosts that are up on the
ledger but unreachable on their instance ports exist; the Evernode kit's `hosts.js` probes for
exactly that before leasing.

**`submit: client had no connection, waiting for it to reconnect`** (in your `log`) — the
client is between connections; submissions are retried for up to 10 s. Harmless if it clears;
if it repeats, the node is flapping — connect to another node of the same cluster.

**Read requests hang or time out** — the node is up but the contract is not answering read
requests, which happens when the cluster is not closing ledgers (consensus stalled, or the
contract is stuck in a round). Ask the operator to run the status check
(`run-mainnet-status.cmd`), which shows each node's ledger height and the contract's
diagnostics.

## Funding

**`channel not (yet) observed on ledger`** — the cluster observes the ledger every `factsEvery`
rounds (every 9 s as deployed); your channel was created after its last look. Retry for up to
a minute. If it never clears: the channel's `Destination` must be exactly the connector's
`masterAddress` (from `getInfo()`), on the same network the cluster watches.

**`bad signature`** — the claim was signed with a key other than the channel's `PublicKey`, or
over the wrong data. `sendClaim` signs correctly when given the private key that matches the
channel's public key; if you sign elsewhere, the signing data is `encodeForSigningClaim({ channel,
amount })` from `ripple-binary-codec`, amount as a string of drops.

**`claim amount must exceed previous claim`** — claims are cumulative. Read
`getBalance()`/`channels` or the `last` field in the ack and claim more than that.

**`claim exceeds channel funding`** — you asked for more than the channel holds. Fund the
channel further with `PaymentChannelFund` first.

**`settle delay too short`** — recreate the channel with `SettleDelay ≥ minSettleDelaySec`
(returned in the ack; 3600 by default).

**`channel is bound to another peer`** — someone (perhaps you, under a different HotPocket key)
already claimed on this channel. Use that key, or open a new channel.

**The claim was accepted but `getBalance()` still shows `0`** — you connected `getBalance()`
with a different plugin/key than the one that sent the claim. Balances hang off the HotPocket
key, not the Xahau account.

## Paying

**`T04 insufficient prepaid balance; send a payment-channel claim`** — the packet amount exceeds
your balance plus the 0.01 XAH probe credit. Expected for STREAM's large rate probes (10⁹
drops) — the library takes it in stride; for real packets, claim more.

**`F08 packet exceeds maximum amount`** — above `maxPacketAmount` (1 000 XAH). Also expected for
STREAM's largest probe (10¹² drops); STREAM reads the limit from the reject and sizes its
packets accordingly.

**`R02 insufficient timeout`** — the Prepare expires less than two `minExpiryWindowMs` after the
consensus timestamp (16 s as deployed). Use expiries of 30 s or more (STREAM's default), and
make sure your clock is roughly right: expiry is judged against the cluster's agreed time.

**`R00 transfer timed out`** (from the connector) — the destination never answered before the
outgoing expiry. Usually the receiver's data handler was slow or its connection dropped; nothing
was charged.

**`R00 no reply from connector before expiry`** (from `local.plugin`) — the plugin gave up
waiting for the cluster's reply. The round carrying your packet did not complete in time —
the cluster is slow or stalled. Nothing was charged; check the cluster's status.

**`T01 peer is not connected` / `T01 peer disconnected`** — the destination peer has no live
connection to the cluster. The receiver must stay connected while being paid.

**`F02 destination not reachable through this connector` / `unknown peer`** — the destination
address does not start with the connector's prefix, or names a public key the connector has
never seen. A receiver becomes known on its first input (a STREAM server sends an ILDCP request
on start-up, which is enough).

**`F99` rejects with no message, in bursts** — STREAM's exchange-rate probes, answered by the
receiving library on purpose (its conditions are deliberately unfulfillable). Not an error.

**`T99 Shutting down server`** — the receiver's STREAM server was closed while packets were in
flight. Normal at the end of a payment.

**A payment of `N` delivered less than `N`** — the connector's fee (`feeBps`, rounded up per
packet, plus `feeFlat`); STREAM's `slippage` setting must allow for it (0.02 is ample).

**Everything takes ~10–30 s** — by design: two consensus rounds per hop at 3 s per round, and a
round that also observes the ledger takes a second longer. Throughput comes from many packets per
round, not from per-packet latency.

## Getting paid out

**No payout although the balance is above the threshold** — set a payout address
(`setPayoutAddress`); without one nothing is planned. Then check `getBalance().pendingPayout`.

**`err: set a payout address first (settle_to)`** on `withdraw` — same fix.

**`withdraw()` acknowledged but nothing happens** — the balance is below `minPayoutDrops`, or
the account has no free funds on the ledger yet ("payout … deferred: waiting for redemptions"
in the node's notes); the payout is planned as soon as a redemption lands. Wait a few rounds.

**`payout failed` with a `tec…` or `tem…` code** — the Xahau transaction was rejected (for
example an unfunded destination below reserve, `tecNO_DST_INSUF_XRP`); the amount is back in
your balance. The connector waits before trying again (`retryAfterRounds`: 20 rounds, doubling
per failure); `setPayoutAddress` with a different address clears the wait. Fix the destination and
`withdraw()` again. `reason: submission lost` means the round that planned it died before the
transaction went out; nothing was sent, the balance is back, and it is planned again at once (no
backoff).

**`F02 connector is winding down` / `claim_ack … connector is winding down` / a `last_will`
event** — the cluster's hosting is about to lapse and it could not extend it, so it is executing
its [last will](money.md#if-the-cluster-dies-the-last-will): no new packets or claims, every
balance paid out. Yours goes to your payout address, or to the account that owns the channel you
funded from; if you have neither, set a payout address now — it is honoured within a round for
as long as the cluster can still sign. `getInfo()` shows `winding`, the `lease` deadline and, once
it is over, `winding: false`.

**`plugin is disconnected` / `plugin not connected` right after a payment** — `ilp-protocol-stream`
disconnects the plugin when the connection ends (`conn.end()`) or the server closes. Call
`plugin.connect()` again; nothing was lost.

**`conn.end()` never resolves** — the receiver's server was closed first, so the close handshake
has nobody to answer it. End the connection before closing the server.

## Identity and keys

**"My balance vanished"** — you are connecting with a different HotPocket key. Balances are
keyed by the ed25519 public key; a regenerated key is a new, empty peer. Restore the old key
(`HotPocket.generateKeys(hexPrivateKey)`) and the balance is where you left it. There is no
recovery without the key.

## For operators

The contract keeps per-node diagnostics outside consensus state and answers a read request
`{"t":"diag","probe":true,"layers":true}` with the last rounds' timings and phases, crash
traces, a DNS/TCP/TLS/WebSocket/xrpl/evernode connectivity probe run in a child process, the
node's process and directory information and its `patch.cfg`. `deploy/testnet/status.js`
(`run-mainnet-status.cmd`) collects it from every node; `deploy/local/diag-local.js` does the
same for the local cluster. Common findings, from the seven deployments that failed before the
one that worked, are written up in [deploy/testnet/README.md](../deploy/testnet/README.md).
