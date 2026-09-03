# Getting started: connect a peer and pay through the cluster

This walks through everything a peer does, in order, with runnable code. The finished script
is at the end; it is the same flow as `deploy/testnet/demo-testnet.js`, which is what ran on
Xahau mainnet.

## What you need

- Node.js 18 or newer.
- The plugin. It lives in this repository as the `plugin/` workspace (`ilp-plugin-hotpocket`);
  it is not on npm yet. Either work inside a clone —

  ```bash
  git clone https://github.com/XRPLNick/everlink
  cd everlink && npm install --ignore-scripts
  ```

  (`--ignore-scripts` because a transitive dependency, `blake3`, otherwise tries to download a
  native build) — or install the folder into your own project: `npm install /path/to/everlink/plugin`.
- `ilp-protocol-stream` (and `ilp-packet` if you build packets by hand) — both are already in
  the clone's `node_modules`.
- `xrpl` for the Xahau side (opening the payment channel, closing it) and `ripple-keypairs` for
  signing claims. Also in the clone.
- A cluster to talk to. A cluster is identified by its nodes' user endpoints,
  `wss://<host>:<userPort>`; a deployment writes them to `contract/dist/cluster.json`, and
  anyone running a cluster can hand you one or more of them. There is no permanent public
  cluster today (the mainnet run's lease was four hours), so you either run one
  ([deploy/README.md](../deploy/README.md)), run the local Docker cluster (`deploy/local/`), or
  develop against the in-process simulator (`sim/`, see the bottom of this page).
- A Xahau account with a few XAH for the payment channel, on the same network as the cluster.

## 1. Your identity

A peer is a HotPocket user, which is an ed25519 key pair. The connector keeps your balance
under the public key, so **keep the private key**: a new key is a new, empty account at the
connector, and credit left under an old key is unreachable.

```js
const HotPocket = require('hotpocket-js-client');
const fs = require('fs');

async function loadOrCreateKeys(file) {
  if (fs.existsSync(file)) return HotPocket.generateKeys(fs.readFileSync(file, 'utf8').trim());
  const keys = await HotPocket.generateKeys();
  fs.writeFileSync(file, Buffer.from(keys.privateKey).toString('hex'), { mode: 0o600 });
  return keys;
}
```

`generateKeys()` with no argument creates a fresh pair; with a hex private key it restores one.

## 2. Connect and look around

```js
const { HotPocketPlugin, hotPocketClientFactory } = require('./plugin/src'); // or 'ilp-plugin-hotpocket'

const plugin = new HotPocketPlugin({
  keys,
  servers: ['wss://evernode4.example.com:26231'],   // one or more nodes of the same cluster
  createClient: hotPocketClientFactory(),
  log: (...a) => console.log('[plugin]', ...a),        // optional
});
await plugin.connect();

const info = await plugin.getInfo();
console.log(info.ilpAddress);      // your ILP address: <prefix>.<your public key>
console.log(info.masterAddress);   // the cluster's Xahau account: open your channel TO this
console.log(info.feeBps, info.minExpiryWindowMs, info.payoutThresholdDrops);
```

`getInfo()` is a read request: it is answered by the node you are connected to from the
agreed state, without a consensus round, so it is fast (a second or two). Everything that
changes state — packets, claims, payout settings — goes through consensus and takes at least
one round (3 s on the mainnet configuration).

Connecting to a node you have never used before with a key the connector has never seen
creates your peer record on first input. Nothing needs to be registered in advance.

## 3. Fund your balance with a payment channel

The connector never lends: you can only send what you have prepaid. Prepaying means opening a
Xahau payment channel from your account **to** `info.masterAddress`, then handing the
connector a signed claim on it. The channel's `PublicKey` must be the key you will sign claims
with — using your account's own key, as below, is the simplest choice. `SettleDelay` must be
at least the connector's `minSettleDelaySec` (3600 s by default, 600 s on the mainnet
deployment; an hour is always safe): channels that could be closed faster are refused, because
an unredeemed claim on a closed channel would be a loss for everyone else.

```js
const xrpl = require('xrpl');

const client = new xrpl.Client('wss://xahau.network');   // Xahau mainnet
await client.connect();
const wallet = xrpl.Wallet.fromSeed(process.env.MY_SEED, { algorithm: 'ecdsa-secp256k1' });

const prepared = await client.autofill({
  TransactionType: 'PaymentChannelCreate',
  Account: wallet.classicAddress,
  Destination: info.masterAddress,
  Amount: xrpl.xrpToDrops('5'),        // 5 XAH locked in the channel
  SettleDelay: 3600,
  PublicKey: wallet.publicKey,
});
const result = await client.submitAndWait(wallet.sign(prepared).tx_blob);
const channelId = result.result.meta.AffectedNodes
  .map((n) => n.CreatedNode).find((n) => n && n.LedgerEntryType === 'PayChannel').LedgerIndex;
```

(xrpl.js 4 derives an ed25519 key from a seed unless told otherwise; pass the algorithm your
account actually uses.)

