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
// Wait until `pred()` holds, checking after every round, for at most `maxRounds` rounds.
const waitFor = (cluster, pred, maxRounds) => new Promise((resolve, reject) => {
  let c = 0;
  const h = () => { if (pred()) { cluster.off('round', h); resolve(c); } else if (++c >= maxRounds) { cluster.off('round', h); reject(new Error(`not within ${maxRounds} rounds`)); } };
  cluster.on('round', h);
});

test('3-node cluster: claim, route, redeem, pay out, and keep the hosts paid', async (t) => {
  const sim = createSimConnector({
    nodeCount: 3, roundTimeMs: 30, factsEvery: 1,
    config: { feeBps: 100, minExpiryWindowMs: 500, redeemThresholdDrops: '2000000', payoutThresholdDrops: '1500000', reserveDrops: '20000000', evrReserve: '20', evrTopUpXahDrops: '2000000', evrTopUpMinEvr: '6', leaseExtendMoments: 4 },
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

  // Hosting keeps itself paid: fast-forward the leases toward expiry and watch the cluster
  // renew them — one per round, the most urgent first — paying each host in EVR; when EVR
  // runs low the treasury buys more with XAH.
  for (const lease of mock.leases.values()) lease.expiresAt = Date.now() + lease.momentMs; // < 2 moments left
  await waitFor(cluster, () => [...mock.leases.values()].every((l) => l.expiresAt > Date.now() + 4 * l.momentMs), 12);
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

test('3-node cluster: when the hosts can no longer be paid, the last will pays everyone out; a rescue reverses it', async (t) => {
  const sim = createSimConnector({
    nodeCount: 3, roundTimeMs: 30, factsEvery: 1,
    // evrReserve 0: the treasury never buys EVR, so nothing but our own hand can rescue the hosting.
    config: { feeBps: 100, minExpiryWindowMs: 500, redeemThresholdDrops: '2000000', payoutThresholdDrops: '1500000', reserveDrops: '20000000', evrReserve: '0', lastWillGraceRounds: 5, leaseExtendMoments: 4 },
  });
  const { cluster, mock, master } = sim;
  t.after(() => cluster.stop());
  const errors = [];
  cluster.on('error', (e) => errors.push(e));

  const aliceKeys = H.channelKeys();
  mock.fund(aliceKeys.address, 100_000_000n);
  const channel = mock.createChannel({ account: aliceKeys.address, destination: master, amount: 5_000_000n, publicKey: aliceKeys.publicKey });
  const alice = sim.peerClient(); const bob = sim.peerClient();
  await alice.connect(); await bob.connect();
  const aOut = collect(alice); const bOut = collect(bob);
  cluster.start();

  // Alice claims 3 XAH (redeemed on-ledger: above the 2 XAH threshold) and pays Bob 1 XAH; Bob's
  // 0.99 XAH stays below his payout threshold. Alice never registers a payout address.
  await sleepRounds(cluster, 1);
  await submit(alice, H.claimInput(channel, 3_000_000, aliceKeys.privateKey));
  await submit(bob, { t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111' });
  await sleepRounds(cluster, 2);
  const { fulfillment, condition } = H.condition();
  await submit(alice, H.prepareInput('pay1', { amount: 1_000_000, destination: H.peerAddress(sim.config, bob.publicKey), expiresAt: Date.now() + 30_000, condition }));
  await sleepRounds(cluster, 2);
  await submit(bob, H.fulfillInput(find(bOut, (m) => m.t === 'ilp').id, fulfillment));
  await sleepRounds(cluster, 4);
  assert.equal(mock.channels.get(channel).balance, 3_000_000n, 'claim redeemed');
  assert.equal(JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'balance' }))).balance, '2000000');
  assert.equal(mock.balance('rBobPayoutAddress1111111111111111'), 0n, 'below the payout threshold');

  // The account's EVR is gone and the hosts' leases are inside the last half hour: every attempt
  // to extend them fails, so the cluster executes its last will while it can still sign.
  mock.acct(master).evr = 0;
  for (const lease of mock.leases.values()) lease.expiresAt = Date.now() + 20 * 60_000;
  await sleepRounds(cluster, 6);
  const info = JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'info' })));
  assert.equal(info.winding, true, JSON.stringify(info.lease));
  assert.ok(!mock.log.some((l) => l.type === 'Payment' && l.resultCode === 'tecPATH_PARTIAL'), 'no renewal was even attempted: the core knows it cannot pay for a moment');
  const noticeA = find(aOut, (m) => m.t === 'last_will' && m.active);
  assert.ok(noticeA, 'alice was told');
  assert.equal(noticeA.payoutTo, aliceKeys.address, 'no payout address: back to the account that funded her channel');
  assert.equal(noticeA.payoutSource, 'channel');
  assert.equal(mock.balance(aliceKeys.address), 100_000_000n - 5_000_000n + 2_000_000n, 'alice got her 2 XAH back');
  assert.equal(mock.balance('rBobPayoutAddress1111111111111111'), 990_000n, 'bob got his 0.99 XAH although it was below the threshold');
  const bobPaid = find(bOut, (m) => m.t === 'payout' && m.status === 'validated');
  assert.equal(bobPaid.lastWill, true);
  // No new money is taken while winding down.
  await submit(alice, H.claimInput(channel, 3_500_000, aliceKeys.privateKey));
  await sleepRounds(cluster, 2);
  assert.equal(find(aOut, (m) => m.t === 'claim_ack' && m.amt === '3500000').reason, 'connector is winding down');

  // A rescue: EVR arrives, the renewals go through, and normal service resumes.
  mock.fundEvr(master, 30);
  await waitFor(cluster, () => [...mock.leases.values()].every((l) => l.expiresAt > Date.now() + 3 * l.momentMs), 400);
  await waitFor(cluster, () => find(aOut, (m) => m.t === 'last_will' && m.active === false), 20);
  assert.equal(JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'info' }))).winding, false);
  await submit(alice, H.claimInput(channel, 3_500_000, aliceKeys.privateKey));
  await sleepRounds(cluster, 2);
  assert.equal(find(aOut, (m) => m.t === 'claim_ack' && m.amt === '3500000' && m.ok).credited, '500000');

  await cluster.stop();
  assert.deepEqual(errors, [], 'no consensus forks');
  assert.equal(cluster.forked, false);
});

