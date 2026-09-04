# `ilp-plugin-hotpocket` API

The plugin in `plugin/` implements the interface that `ilp-protocol-stream` and the rest of the
Interledger.js tooling expect from an "ILP plugin" — `connect`, `disconnect`, `isConnected`,
`sendData`, `registerDataHandler` — on top of the HotPocket user channel, and adds the
settlement calls the connector's [peer protocol](peer-protocol.md) needs. It has no dependency
on the contract code.

```js
const { HotPocketPlugin, hotPocketClientFactory, signClaim } = require('ilp-plugin-hotpocket');
```

## `new HotPocketPlugin(options)`

| option | type | meaning |
|---|---|---|
| `keys` | `{ privateKey, publicKey }` | Your HotPocket key pair, as returned by `HotPocket.generateKeys()` from `hotpocket-js-client`. This is your identity at the connector; keep the private key. |
| `servers` | `string[]` | Node user endpoints of one cluster, `wss://host:port`. One is enough; more gives the client alternatives to reconnect to. |
| `createClient` | `async ({ servers, keys, contractId, requiredConnectionCount }) => client` | Factory for the HotPocket client. Use `hotPocketClientFactory()` for real nodes; the simulator supplies its own (`new SimClient(cluster, keys)`). Required. |
| `contractId` | `string \| null` | Optional: refuse to talk to a node running a different contract id. |
| `requiredConnectionCount` | `number` | How many of `servers` the client must be connected to (default 1). |
| `log` | `(...args) => void` | Optional diagnostics sink (connection changes, undecodable outputs, connector `err` messages). Silent by default. |

The instance is an `EventEmitter`. `plugin.publicKey` is your identity as a hex string.

## The ilp-plugin interface

### `await plugin.connect()`

Creates the HotPocket client and connects. Resolves once at least `requiredConnectionCount`
nodes are connected; rejects if the client cannot connect at all. Emits `connect`. Calling it
while connected is a no-op.

### `await plugin.disconnect()`

Rejects all of your pending Prepares locally with `T00 plugin disconnected`, waits up to 3 s
for replies your data handler is still producing to go out, closes the client and emits
`disconnect`. Any balance you hold at the connector is unaffected — it is tied to your key, not
to the connection — but Prepares addressed to you while you are away are rejected by the
connector with `T01`.

### `plugin.isConnected()`

`true` between a successful `connect()` and `disconnect()`.

### `await plugin.sendData(buffer) → Buffer`

Sends one ILP Prepare (a serialized packet from `ilp-packet` or produced by STREAM) to the
connector and resolves with the serialized reply — a Fulfill or a Reject. If no reply has
arrived by the packet's own `expiresAt` plus a 2-second grace, resolves with a locally built
`R00 no reply from connector before expiry` (`triggeredBy: local.plugin`). Throws if the buffer
is not a Prepare or the plugin is not connected.

The plugin chooses a random 16-hex id per packet and matches the reply on it, so any number of
Prepares can be in flight. If the HotPocket client is between connections, submission is
retried every 500 ms for up to 10 s before failing with `no connection to the connector
cluster`.

### `plugin.registerDataHandler(handler)` / `plugin.deregisterDataHandler()`

`handler: async (prepareBuffer) => replyBuffer`. Called for every Prepare the connector
forwards to you; whatever it returns (a serialized Fulfill or Reject) is sent back under the
same id. If it throws, the connector gets `F00` with the error message; if no handler is
registered, `F02 no data handler registered`. STREAM's `createServer({ plugin })` registers the
handler for you. Only one handler at a time (registering a second throws).

### `registerMoneyHandler` / `deregisterMoneyHandler` / `sendMoney`

Present for interface compatibility, do nothing. Settlement is explicit (below), not a side
channel of packets.

## Settlement calls

### `await plugin.sendClaim({ channel, amount, privateKey | signature }) → claim_ack`

Funds your balance with a Xahau payment-channel claim.

- `channel`: the 64-hex channel id of a channel from your account **to** the connector's
  account (`info.masterAddress`).
- `amount`: the **cumulative** amount authorised, in drops (number or string). Each claim must
  exceed the previous one; the difference is credited.
