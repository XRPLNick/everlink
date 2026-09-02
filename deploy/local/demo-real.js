#!/usr/bin/env node
'use strict';

// Real-cluster demo: Alice connects to node 1 and Bob to node 2 of a local hpdevkit cluster
// running the Nomad Connector contract (ledger disabled, dev faucet on). Alice pays Bob with
// the unmodified ilp-protocol-stream library through the cluster.
//
//   node deploy/local/demo-real.js [alice-server] [bob-server]
// defaults: wss://localhost:8081 wss://localhost:8082

const path = require('path');
const HotPocket = require('hotpocket-js-client');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { HotPocketPlugin, hotPocketClientFactory } = require(path.join(__dirname, '..', '..', 'plugin', 'src'));

const ALICE = process.argv[2] || 'wss://localhost:8081';
const BOB = process.argv[3] || 'wss://localhost:8082';
const XAH = (d) => `${(Number(d) / 1e6).toFixed(6)} XAH`;
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function main() {
  const factory = hotPocketClientFactory();
  const mk = async (server, name) => {
    const keys = await HotPocket.generateKeys();
    const plugin = new HotPocketPlugin({ keys, servers: [server], createClient: factory, log: (...a) => say(`plugin[${name}]:`, ...a) });
    plugin.on('connector_error', (m) => say('connector says:', JSON.stringify(m)));
    return plugin;
  };

  say(`connecting Alice -> ${ALICE}, Bob -> ${BOB}`);
  const alice = await mk(ALICE, 'alice'); const bob = await mk(BOB, 'bob');
  const t0 = Date.now();
  await alice.connect(); await bob.connect();
  say(`connected in ${Date.now() - t0} ms`);

  const info = await alice.getInfo();
  say('connector info:', JSON.stringify({ address: info.connectorAddress, asset: info.assetCode, feeBps: info.feeBps, rounds: info.rounds, stats: info.stats }));

  const server = await createServer({ plugin: bob });
  let received = 0n;
  server.on('connection', (conn) => conn.on('stream', (s) => { s.setReceiveMax('100000000'); s.on('money', (a) => { received += BigInt(a); }); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  say('bob STREAM address:', destinationAccount.slice(0, 48) + '…');

  const t1 = Date.now();
  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  say(`STREAM connection established in ${Date.now() - t1} ms (ILDCP + rate probes through the cluster)`);
  say('alice balance after her first input (dev faucet):', XAH((await alice.getBalance()).balance));
  const stream = conn.createStream();
  const t2 = Date.now();
  stream.setSendMax('1000000');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stalled: sent ${stream.totalSent}`)), 120000);
    stream.on('outgoing_money', (a) => { say(`  packet fulfilled: +${XAH(a)} (total ${XAH(stream.totalSent)})`); if (stream.totalSent === '1000000') { clearTimeout(timer); resolve(); } });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  say(`Alice paid Bob ${XAH(stream.totalSent)} in ${Date.now() - t2} ms; Bob received ${XAH(received)}`);

  // Read balances while Alice's plugin is still connected: STREAM disconnects the plugin
  // when its connection closes (createConnection owns the plugin).
  const ab = await alice.getBalance(); const bb = await bob.getBalance();
  say('balances at the connector:', `Alice ${XAH(ab.balance)} (held ${XAH(ab.held)})`, `Bob ${XAH(bb.balance)}`);
  const info2 = await bob.getInfo();
  say('connector stats:', JSON.stringify(info2.stats), 'rounds', info2.rounds);
  try { await conn.end(); } catch (e) { say('note: STREAM close handshake did not complete cleanly:', e.message); }

  await server.close(); await bob.disconnect();
  say('done');
  process.exit(0);
}

main().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
