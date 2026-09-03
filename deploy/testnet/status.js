#!/usr/bin/env node
'use strict';
// Read-only health check of the deployed cluster: connects to every node in
// contract/dist/cluster.json, prints HotPocket's status (ledger sequence) twice a few seconds
// apart (is consensus advancing?) and asks the connector for its `info` read request.
//   node deploy/testnet/status.js [clusterFile]
const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-js-client');

const clusterFile = process.argv[2] || path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json');
const cluster = JSON.parse(fs.readFileSync(clusterFile, 'utf8'));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: timeout after ${ms} ms`); })]);

async function probe(node) {
  const server = `wss://${node.domain}:${node.userPort}`;
  const keys = await HotPocket.generateKeys();
  const client = await HotPocket.createClient([server], keys, { contractId: node.contractId || undefined, requiredConnectionCount: 1, connectionTimeoutMs: 8000 });
  const t0 = Date.now();
  let ok = false;
  try { ok = await withTimeout(client.connect(), 15000, 'connect'); } catch (e) { say(`${node.domain}:${node.userPort} ${node.host}  connect FAILED: ${e.message}`); return null; }
  if (!ok) { say(`${node.domain}:${node.userPort} ${node.host}  connect FAILED`); return null; }
  try {
    const s1 = await withTimeout(client.getStatus(), 8000, 'status');
    await sleep(7000);
    const s2 = await withTimeout(client.getStatus(), 8000, 'status');
    let info = null;
    try {
      const raw = await withTimeout(client.submitContractReadRequest(JSON.stringify({ t: 'info' })), 8000, 'read');
      info = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch (e) { info = { error: e.message }; }
    const adv = s2.ledgerSeqNo > s1.ledgerSeqNo;
    say(`${node.domain}:${node.userPort} ${node.host}  connected in ${Date.now() - t0} ms; hp ${s2.hpVersion}; ledger ${s1.ledgerSeqNo} -> ${s2.ledgerSeqNo} after 7 s (${adv ? 'ADVANCING' : 'STUCK'}); vote ${s2.voteStatus}; unl ${s2.currentUnl.length} [${s2.currentUnl.map((u) => String(u).slice(0, 10)).join(' ')}]; peers ${(s2.peers || []).length}`);
    say(`  contract: ${info && info.connectorAddress ? `${info.connectorAddress} master ${info.masterAddress} rounds ${info.rounds} stats ${JSON.stringify(info.stats)}` : JSON.stringify(info)}`);
    return { node: node.host, ledger: s2.ledgerSeqNo, advancing: adv, unl: s2.currentUnl, peers: s2.peers, info };
  } finally { await client.close().catch(() => {}); }
}

(async () => {
  say(`cluster of ${cluster.nodes.length} nodes (${clusterFile})`);
  const results = [];
  for (const n of cluster.nodes) results.push(await probe(n));
  const live = results.filter(Boolean);
  say(`${live.length}/${cluster.nodes.length} nodes reachable, ${live.filter((r) => r.advancing).length} advancing`);
  fs.writeFileSync(path.join(__dirname, 'out', 'status.json'), JSON.stringify(results, null, 2));
  process.exit(live.some((r) => r.advancing) ? 0 : 3);
})().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
