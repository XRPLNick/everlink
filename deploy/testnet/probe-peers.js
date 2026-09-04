#!/usr/bin/env node
'use strict';
// From this machine: can each node of contract/dist/cluster.json be reached on its peer port
// (the HotPocket mesh) and its user port? A cluster whose nodes never show any peers is
// usually one whose peer ports are not reachable from the outside — this tells which.
//   node deploy/testnet/probe-peers.js [clusterFile]
const fs = require('fs');
const net = require('net');
const path = require('path');
const dns = require('dns').promises;
const WebSocket = require('ws');

const clusterFile = process.argv[2] || path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json');
const cluster = JSON.parse(fs.readFileSync(clusterFile, 'utf8'));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function tcp(host, port, ms = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(`${r} ${Date.now() - t0} ms`); };
    s.setTimeout(ms, () => done('timeout'));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code || 'error'));
  });
}
// HotPocket's mesh speaks WebSocket on the peer port: an upgrade that completes means HotPocket
// itself is listening there, not just a firewall or a port forward.
function ws(url, ms = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let w;
    const timer = setTimeout(() => { try { w.terminate(); } catch (e) { /* ignore */ } resolve(`timeout ${ms} ms`); }, ms);
    try { w = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: ms }); } catch (e) { clearTimeout(timer); return resolve(`error ${e.message}`); }
    w.on('open', () => { clearTimeout(timer); const r = `websocket open ${Date.now() - t0} ms`; try { w.close(); } catch (e) { /* ignore */ } resolve(r); });
    w.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve(`http ${res.statusCode} ${Date.now() - t0} ms`); });
    w.on('error', (e) => { clearTimeout(timer); resolve(`${e.code || e.message} ${Date.now() - t0} ms`); });
  });
}

(async () => {
  say(`probing ${cluster.nodes.length} nodes of ${clusterFile} from ${require('os').hostname()}`);
  for (const n of cluster.nodes) {
    let ip = '?';
    try { ip = (await dns.lookup(n.domain, { family: 4 })).address; } catch (e) { ip = `unresolvable (${e.code || e.message})`; }
    const [peerTcp, userTcp] = await Promise.all([tcp(n.domain, n.peerPort), tcp(n.domain, n.userPort)]);
    const [peerWs, peerWss, userWss] = await Promise.all([ws(`ws://${n.domain}:${n.peerPort}`), ws(`wss://${n.domain}:${n.peerPort}`), ws(`wss://${n.domain}:${n.userPort}`)]);
    say(`${String(n.pubkey).slice(0, 10)} ${n.domain} (${ip}) host ${n.host}`);
    say(`   peer port ${n.peerPort}: tcp ${peerTcp}; ws ${peerWs}; wss ${peerWss}`);
    say(`   user port ${n.userPort}: tcp ${userTcp}; wss ${userWss}`);
  }
})().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
