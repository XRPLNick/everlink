#!/usr/bin/env node
'use strict';

// Narrated demo: a 3-node simulated Everlink cluster, Alice pays Bob with the real
// ilp-protocol-stream library, the cluster settles both sides on the mock Xahau ledger,
// then pays its own hosts in EVR and buys more EVR with its fees.
//
//   npm run demo

const { createConnection, createServer } = require('ilp-protocol-stream');
const { createSimConnector } = require('./cluster');
const { SimClient, edKeys } = require('./hotpocket-sim');
const { HotPocketPlugin } = require('../plugin/src');
const kp = require('ripple-keypairs');

const XAH = (drops) => `${(Number(drops) / 1e6).toFixed(6)} XAH`;
const say = (...a) => console.log(...a);
const rounds = (cluster, n) => new Promise((resolve) => { let c = 0; const h = () => { if (++c >= n) { cluster.off('round', h); resolve(); } }; cluster.on('round', h); });

async function main() {
  const sim = createSimConnector({
    nodeCount: 3, roundTimeMs: 40,
    config: { feeBps: 25, minExpiryWindowMs: 1000, redeemThresholdDrops: '2000000', payoutThresholdDrops: '1000000', evrTopUpXahDrops: '2000000', evrTopUpMinEvr: '6', leaseExtendMoments: 4 },
  });
  const { cluster, mock, master, config } = sim;
  cluster.on('error', (e) => { console.error('cluster error', e); process.exit(1); });
  say(`\n== Everlink demo ==`);
  say(`cluster: ${cluster.nodes.length} HotPocket nodes, ${sim.cluster.roundTimeMs} ms rounds`);
  say(`multisig account ${master}: ${XAH(mock.balance(master))}, ${mock.evr(master)} EVR`);
  say(`fee ${config.feeBps} bps, ILP prefix ${config.ilpAddress}\n`);
  cluster.start();

  const plugin = (keys) => new HotPocketPlugin({ keys, servers: ['sim://cluster'], createClient: async ({ keys: k }) => new SimClient(cluster, k) });

  // Alice funds herself: a payment channel to the connector + one signed claim.
  const aliceSeed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
  const aliceKp = kp.deriveKeypair(aliceSeed);
  const aliceAddr = kp.deriveAddress(aliceKp.publicKey);
  mock.fund(aliceAddr, 50_000_000n);
  const channel = mock.createChannel({ account: aliceAddr, destination: master, amount: 5_000_000n, publicKey: aliceKp.publicKey });
  say(`Alice ${aliceAddr} opens a 5 XAH payment channel to the connector: ${channel.slice(0, 12)}…`);
  const alice = plugin(edKeys());
  await alice.connect();
  await rounds(cluster, 2);
  const ack = await alice.sendClaim({ channel, amount: 3_000_000, privateKey: aliceKp.privateKey });
  say(`Alice sends a signed claim for 3 XAH -> connector: ${ack.ok ? 'accepted' : ack.reason}, balance ${XAH(ack.balance)}`);

  // Bob: STREAM receiver, wants payouts to his Xahau address.
  const bob = plugin(edKeys());
  const bobAddr = 'rBobPayoutAddress1111111111111111';
  bob.on('payout', (p) => say(`  [connector -> Bob] payout ${p.status}: ${XAH(p.amt)}${p.tx ? ` tx ${p.tx.slice(0, 12)}…` : ''}`));
  const server = await createServer({ plugin: bob });
  await bob.setPayoutAddress(bobAddr);
  let received = 0n;
  server.on('connection', (conn) => conn.on('stream', (s) => { s.setReceiveMax('100000000'); s.on('money', (amt) => { received += BigInt(amt); }); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  say(`Bob's STREAM address: ${destinationAccount.slice(0, 40)}…`);

  // Pay.
  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  const stream = conn.createStream();
  const t0 = Date.now();
  stream.setSendMax('2500000');
  await new Promise((resolve) => stream.on('outgoing_money', () => { if (stream.totalSent === '2500000') resolve(); }));
  await conn.end();
  say(`\nAlice paid Bob ${XAH(stream.totalSent)} over ILP/STREAM in ${Date.now() - t0} ms; Bob received ${XAH(received)} (fees ${XAH(2_500_000n - received)})`);
  const ab = await alice.getBalance(); const bb = await bob.getBalance();
  say(`connector balances: Alice ${XAH(ab.balance)}, Bob ${XAH(bb.balance)}`);

  // Settlement.
  say(`\nSettling…`);
  await rounds(cluster, 8);
  say(`Alice's channel redeemed on-ledger: ${XAH(mock.channels.get(channel).balance)} claimed of ${XAH(mock.channels.get(channel).amount)}`);
  say(`Bob's Xahau account ${bobAddr}: ${XAH(mock.balance(bobAddr))}`);
  say(`connector multisig account: ${XAH(mock.balance(master))}`);

  // Self-funding.
  say(`\nFast-forwarding the hosts' leases to near expiry…`);
  for (const lease of mock.leases.values()) lease.expiresAt = Date.now() + lease.momentMs;
  const evrBefore = mock.evr(master);
  await rounds(cluster, 10);
  const hostEvr = ['rHost0', 'rHost1', 'rHost2'].map((h) => mock.evr(h));
  say(`hosts paid in EVR by the cluster itself: ${hostEvr.join(', ')} (leases extended 4 moments each)`);
  say(`treasury EVR ${evrBefore} -> ${mock.evr(master)} after paying hosts and buying EVR with XAH fees on the DEX`);
  say(`ledger log: ${mock.log.map((l) => `${l.type}:${l.resultCode}`).join(', ')}`);
  say(`\nconsensus forks: ${cluster.forked ? 'YES' : 'none'} across ${cluster.lclSeqNo} rounds on ${cluster.nodes.length} nodes\n`);

  await server.close(); await alice.disconnect(); await bob.disconnect(); await cluster.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
