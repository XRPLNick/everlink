#!/usr/bin/env node
'use strict';

// The real thing, on Xahau testnet: Alice opens a payment channel to the cluster's multisig
// account and streams a signed claim; she pays Bob 1 XAH with unmodified ilp-protocol-stream
// through the Evernode-hosted cluster; the cluster redeems her channel on-ledger with a
// multisigned PaymentChannelClaim and pays Bob out with a multisigned Payment.
//
//   node deploy/testnet/demo-testnet.js
// reads deploy/testnet/tenant.json and contract/dist/cluster.json (written by evdevkit).

const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-js-client');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { HotPocketPlugin, hotPocketClientFactory } = require(path.join(__dirname, '..', '..', 'plugin', 'src'));
const L = require('./lib');

const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${(process.env.EV_NETWORK || 'testnet').toLowerCase()}.json`), 'utf8'));
const clusterFile = process.argv[2] || path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json');
const cluster = JSON.parse(fs.readFileSync(clusterFile, 'utf8'));
const nodes = cluster.nodes.filter((n) => n.domain && n.userPort);
const XAH = (d) => `${(Number(d) / 1e6).toFixed(6)} XAH`;
const { say, sleep } = L;

async function main() {
  const master = tenant.address;
  say(`cluster of ${nodes.length} nodes; multisig/master account ${master}; Xahau ${tenant.server}`);
  const client = await L.connect(tenant.server);

  // On-ledger actors.
  say('funding Alice and Bob from the testnet faucet …');
  const aliceX = await L.faucetAccount(client, tenant.server);
  const bobX = await L.faucetAccount(client, tenant.server);
  const aliceWallet = L.xrpl.Wallet.fromSeed(aliceX.seed);
  say(`Alice ${aliceX.address} (${aliceX.xah} XAH), Bob ${bobX.address} (${bobX.xah} XAH), master ${XAH(await L.xahBalance(client, master) * 1e6)}`);

  say('Alice opens a 5 XAH payment channel to the cluster account …');
  const { channelId, hash: chanTx } = await L.createChannel(client, aliceWallet, master, 5_000_000, 3600);
  say(`channel ${channelId} (tx ${chanTx})`);

  // Peers.
  const factory = hotPocketClientFactory();
  const mk = async (node, name) => {
    const keys = await HotPocket.generateKeys();
    const plugin = new HotPocketPlugin({ keys, servers: [`wss://${node.domain}:${node.userPort}`], createClient: factory, log: (...a) => say(`plugin[${name}]:`, ...a) });
    plugin.on('connector_error', (m) => say(`[${name}] connector says:`, JSON.stringify(m)));
    plugin.on('payout', (m) => say(`[${name}] payout ${m.status}: ${XAH(m.amt)} ${m.tx || ''} ${m.reason || ''}`));
    plugin.on('claim_ack', (m) => say(`[${name}] claim_ack:`, JSON.stringify(m)));
    return plugin;
  };
  const alice = await mk(nodes[0], 'alice'); const bob = await mk(nodes[1 % nodes.length], 'bob');
  await alice.connect(); await bob.connect();
  const info = await alice.getInfo();
  say('connector info:', JSON.stringify({ address: info.connectorAddress, master: info.masterAddress, feeBps: info.feeBps, rounds: info.rounds, stats: info.stats }));

  // Wait for the cluster to observe the channel (it queries Xahau every few rounds), then claim.
  say('waiting for the cluster to see the channel …');
  let ack = null;
  for (let i = 0; i < 12 && !(ack && ack.ok); i++) {
    if (i) await sleep(10000);
    ack = await alice.sendClaim({ channel: channelId, amount: 3_000_000, privateKey: aliceX.privateKey });
    say(`claim attempt ${i + 1}: ${ack.ok ? 'accepted' : ack.reason}`);
  }
  if (!ack || !ack.ok) throw new Error('claim never accepted: ' + JSON.stringify(ack));
  say(`Alice's connector balance: ${XAH((await alice.getBalance()).balance)}`);
  await bob.setPayoutAddress(bobX.address);

  // Pay.
  const server = await createServer({ plugin: bob });
  let received = 0n;
  server.on('connection', (conn) => conn.on('stream', (s) => { s.setReceiveMax('100000000'); s.on('money', (a) => { received += BigInt(a); }); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  const t0 = Date.now();
  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  say(`STREAM connection established in ${Date.now() - t0} ms`);
  const stream = conn.createStream();
  const t1 = Date.now();
  stream.setSendMax('1000000');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stalled: sent ${stream.totalSent}`)), 240000);
    stream.on('outgoing_money', (a) => { say(`  packet fulfilled: +${XAH(a)}`); if (stream.totalSent === '1000000') { clearTimeout(timer); resolve(); } });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  say(`Alice paid Bob ${XAH(stream.totalSent)} in ${Date.now() - t1} ms; Bob received ${XAH(received)}`);
  const ab = await alice.getBalance(); const bb = await bob.getBalance();
  say(`connector balances: Alice ${XAH(ab.balance)}, Bob ${XAH(bb.balance)} (payout pending: ${bb.pendingPayout ? 'yes' : 'no'})`);
  try { await server.close(); } catch (e) { say('note: server close:', e.message); }
  try { await conn.end(); } catch (e) { say('note: connection end:', e.message); }

  // Settlement on Xahau: the channel gets redeemed (3 XAH) and Bob gets paid out (≈0.9975 XAH).
  say('watching Xahau for the multisigned settlement transactions …');
  const bobBefore = bobX.xah;
  let redeemed = 0; let bobNow = bobBefore;
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const chans = await L.accountChannels(client, aliceX.address, master);
    redeemed = chans.length ? Number(chans[0].balance) / 1e6 : 0;
    bobNow = await L.xahBalance(client, bobX.address);
    say(`  t+${(i + 1) * 10}s: channel redeemed ${redeemed} XAH, Bob on-ledger ${bobNow} XAH (was ${bobBefore})`);
    if (redeemed >= 3 && bobNow > bobBefore) break;
  }
  say(`master account now ${await L.xahBalance(client, master)} XAH`);
  say(redeemed >= 3 && bobNow > bobBefore ? 'SETTLED on Xahau testnet: channel claim redeemed and Bob paid by the cluster' : 'settlement not (fully) observed yet — check the node logs');
  await bob.disconnect(); await client.disconnect();
  process.exit(0);
}

main().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
