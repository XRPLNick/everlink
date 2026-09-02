'use strict';

// The unchanged contract, run as a 3-node simulated HotPocket cluster against a mock
// Xahau ledger: claims in, packets routed, channels redeemed, peers paid out, hosts paid.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSimConnector } = require('../sim/cluster');
const { events } = require('../sim/hotpocket-sim');
const H = require('./helpers');

function collect(client) {
  const got = [];
  client.on(events.contractOutput, ({ outputs }) => { for (const o of outputs) got.push(JSON.parse(o)); });
  return got;
}
async function submit(client, msg) {
  const { submissionStatus } = await client.submitContractInput(typeof msg === 'string' ? msg : JSON.stringify(msg));
  return submissionStatus;
}
const find = (arr, pred) => arr.find(pred);
const sleepRounds = (cluster, n) => new Promise((resolve) => { let c = 0; const h = () => { if (++c >= n) { cluster.off('round', h); resolve(); } }; cluster.on('round', h); });

test('3-node cluster: claim, route, redeem, pay out, and keep the hosts paid', async (t) => {
  const sim = createSimConnector({
    nodeCount: 3, roundTimeMs: 30, factsEvery: 1,
    config: { feeBps: 100, minExpiryWindowMs: 500, redeemThresholdDrops: '2000000', payoutThresholdDrops: '1500000', reserveDrops: '20000000', evrReserve: '20', evrTopUpXahDrops: '2000000', evrTopUpMinEvr: '6' },
  });
  const { cluster, mock, master } = sim;
  t.after(() => cluster.stop());
  const errors = [];
  cluster.on('error', (e) => errors.push(e));

  // Alice opens a 5 XAH channel to the connector's multisig account.
  const aliceKeys = H.channelKeys();
  mock.fund(aliceKeys.address, 100_000_000n);
  const channel = mock.createChannel({ account: aliceKeys.address, destination: master, amount: 5_000_000n, publicKey: aliceKeys.publicKey });

  const alice = sim.peerClient(); const bob = sim.peerClient();
  await alice.connect(); await bob.connect();
  const aOut = collect(alice); const bOut = collect(bob);
  cluster.start();

  // Round with facts first so the channel is observed, then Alice's claim.
  await sleepRounds(cluster, 1);
  await submit(alice, H.claimInput(channel, 3_000_000, aliceKeys.privateKey));
  await sleepRounds(cluster, 2);
  const ack = find(aOut, (m) => m.t === 'claim_ack');
  assert.ok(ack && ack.ok, `claim accepted: ${JSON.stringify(ack)}`);
  assert.equal(ack.credited, '3000000');

  // Bob registers a payout address; Alice pays Bob 2 XAH through the connector.
  await submit(bob, { t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111' });
  const { fulfillment, condition } = H.condition();
  const dest = `${H.peerAddress(sim.config, bob.publicKey)}.invoice42`;
  await submit(alice, H.prepareInput('pay1', { amount: 2_000_000, destination: dest, expiresAt: Date.now() + 30_000, condition }));
  await sleepRounds(cluster, 2);
  const fwd = find(bOut, (m) => m.t === 'ilp');
  assert.ok(fwd, 'bob received the forwarded prepare');
  assert.equal(H.decodeOut(fwd).data.amount, '1980000');
  await submit(bob, H.fulfillInput(fwd.id, fulfillment));
  await sleepRounds(cluster, 2);
  const ful = find(aOut, (m) => m.t === 'ilp' && m.id === 'pay1');
  assert.ok(ful, 'alice got a reply');
  assert.equal(H.decodeOut(ful).type, 13);

  // Settlement: the channel is redeemed on-ledger (3 XAH >= 2 XAH threshold) and Bob is
  // paid out (1.98 XAH >= 1.5 XAH threshold), both by multisigned txs the mock validates.
  await sleepRounds(cluster, 4);
  const paid = find(bOut, (m) => m.t === 'payout' && m.status === 'validated');
  assert.ok(paid, `bob paid out: ${JSON.stringify(bOut.filter((m) => m.t === 'payout'))}`);
  assert.equal(paid.amt, '1980000');
  assert.equal(mock.balance('rBobPayoutAddress1111111111111111'), 1_980_000n);
  assert.equal(mock.channels.get(channel).balance, 3_000_000n, 'claim redeemed on ledger');

  // Read requests reflect the same state.
  const bal = JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'balance' })));
  assert.equal(bal.balance, '1000000');
  const info = JSON.parse(await bob.submitContractReadRequest(JSON.stringify({ t: 'info' })));
  assert.equal(info.ilpAddress, H.peerAddress(sim.config, bob.publicKey));

  // Hosting keeps itself paid: fast-forward the leases toward expiry and watch the
  // cluster pay each host in EVR; when EVR runs low the treasury buys more with XAH.
  for (const lease of mock.leases.values()) lease.expiresAt = Date.now() + lease.momentMs; // < 2 moments left
  await sleepRounds(cluster, 3);
  for (const lease of mock.leases.values()) assert.ok(lease.expiresAt > Date.now() + 4 * lease.momentMs, 'lease extended');
  const hostEvr = ['rHost0', 'rHost1', 'rHost2'].reduce((sum, h) => sum + mock.evr(h), 0);
  assert.equal(hostEvr, 3 * 4 * 2, 'paid 3 hosts x 4 moments x 2 EVR');
  // 30 - 24 = 6 EVR left < 20 reserve -> top-up offers (2 XAH at 0.25 XAH/EVR = 8 EVR each) until the reserve is met
  await sleepRounds(cluster, 6);
  assert.ok(mock.evr(master) >= 20, `EVR topped up: ${mock.evr(master)}`);
  assert.ok(mock.log.some((l) => l.type === 'OfferCreate' && l.resultCode === 'tesSUCCESS'));

  await cluster.stop();
  assert.deepEqual(errors, [], 'no consensus forks');
  assert.equal(cluster.forked, false);
});

test('a node with corrupted state is detected as a fork', async (t) => {
  const sim = createSimConnector({ nodeCount: 3, roundTimeMs: 20, leases: false });
  const { cluster } = sim;
  t.after(() => cluster.stop());
  const errors = [];
  cluster.on('error', (e) => errors.push(e));
  const alice = sim.peerClient(); await alice.connect();
  cluster.start();
  await sleepRounds(cluster, 2);
  // Tamper with node 2's state file between rounds.
  const fs = require('fs'); const path = require('path');
  const f = path.join(cluster.nodes[2].stateDir, 'connector-state.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.treasury.feesAccrued = '999999999';
  fs.writeFileSync(f, JSON.stringify(s));
  await submit(alice, { t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  await cluster.stop();
  assert.equal(cluster.forked, true);
  assert.match(errors[0].message, /diverged/);
});
