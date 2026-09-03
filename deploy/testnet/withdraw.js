#!/usr/bin/env node
'use strict';
// Pays a demo peer's unspent connector credit back to its Xahau account: connects with the
// HotPocket identity saved in peers.<network>.json, names the payout address, asks for the
// payout, and watches the ledger.   node deploy/testnet/withdraw.js [alice|bob]
const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-js-client');
const { HotPocketPlugin, hotPocketClientFactory } = require(path.join(__dirname, '..', '..', 'plugin', 'src'));
const L = require('./lib');
const NETWORK = (process.env.EV_NETWORK || 'mainnet').toLowerCase();
const who = process.argv[2] || 'alice';
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${NETWORK}.json`), 'utf8'));
const peers = JSON.parse(fs.readFileSync(path.join(__dirname, `peers.${NETWORK}.json`), 'utf8'));
const cluster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json'), 'utf8'));
const XAH = (d) => `${(Number(d) / 1e6).toFixed(6)} XAH`;
const { say, sleep } = L;

(async () => {
  const p = peers[who];
  if (!p || !p.hp) throw new Error(`${who} has no saved HotPocket identity in peers.${NETWORK}.json (run the demo first)`);
  const node = cluster.nodes.find((n) => n.domain && n.userPort);
  const keys = await HotPocket.generateKeys(p.hp.privateKey);
  const plugin = new HotPocketPlugin({ keys, servers: [`wss://${node.domain}:${node.userPort}`], createClient: hotPocketClientFactory(), log: (...a) => say('plugin:', ...a) });
  plugin.on('payout', (m) => say(`payout ${m.status}: ${XAH(m.amt)} ${m.tx || ''} ${m.reason || ''}`));
  await plugin.connect();
  const bal = await plugin.getBalance();
  say(`${who} ${p.address}: connector balance ${XAH(bal.balance)}, payout pending: ${bal.pendingPayout ? 'yes' : 'no'}`);
  if (BigInt(bal.balance) <= 0n) { say('nothing to withdraw'); await plugin.disconnect(); process.exit(0); }
  const client = await L.connect(tenant.server);
  const before = await L.xahBalance(client, p.address);
  await plugin.setPayoutAddress(p.address);
  await plugin.withdraw();
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const now = await L.xahBalance(client, p.address);
    say(`  t+${(i + 1) * 10}s: on-ledger ${now} XAH (was ${before})`);
    if (now > before) break;
  }
  await plugin.disconnect(); await client.disconnect();
  process.exit(0);
})().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
