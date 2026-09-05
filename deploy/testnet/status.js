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
    const read = async (req, ms) => {
      const raw = await withTimeout(client.submitContractReadRequest(JSON.stringify(req)), ms, 'read');
      return raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : JSON.parse(Buffer.from(raw).toString('utf8'));
    };
    let info = null; let diag = null;
    try { info = await read({ t: 'info' }, 8000); } catch (e) { info = { error: e.message }; }
    try { diag = await read({ t: 'diag', probe: true, layers: true }, 60000); } catch (e) { diag = { error: e.message }; }
    // Renewal history ("lease: renewing / renewed / failed") separately from everpocket's
    // housekeeping summary, which prints two lines every ten rounds and would crowd it out.
    let leaseLog = null; let nomadLog = null;
    try { leaseLog = await read({ t: 'diag', events: 30, filter: 'lease:' }, 30000); } catch (e) { leaseLog = null; }
    try { nomadLog = await read({ t: 'diag', events: 4, filter: 'nomad lcl' }, 30000); } catch (e) { nomadLog = null; }
    const adv = s2.ledgerSeqNo > s1.ledgerSeqNo;
    say(`${node.domain}:${node.userPort} ${node.host}  connected in ${Date.now() - t0} ms; hp ${s2.hpVersion}; ledger ${s1.ledgerSeqNo} -> ${s2.ledgerSeqNo} after 7 s (${adv ? 'ADVANCING' : 'STUCK'}); vote ${s2.voteStatus}; unl ${s2.currentUnl.length} [${s2.currentUnl.map((u) => String(u).slice(0, 10)).join(' ')}]; peers ${(s2.peers || []).length}`);
    say(`  contract: ${info && info.connectorAddress ? `${info.connectorAddress} master ${info.masterAddress} rounds ${info.rounds} stats ${JSON.stringify(info.stats)}` : JSON.stringify(info)}`);
    // Contracts built since the last will exists report their hosting deadline; older ones have no `lease` field.
    if (info && info.lease) {
      say(`  hosting: quorum ${info.lease.quorum} of ${info.lease.signers} paid until ${new Date(info.lease.deadlineMs).toISOString()} (${Math.round((info.lease.deadlineMs - Date.now()) / 60000)} min)${info.winding ? ` WINDING DOWN since lcl ${info.lastWill.sinceLcl}` : ''}${info.leaseNote ? ` [${info.leaseNote}]` : ''}`);
      for (const n of info.lease.nodes || []) {
        const l = (info.leases || {})[n.id] || {};
        say(`    ${n.id.slice(0, 10)} paid until ${new Date(n.expiresAt).toISOString()} (${Math.round((n.expiresAt - Date.now()) / 60000)} min)${n.signer ? '' : ' not a signer'}${n.nomadPending ? ' (everpocket buying its initial life)' : ''}${l.pending ? ` renewal ${l.pending} in flight` : ''}${l.attempts ? ` ${l.attempts} failed attempt(s), next at lcl ${l.backoffUntilLcl}` : ''}${l.extendedLcl ? ` last renewed lcl ${l.extendedLcl}` : ''}`);
      }
    } else if (info && info.leaseNote) say(`  hosting: no lease fact (${info.leaseNote})`);
    if (diag && diag.last) {
      const l = diag.last;
      say(`  last round lcl ${l.lcl} at ${l.startedAt}: ${l.totalMs} ms (${Object.entries(l.phases).map(([k, v]) => `${k} ${v}`).join(', ')}); inputs ${l.inputs}; facts ${l.facts ? `ledger ${l.facts.ledgerIndex} balance ${l.facts.masterBalance} EVR ${l.facts.evrBalance} channels ${l.facts.channels}` : 'none'}; intents ${JSON.stringify(l.intents)}; errors ${JSON.stringify(l.errors)}`);
      const rounds = diag.rounds || [];
      say(`  rounds recorded: ${rounds.map((r) => `${r.lcl}:${r.totalMs}ms${r.errors.length ? '!' : ''}`).join(' ')}; state rounds ${diag.state && diag.state.rounds}`);
    } else say(`  diag: ${JSON.stringify(diag)}`);
    if (diag && diag.probe) say(`  probe from node: ${Object.entries(diag.probe).map(([k, v]) => `${k} -> ${v}`).join('; ')}`);
    if (diag && diag.ledger) say(`  ledger probe from node: ${JSON.stringify(diag.ledger)}`);
    if (diag && diag.layers) say(`  layers from node: ${Array.isArray(diag.layers) ? diag.layers.join(' | ') : JSON.stringify(diag.layers)}`);
    if (diag && diag.process) say(`  process: ${JSON.stringify(diag.process)}; dirs ${JSON.stringify(diag.dirs)}`);
    if (diag && diag.patch) say(`  patch.cfg: ${JSON.stringify(diag.patch)}; process ${JSON.stringify(diag.process)}`);
    if (diag && diag.events && diag.events.length) { say(`  last events on the node:`); for (const e of diag.events.slice(-24)) say(`    ${e}`); }
    if (leaseLog && leaseLog.events && leaseLog.events.length) { say(`  last renewal events on the node:`); for (const e of leaseLog.events.slice(-30)) say(`    ${e}`); }
    if (nomadLog && nomadLog.events && nomadLog.events.length) { say(`  last housekeeping summaries on the node:`); for (const e of nomadLog.events.slice(-4)) say(`    ${e}`); }
    return { node: node.host, ledger: s2.ledgerSeqNo, advancing: adv, unl: s2.currentUnl, peers: s2.peers, info, diag };
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