The cluster looks at the ledger every few rounds, so the channel is not visible to it for up to
about ten seconds. A claim sent before then is answered `channel not (yet) observed on ledger`;
just retry. A claim is the **cumulative** amount you are authorising the connector to draw from
the channel, in drops; each new claim must be larger than the last, and the difference is
what gets credited.

```js
let ack;
for (let i = 0; i < 12 && !(ack && ack.ok); i++) {
  if (i) await new Promise((r) => setTimeout(r, 10000));
  ack = await plugin.sendClaim({ channel: channelId, amount: 3_000_000, privateKey: wallet.privateKey });
  console.log('claim:', ack.ok ? `credited ${ack.credited} drops, balance ${ack.balance}` : ack.reason);
}
```

`sendClaim` signs the claim for you when given `privateKey`, or accepts a ready `signature`
(hex) if you sign elsewhere. After the ack, `plugin.getBalance()` shows `balance: '3000000'`.

## 4. Pay

Point `ilp-protocol-stream` at the plugin. Nothing about STREAM is Everlink-specific: the
library discovers your address with ILDCP, probes the rate with a few unfulfillable test
packets (they come back as rejects, by design) and then sends the money.

```js
const { createConnection } = require('ilp-protocol-stream');

// destinationAccount and sharedSecret come from the receiver (see step 5), out of band —
// exactly as with any other ILP payment (SPSP, a payment pointer, a QR code…).
const conn = await createConnection({ plugin, destinationAccount, sharedSecret, slippage: 0.02 });
const stream = conn.createStream();
stream.setSendMax('1000000');                          // 1 XAH, in drops
await new Promise((resolve, reject) => {
  stream.on('outgoing_money', () => { if (stream.totalSent === '1000000') resolve(); });
  stream.on('error', reject);
});
await conn.end();
```

One thing to know about `ilp-protocol-stream`: when a connection ends it **disconnects the
plugin** it was given (and `server.close()` does the same on the receiving side). Your balance
is untouched — it lives under your key at the connector — but to send a claim or withdraw
afterwards, call `plugin.connect()` again first. End the payer's connection before closing the
receiver's server; the other order leaves `conn.end()` waiting for a server that is gone.

Expect the handshake to take a few rounds and the payment itself two rounds per packet: on the
mainnet cluster (3-second rounds) the demo's handshake took 36 s and the 1 XAH payment 24 s.
STREAM's default 30-second packet expiry is fine as long as it exceeds twice the connector's
`minExpiryWindowMs` (8 s on mainnet); the connector rejects packets that expire sooner with
`R02`.

The receiver gets your amount minus the fee: `feeBps` basis points (0.25 % on the mainnet
configuration, 0.10 % by default) plus `feeFlat` drops (0 by default), rounded up per packet.

## 5. Receive

A receiver is the same plugin with a STREAM server on top. To be paid out on-ledger it also
needs a payout address; set it any time before the balance reaches the payout threshold.

```js
const { createServer } = require('ilp-protocol-stream');

const bob = new HotPocketPlugin({ keys: bobKeys, servers, createClient: hotPocketClientFactory() });
await bob.connect();
await bob.setPayoutAddress('rBobsXahauAddress...');      // optional destination tag as 2nd argument
bob.on('payout', (p) => console.log(`payout ${p.status}: ${p.amt} drops`, p.tx || p.reason || ''));

const server = await createServer({ plugin: bob });
server.on('connection', (conn) => conn.on('stream', (s) => {
  s.setReceiveMax('100000000');
  s.on('money', (amount) => console.log('received', amount, 'drops'));
}));
const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
// hand destinationAccount + sharedSecret to the payer
```

A receiver that has never funded anything can still answer STREAM's rate probes thanks to a
0.01 XAH probe credit the connector extends to every peer; it cannot send more than that
without a claim of its own.

## 6. Get paid out

The cluster pays you out with a multisigned Xahau Payment to your payout address when your
balance reaches `payoutThresholdDrops` (5 XAH by default; 0.5 XAH on the mainnet deployment),
or when you ask:

```js
if (!plugin.isConnected()) await plugin.connect();   // STREAM disconnected it when the connection ended
await plugin.withdraw();     // pays out the whole balance if it is at least minPayoutDrops
                             // (1 XAH by default, 0.1 XAH on the mainnet deployment)
```