test('3-node cluster: a host that will not take the payment does not stop the other two from being renewed', async (t) => {
  const sim = createSimConnector({ nodeCount: 3, roundTimeMs: 30, factsEvery: 1, config: { leaseExtendMoments: 4, lastWillGraceRounds: 5 } });
  const { cluster, mock } = sim;
  t.after(() => cluster.stop());
  const errors = [];
  cluster.on('error', (e) => errors.push(e));
  const alice = sim.peerClient(); await alice.connect();
  const [n0, n1, n2] = cluster.nodes.map((n) => n.publicKey);
  cluster.start();
  await sleepRounds(cluster, 2);

  // All three leases inside the renewal window, the middle host refusing every payment. Under
  // everpocket's serial queue the refusing host would have blocked the nodes behind it for good;
  // here the two others are renewed within a few rounds and the refusing one is retried on its
  // own backoff. The most urgent node (n2, expiring first) goes first.
  mock.leases.get(n0).expiresAt = Date.now() + 90 * 60_000;
  mock.leases.get(n1).expiresAt = Date.now() + 60 * 60_000; mock.leases.get(n1).refuse = true;
  mock.leases.get(n2).expiresAt = Date.now() + 45 * 60_000;
  await waitFor(cluster, () => mock.leases.get(n0).expiresAt > Date.now() + 4 * 3600_000 && mock.leases.get(n2).expiresAt > Date.now() + 4 * 3600_000, 12);
  await sleepRounds(cluster, 2); // the lease fact follows the ledger by an observation
  const order = mock.log.filter((l) => l.type === 'Payment').map((l) => l.resultCode);
  assert.equal(order[0], 'tesSUCCESS', `most urgent first: ${JSON.stringify(mock.log)}`);
  assert.ok(mock.log.some((l) => l.lease === n1 && l.resultCode === 'tecHOOK_REJECTED'), 'the refusing host was tried');
  assert.ok(mock.leases.get(n1).expiresAt < Date.now() + 2 * 3600_000, 'and not renewed');
  let info = JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'info' })));
  assert.ok(info.leases[n1].attempts >= 1 && info.leases[n1].backoffUntilLcl > cluster.lclSeqNo, JSON.stringify(info.leases));
  assert.ok(!info.leases[n0].attempts && !info.leases[n2].attempts, 'the others succeeded first time');
  // The signer quorum (2 of 3) is safe, so no last will: its deadline is the second-latest expiry.
  assert.equal(info.winding, false);
  assert.ok(info.lease.deadlineMs > Date.now() + 4 * 3600_000, JSON.stringify(info.lease));
  // The host relents: the next attempt after the backoff succeeds and the attempt count resets.
  mock.leases.get(n1).refuse = false;
  await waitFor(cluster, () => mock.leases.get(n1).expiresAt > Date.now() + 4 * 3600_000, 300);
  info = JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'info' })));
  assert.equal(info.leases[n1].attempts, 0);
  assert.ok(info.leases[n1].extendedLcl > 0);

  await cluster.stop();
  assert.deepEqual(errors, [], 'no consensus forks');
  assert.equal(cluster.forked, false);
});

test('3-node cluster observing the ledger every third round renews each node once, and buys only what it can pay for', async (t) => {
  const sim = createSimConnector({ nodeCount: 3, roundTimeMs: 30, factsEvery: 3, config: { leaseExtendMoments: 4, lastWillGraceRounds: 5, evrReserve: '0' } });
  const { cluster, mock, master } = sim;
  t.after(() => cluster.stop());
  const errors = [];
  cluster.on('error', (e) => errors.push(e));
  const alice = sim.peerClient(); await alice.connect();
  cluster.start();
  await sleepRounds(cluster, 3);
  // 20 EVR on hand, hosts charge 2 EVR a moment: two nodes get their 4 moments (16 EVR), the
  // third can only be bought 2 (4 EVR) — and, with the lease fact refreshed only every third
  // round, no node is paid for twice on a stale fact.
  mock.acct(master).evr = 20;
  for (const lease of mock.leases.values()) lease.expiresAt = Date.now() + 30 * 60_000;
  await waitFor(cluster, () => mock.evr(master) < 10, 40);
  await sleepRounds(cluster, 12);
  const payments = mock.log.filter((l) => l.type === 'Payment' && l.resultCode === 'tesSUCCESS');
  assert.equal(payments.length, 3, `one renewal per node: ${JSON.stringify(mock.log)}`);
  const bought = [...mock.leases.values()].map((l) => Math.round((l.expiresAt - Date.now() - 30 * 60_000) / l.momentMs)).sort();
  assert.deepEqual(bought, [2, 4, 4], 'sized to the EVR on hand');
  assert.equal(mock.evr(master), 0);
  const info = JSON.parse(await alice.submitContractReadRequest(JSON.stringify({ t: 'info' })));
  assert.ok(Object.values(info.leases).every((l) => l.extendedLcl > 0 && !l.pending && l.attempts === 0), JSON.stringify(info.leases));
  await cluster.stop();
  assert.deepEqual(errors, [], 'no consensus forks');
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
