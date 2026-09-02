'use strict';

// End to end: the unmodified `ilp-protocol-stream` library pays from Alice to Bob through
// the simulated 3-node connector cluster, using ilp-plugin-hotpocket on both sides.
// Alice funds herself with a payment-channel claim first; Bob gets paid out on-ledger.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { createSimConnector } = require('../sim/cluster');
const { SimClient, edKeys } = require('../sim/hotpocket-sim');
const { HotPocketPlugin } = require('../plugin/src');
const H = require('./helpers');

function simPlugin(sim, keys) {
  return new HotPocketPlugin({
    keys, servers: ['sim://cluster'],
    createClient: async ({ keys: k }) => new SimClient(sim.cluster, k),
  });
}
const sleepRounds = (cluster, n) => new Promise((resolve) => { let c = 0; const h = () => { if (++c >= n) { cluster.off('round', h); resolve(); } }; cluster.on('round', h); });

test('STREAM payment Alice -> connector cluster -> Bob, with settlement on both ends', async (t) => {
  const sim = createSimConnector({
    nodeCount: 3, roundTimeMs: 25,
    config: { feeBps: 50, minExpiryWindowMs: 500, redeemThresholdDrops: '3000000', payoutThresholdDrops: '500000', reserveDrops: '20000000' },
  });
  const { cluster, mock, master } = sim;
  t.after(() => cluster.stop());
  cluster.on('error', (e) => { throw e; });
  cluster.start();

  // Alice: 4 XAH channel to the connector, claim 3 XAH of it.
  const aliceKeys = edKeys(); const aliceXahau = H.channelKeys();
  mock.fund(aliceXahau.address, 100_000_000n);
  const channel = mock.createChannel({ account: aliceXahau.address, destination: master, amount: 4_000_000n, publicKey: aliceXahau.publicKey });
  const alicePlugin = simPlugin(sim, aliceKeys);
  await alicePlugin.connect();
  await sleepRounds(cluster, 2); // let the cluster observe the channel
  const ack = await alicePlugin.sendClaim({ channel, amount: 3_000_000, privateKey: aliceXahau.privateKey });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal((await alicePlugin.getBalance()).balance, '3000000');

  // Bob: STREAM server behind his plugin; payouts go to his Xahau address.
  const bobPlugin = simPlugin(sim, edKeys());
  const payouts = [];
  bobPlugin.on('payout', (p) => payouts.push(p));
  const server = await createServer({ plugin: bobPlugin });
  await bobPlugin.setPayoutAddress('rBobPayoutAddress1111111111111111');
  const received = { total: 0n };
  server.on('connection', (conn) => {
    conn.on('stream', (stream) => {
      stream.setReceiveMax('10000000');
      stream.on('money', (amt) => { received.total += BigInt(amt); });
    });
  });
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  assert.ok(destinationAccount.startsWith(H.peerAddress(sim.config, bobPlugin.publicKey)), destinationAccount);

  // Alice pays 2 XAH.
  const conn = await createConnection({ plugin: alicePlugin, destinationAccount, sharedSecret, slippage: 0.02 });
  const stream = conn.createStream();
  stream.setSendMax('2000000');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stream stalled: sent ${stream.totalSent}`)), 20000);
    stream.on('outgoing_money', () => { if (stream.totalSent === '2000000') { clearTimeout(timer); resolve(); } });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  await conn.end();

  assert.equal(stream.totalSent, '2000000');
  // 0.5% fee per packet, rounded up per packet -> Bob receives a hair under 1.99 XAH.
  assert.ok(received.total >= 1_985_000n && received.total <= 1_990_000n, `bob received ${received.total}`);
  const aliceBal = await alicePlugin.getBalance();
  assert.equal(aliceBal.held, '0');
  assert.equal(BigInt(aliceBal.balance), 3_000_000n - 2_000_000n);

  // Settlement: Bob is paid out on-ledger (balance >= 0.5 XAH threshold), Alice's channel redeemed (3 XAH >= threshold).
  await sleepRounds(cluster, 6);
  const validated = payouts.find((p) => p.status === 'validated');
  assert.ok(validated, JSON.stringify(payouts));
  // Everything Bob received is either paid out on-ledger or still credited at the connector
  // (his own rate probes may have been in flight when the payout was planned).
  const bobBal = await bobPlugin.getBalance();
  assert.equal(mock.balance('rBobPayoutAddress1111111111111111') + BigInt(bobBal.balance), received.total);
  assert.equal(bobBal.held, '0');
  assert.equal(mock.channels.get(channel).balance, 3_000_000n);
  assert.equal(cluster.forked, false);
  await server.close();
  await alicePlugin.disconnect();
  await bobPlugin.disconnect();
});
