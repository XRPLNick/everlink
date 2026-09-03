#!/usr/bin/env node
'use strict';

// Lists Evernode hosts with free instance slots on the configured network and writes
// deploy/testnet/hosts.txt (one address per line, best candidates first).
//   node deploy/testnet/hosts.js [limit]

const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');

const net = require('net');

const NETWORK = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const PROBE_MS = 5000;

// TCP connect classification: 'open' | 'refused' (reachable, nothing listening) | 'timeout' | 'error'.
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(r); };
    s.setTimeout(PROBE_MS, () => done('timeout'));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : (e.code === 'ETIMEDOUT' ? 'timeout' : 'error')));
  });
}
async function probe(domain) {
  if (!domain || /\s|\(/.test(domain)) return { user: 'error', peer: 'error' };
  const [user, peer] = await Promise.all([tcpProbe(domain, 26201), tcpProbe(domain, 22861)]);
  return { user, peer };
}
const tenantFile = path.join(__dirname, `tenant.${(process.env.EV_NETWORK || 'testnet').toLowerCase()}.json`);
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const limit = Number(process.argv[2] || 12);
  await evernode.Defaults.useNetwork(NETWORK);
  const server = process.env.EV_XAHAUD_SERVER || (fs.existsSync(tenantFile) ? JSON.parse(fs.readFileSync(tenantFile)).server : null) || evernode.Defaults.values.rippledServer;
  const api = new evernode.XrplApi(server, { autoReconnect: false });
  await api.connect();
  evernode.Defaults.set({ rippledServer: server, xrplApi: api, useCentralizedRegistry: true });
  // Same construction evdevkit uses: the registry hook client resolved from the governor.
  const reg = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
  await reg.connect();
  // getActiveHostsFromLedger() fetches every host's domain with one account_info per host in
  // parallel; on mainnet that is thousands of requests against a public server. Decode the hook
  // states without domains, shortlist, then look up domains for the shortlist only.
  const everyHost = await reg.getAllHostsFromLedger(false);
  const all = everyHost.filter((h) => h.active);
  say(`${everyHost.length} registered hosts on ${NETWORK} (${server}), ${all.length} active`);
  const free = all
    .filter((h) => (h.maxInstances - h.activeInstances) > 0)
    .map((h) => ({
      address: h.address, domain: h.domain, country: h.countryCode, version: h.version,
      freeSlots: h.maxInstances - h.activeInstances, totalSlots: h.maxInstances,
      leaseEvr: Number(h.leaseAmount), reputation: h.hostReputation, ramMb: h.ramMb, cpuCores: h.cpuCount,
      lastHeartbeatIndex: h.lastHeartbeatIndex,
    }))
    // prefer well-reputed, cheap hosts with room
    .sort((a, b) => (b.reputation || 0) - (a.reputation || 0) || a.leaseEvr - b.leaseEvr || b.freeSlots - a.freeSlots);
  const shortlist = free.slice(0, limit * 4);
  for (const h of shortlist) {
    try { h.domain = await new evernode.XrplAccount(h.address, null, { xrplApi: api }).getDomain(); } catch (e) { h.domain = `(domain lookup failed: ${e.message || e})`; }
  }
  // Reachability: Sashimono hands instances ports from 26201 (user) / 22861 (peer) upwards. A
  // TCP connect to the first slot's ports tells a firewalled or NATed host (timeout) from a
  // reachable one (open, or refused because that slot is empty). A cluster node nobody can
  // reach never gets its contract, and hosts that can't be reached from the outside cannot
  // form a mesh with each other either.
  say(`probing ${shortlist.length} hosts for reachability ...`);
  await Promise.all(shortlist.map(async (h) => { h.reach = await probe(h.domain); }));
  const ok = (r) => r === 'open' || r === 'refused';
  const candidates = shortlist.filter((h) => ok(h.reach.user) && ok(h.reach.peer));
  say(`${candidates.length} of ${shortlist.length} reachable (user + peer port answer)`);
  // evdevkit takes the preferred hosts in file order (ties on price keep that order), so spread
  // the top of the list across operators: one host per registrable domain first, then the rest.
  const operator = (h) => String(h.domain || h.address).toLowerCase().split('.').slice(-2).join('.');
  const seenOps = new Set(); const spread = []; const rest = [];
  for (const h of candidates) { const op = operator(h); if (seenOps.has(op)) rest.push(h); else { seenOps.add(op); spread.push(h); } }
  const top = spread.concat(rest).slice(0, limit);
  const leases = free.map((h) => h.leaseEvr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const median = leases.length ? leases[Math.floor(leases.length / 2)] : 0;
  say(`${free.length} with free slots (lease EVR/moment: min ${leases[0]}, median ${median}, max ${leases[leases.length - 1]}); top ${top.length}:`);
  for (const h of top) say(`  ${h.address}  ${String(h.domain).padEnd(28)} ${h.country || "--"}  slots ${h.freeSlots}/${h.totalSlots}  lease ${h.leaseEvr} EVR/moment  rep ${h.reputation}  v${h.version}  ${h.cpuCores} cores ${h.ramMb} MB  ports ${h.reach.user}/${h.reach.peer}`);
  const pick = top.slice(0, 3);
  if (pick.length === 3) say(`3 leases x 4 moments on the top 3 = ${(pick.reduce((s, h) => s + h.leaseEvr, 0) * 4).toFixed(6)} EVR`);
  fs.writeFileSync(path.join(__dirname, `hosts.${NETWORK}.txt`), top.map((h) => h.address).join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, 'out', 'hosts.json'), JSON.stringify(free, null, 2));
  await reg.disconnect().catch(() => {});
  await api.disconnect().catch(() => {});
  if (free.length < 3) { say('fewer than 3 hosts with free slots'); process.exit(2); }
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