- `privateKey`: hex private key of the channel's `PublicKey` — the plugin signs for you with
  `signClaim` — or `signature`: a ready hex signature if you sign elsewhere (hardware key,
  another process).

Resolves with the connector's answer: `{ ok: true, credited, balance }` or
`{ ok: false, reason, … }` (reasons in [peer-protocol.md](peer-protocol.md#claim--fund-your-balance)).
The promise resolves when the ack arrives, typically one round after submission; there is no
timeout, so wrap it if the cluster might be unreachable. Also emitted as a `claim_ack` event.

### `await plugin.setPayoutAddress(address, tag = null)`

Tells the connector where to send your payouts: a Xahau classic address and an optional
destination tag. Resolves when the input is accepted by the node (not when the round has run);
the connector's `ack` arrives as an `ack` event.

### `await plugin.withdraw()`

Asks for your whole balance to be paid out now (if it is at least the connector's
`minPayoutDrops` and it has the funds on-ledger). Same resolution semantics as
`setPayoutAddress`. Progress arrives as `payout` events.

### `await plugin.getInfo()` / `await plugin.getBalance()`

Read requests, answered by the connected node without a consensus round. `getInfo()` returns
your ILP address, the connector's prefix and account, fees, limits and counters; `getBalance()`
returns `{ balance, held, payoutAddress, pendingPayout }`. Field lists are in
[peer-protocol.md](peer-protocol.md#read-requests-peer--node-answered-immediately). Amounts are
strings of drops.

## Events

| event | payload | when |
|---|---|---|
| `connect` / `disconnect` | — | Connection state changed by your own calls. |
| `payout` | `{ status: 'submitted' \| 'validated' \| 'failed', amt, tx?, reason?, retryAfterRounds?, lastWill? }` | The connector reports on a payout to you. `lastWill: true` marks a payout made by the connector's last will. |
| `claim_ack` | `{ ch, amt, ok, credited?, balance?, reason?, … }` | Result of a claim (also resolves the `sendClaim` promise). |
| `last_will` | `{ active, deadline, balance?, payoutTo?, payoutSource?, hint? }` | The connector is winding down (`active: true`: its hosting ends at `deadline` and your balance is being paid to `payoutTo`) or has recovered (`active: false`). See [money.md](money.md#if-the-cluster-dies-the-last-will). |
| `ack` | `{ of: 'settle_to' \| 'withdraw', … }` | A setting was applied. |
| `connector_error` | `{ reason, ref? }` | The connector answered one of your inputs with `err` (also passed to `log`). |
| `message` | any other output | Forward-compatibility hook. |

## Helpers

### `hotPocketClientFactory()`

Returns the `createClient` function for real nodes: `HotPocket.createClient(servers, keys,
{ contractId, requiredConnectionCount })` from `hotpocket-js-client`.

### `signClaim({ channel, amount, privateKey }) → hex signature`

Signs a payment-channel claim (`ripple-binary-codec` `encodeForSigningClaim` + `ripple-keypairs`
`sign`). Exposed so a payer can pre-sign claims offline and hand them to a process that only
holds the HotPocket key.

## Behaviour worth knowing

- **Two rounds per hop.** A `sendData` round trip through the cluster takes at least two
  consensus rounds (Prepare in one, the reply in a later one) — about 6–12 s on the deployed
  3-second rounds, 24 s observed for the money packet when a ledger-observing round sits in
  between. STREAM's 30-second packet expiry accommodates this; do not shorten it.
- **STREAM disconnects the plugin.** `ilp-protocol-stream` calls `plugin.disconnect()` when a
  client connection closes (`conn.end()`, or the remote closing) and when `server.close()`
  runs. Your balance is unaffected; call `connect()` again before further claims, withdrawals
  or read requests. End the payer's connection before closing the receiver's server.
- **Reconnects are the client's job.** `hotpocket-js-client` reconnects on its own; the plugin
  logs connection changes and holds submissions briefly while that happens. A `disconnect` event
  from the plugin only ever follows your own `disconnect()` call.
- **Outputs arrive already parsed.** Real HotPocket nodes deliver contract outputs as objects,
  the simulator as strings; the plugin accepts both.
- **Identity is money.** Whatever the connector owes you sits under `plugin.publicKey`. Persist
  the key; a peer that reconnects with a new key starts from zero and the old credit is
  unreachable.
