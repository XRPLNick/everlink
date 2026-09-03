'use strict';

// The packet tracer (deploy/testnet/trace-lib.js) on the simulated cluster: it must see the
// sender's Prepares and the forwarded ones, decrypt the STREAM frames with the receiver's
// secret, verify every fulfillment against its condition, and account for the fee exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { createSimConnector } = require('../sim/cluster');
const { SimClient, edKeys } = require('../sim/hotpocket-sim');
const { HotPocketPlugin } = require('../plugin/src');
const { Tracer } = require('../deploy/testnet/trace-lib');
const H = require('./helpers');

function simPlugin(sim, keys) {
  return new HotPocketPlugin({ keys, servers: ['sim://cluster'], createClient: async ({ keys: k }) => new SimClient(sim.cluster, k) });
}
const sleepRounds = (cluster, n) => new Promise((resolve) => { let c = 0; const h = () => { if (++c >= n) { cluster.off('round', h); resolve(); } }; cluster.on('round', h); });

test('packet tracer records, decrypts and verifies a STREAM payment through the cluster', async (t) => {
  const sim = createSimConnector({ nodeCount: 3, roundTimeMs: 25, config: { feeBps: 25, minExpiryWindowMs: 500, payoutThresholdDrops: '500000', reserveDrops: '20000000' } });
  const { cluster, mock, master } = sim;
  t.after(() => cluster.stop());
  cluster.on('error', (e) => { throw e; });
  cluster.start();

  const tracer = new Tracer();
  const aliceXahau = H.channelKeys();
  mock.fund(aliceXahau.address, 100_000_000n);
  const channel = mock.createChannel({ account: aliceXahau.address, destination: master, amount: 2_000_000n, publicKey: aliceXahau.publicKey });
  const alice = tracer.wrap(simPlugin(sim, edKeys()), 'alice');
  await alice.connect();
  await sleepRounds(cluster, 2);
  const ack = await alice.sendClaim({ channel, amount: 1_000_000, privateKey: aliceXahau.privateKey });
  assert.equal(ack.ok, true, JSON.stringify(ack));

  const bob = tracer.wrap(simPlugin(sim, edKeys()), 'bob');
  const server = await createServer({ plugin: bob });
  let received = 0n;
  server.on('connection', (conn) => conn.on('stream', (s) => { s.setReceiveMax('10000000'); s.on('money', (a) => { received += BigInt(a); }); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  await tracer.useSharedSecret(sharedSecret);

  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  const stream = conn.createStream();
  stream.setSendMax('1000000');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stalled: sent ${stream.totalSent}`)), 20000);
    stream.on('outgoing_money', () => { if (stream.totalSent === '1000000') { clearTimeout(timer); resolve(); } });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  await server.close();
  await conn.end();
  await new Promise((r) => setTimeout(r, 300));

  const entries = await tracer.analyse();
  const s = tracer.summary();
  const text = tracer.render();
  const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (process.env.TRACE_DEBUG) console.log(text);
  // Both legs were seen, money moved, and the fee is exactly the difference between them.
  assert.ok(s.sentIn >= 2 && s.forwarded >= 1, J(s));
  assert.ok(s.fulfilled >= 1 && s.rejected >= 1, J(s)); // rate probes are rejected by design
  assert.equal(s.senderFulfilledDrops, 1_000_000n);
  assert.equal(s.receiverFulfilledDrops, received);
  assert.ok(s.senderFulfilledDrops - s.receiverFulfilledDrops >= 2_500n, `fee ${s.senderFulfilledDrops - s.receiverFulfilledDrops}`);
  assert.equal(s.allFulfillmentsValid, true);
  // Forwarded Prepares carry Bob's address and less money than Alice sent (the spread).
  const fwd = entries.filter((e) => e.side === 'bob' && e.direction === 'in' && e.reply.type === 'FULFILL');
  assert.ok(fwd.length >= 1);
  for (const e of fwd) assert.ok(e.prepare.destination.startsWith(H.peerAddress(sim.config, bob.publicKey)), e.prepare.destination);
  // ILDCP was answered by the connector with Alice's address.
  const ildcp = entries.find((e) => e.side === 'alice' && e.ildcp);
  assert.ok(ildcp && ildcp.ildcp.clientAddress === H.peerAddress(sim.config, alice.publicKey) && ildcp.ildcp.assetCode === 'XAH', JSON.stringify(ildcp && ildcp.ildcp));
  // STREAM frames decrypted: the connection setup names Alice's address, money moves in StreamMoney frames.
  const frames = entries.flatMap((e) => [...((e.stream && e.stream.frames) || []), ...((e.replyStream && e.replyStream.frames) || [])]);
  assert.ok(frames.some((f) => f.frame === 'ConnectionNewAddress' && f.sourceAccount.startsWith(H.peerAddress(sim.config, alice.publicKey))), JSON.stringify(frames.slice(0, 5)));
  assert.ok(frames.some((f) => f.frame === 'StreamMoney'), 'no StreamMoney frame');
  assert.ok(frames.some((f) => f.frame === 'ConnectionAssetDetails' && f.sourceAssetCode === 'XAH'), 'no asset details');
  assert.ok(entries.every((e) => !e.stream || !e.stream.undecryptable), 'a STREAM packet did not decrypt');
  assert.ok(entries.every((e) => !e.replyStream || !e.replyStream.undecryptable), 'a STREAM reply did not decrypt');
  assert.match(text, /FULFILL {2}fulfillment [0-9a-f]{64} {2}sha256 == condition: yes/);
  assert.match(text, /StreamMoney\(/);
  await alice.disconnect(); await bob.disconnect();
});