The plugin emits `payout` events as the transaction is `submitted`, then `validated` (with
the transaction hash) — or `failed`, in which case the amount is back in your balance. Payouts
are only ever made from funds already on the ledger; if the cluster is still redeeming
channels, yours waits a few rounds ("waiting for redemptions" in the node's notes).

## 7. Close your channel

When you are done, ask Xahau to close the channel. Because the connector is the channel's
destination, it can close immediately (the `tfClose` flag from the destination side) and does
so in its next ledger-observing round, redeeming whatever you claimed first; your unclaimed
remainder returns to your account without waiting out the settle delay.

```js
const close = await client.autofill({
  TransactionType: 'PaymentChannelClaim', Account: wallet.classicAddress, Channel: channelId, Flags: 0x00020000,
});
await client.submitAndWait(wallet.sign(close).tx_blob);
```

Any credit you claimed but did not spend stays on your balance at the connector; `withdraw()`
gets it back on-ledger once it is at least `minPayoutDrops`.

## The whole thing

```js
'use strict';
const fs = require('fs');
const HotPocket = require('hotpocket-js-client');
const xrpl = require('xrpl');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { HotPocketPlugin, hotPocketClientFactory } = require('./plugin/src');

const SERVERS = ['wss://node1.example.com:26231', 'wss://node2.example.com:26203'];
const XAHAU = 'wss://xahau.network';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function keys(file) {
  if (fs.existsSync(file)) return HotPocket.generateKeys(fs.readFileSync(file, 'utf8').trim());
  const k = await HotPocket.generateKeys();
  fs.writeFileSync(file, Buffer.from(k.privateKey).toString('hex'), { mode: 0o600 });
  return k;
}

async function main() {
  const factory = hotPocketClientFactory();
  const alice = new HotPocketPlugin({ keys: await keys('alice.key'), servers: [SERVERS[0]], createClient: factory });
  const bob = new HotPocketPlugin({ keys: await keys('bob.key'), servers: [SERVERS[1 % SERVERS.length]], createClient: factory });
  await alice.connect(); await bob.connect();
  const info = await alice.getInfo();
  console.log('connector', info.connectorAddress, 'account', info.masterAddress, 'fee bps', info.feeBps);

  // Alice funds herself: a 5 XAH channel to the cluster account, a 3 XAH claim on it.
  const client = new xrpl.Client(XAHAU); await client.connect();
  const wallet = xrpl.Wallet.fromSeed(process.env.ALICE_SEED, { algorithm: 'ecdsa-secp256k1' });
  const open = await client.submitAndWait(wallet.sign(await client.autofill({
    TransactionType: 'PaymentChannelCreate', Account: wallet.classicAddress, Destination: info.masterAddress,
    Amount: '5000000', SettleDelay: 3600, PublicKey: wallet.publicKey,
  })).tx_blob);
  const channel = open.result.meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n && n.LedgerEntryType === 'PayChannel').LedgerIndex;
  let ack;
  for (let i = 0; i < 12 && !(ack && ack.ok); i++) {
    if (i) await sleep(10000);
    ack = await alice.sendClaim({ channel, amount: 3_000_000, privateKey: wallet.privateKey });
  }
  if (!ack.ok) throw new Error('claim not accepted: ' + ack.reason);
  console.log('Alice credit', (await alice.getBalance()).balance, 'drops');

  // Bob receives, and wants payouts on-ledger.
  await bob.setPayoutAddress(process.env.BOB_ADDRESS);
  bob.on('payout', (p) => console.log('Bob payout', p.status, p.amt, p.tx || p.reason || ''));
  const server = await createServer({ plugin: bob });
  server.on('connection', (c) => c.on('stream', (s) => { s.setReceiveMax('100000000'); s.on('money', (a) => console.log('Bob got', a)); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();

  // Alice pays Bob 1 XAH over STREAM.
  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  const stream = conn.createStream();
  stream.setSendMax('1000000');
  await new Promise((res, rej) => { stream.on('outgoing_money', () => { if (stream.totalSent === '1000000') res(); }); stream.on('error', rej); });
  console.log('paid', stream.totalSent, 'drops');
  await sleep(30000);                     // give the cluster time to report Bob's payout
  await conn.end();                       // disconnects alice's plugin (ilp-protocol-stream does that)
  await server.close();                   // disconnects bob's

  // Alice closes her channel; her unspent XAH come back on-ledger. Leftover credit can be withdrawn.
  await client.submitAndWait(wallet.sign(await client.autofill({
    TransactionType: 'PaymentChannelClaim', Account: wallet.classicAddress, Channel: channel, Flags: 0x00020000,
  })).tx_blob);
  await alice.connect();                  // same key, same balance
  alice.on('payout', (p) => console.log('Alice payout', p.status, p.amt, p.tx || p.reason || ''));
  await alice.setPayoutAddress(wallet.classicAddress);
  await alice.withdraw();                 // pays out if the leftover is >= minPayoutDrops
  await sleep(30000);
  await alice.disconnect(); await client.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## Developing without a cluster: the simulator

`sim/` runs N HotPocket nodes in-process against a mock Xahau (channels, multisig, DEX,
leases). Rounds take 25–50 ms, so a whole payment runs in under a second — good for tests. The
plugin is the same; only the client factory changes:

```js
const { createSimConnector } = require('./sim/cluster');
const { SimClient, edKeys } = require('./sim/hotpocket-sim');

const sim = createSimConnector({ nodeCount: 3, roundTimeMs: 25, config: { feeBps: 25, minExpiryWindowMs: 500 } });
sim.cluster.start();
const plugin = new HotPocketPlugin({ keys: edKeys(), servers: ['sim://cluster'], createClient: async ({ keys }) => new SimClient(sim.cluster, keys) });
// mock.fund / mock.createChannel stand in for the ledger; see test/e2e-stream.test.js for a full run
```

`npm run demo` narrates a complete simulated run, and `test/e2e-stream.test.js` and
`test/trace.test.js` are worked examples of exactly the flow above.
