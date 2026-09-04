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
const PROBE_PORTS = 40;

// TCP connect: 'open' | 'refused' | 'timeout' | 'error'.
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(r); };
    s.setTimeout(PROBE_MS, () => done('timeout'));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : (e.code === 'ETIMEDOUT' ? 'timeout' : 'error')));
  });
}
// Sashimono gives instances user ports from 26201 upwards (the slot number keeps counting, so
// a 3-slot host can hand out 26211). Hosts typically DROP closed ports, so the only positive
// signal is an open port of some running instance: probe a window of ports and count the
// open ones. 0 open = unknown (no running instance, or firewalled from the outside).
async function probe(domain) {
  if (!domain || /\s|\(/.test(domain)) return { open: 0, refused: 0, probed: 0, ip: null };
  let ip = null;
  try { ip = (await require('dns').promises.lookup(domain, { family: 4 })).address; } catch (e) { /* unresolvable: treated as unknown */ }
  const ports = Array.from({ length: PROBE_PORTS }, (_, i) => 26201 + i);
  const res = await Promise.all(ports.map((p) => tcpProbe(domain, p)));
  return { open: res.filter((r) => r === 'open').length, refused: res.filter((r) => r === 'refused').length, probed: ports.length, ip };
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
  const shortlist = free.slice(0, limit * 6);
  for (const h of shortlist) {
    try { h.domain = await new evernode.XrplAccount(h.address, null, { xrplApi: api }).getDomain(); } catch (e) { h.domain = `(domain lookup failed: ${e.message || e})`; }
  }
  // Reachability: a cluster node nobody can reach never gets its contract, and hosts that
  // cannot be reached from the outside cannot form a mesh with each other either.
  say(`probing ${shortlist.length} hosts for reachable instance ports (${PROBE_PORTS} ports each) ...`);
  for (let i = 0; i < shortlist.length; i += 24) {
    await Promise.all(shortlist.slice(i, i + 24).map(async (h) => { h.reach = await probe(h.domain); }));
  }
  const reachable = shortlist.filter((h) => h.reach.open > 0);
  const unknown = shortlist.filter((h) => h.reach.open === 0);
  say(`${reachable.length} of ${shortlist.length} have an instance port answering from here; ${unknown.length} unknown (no open port seen)`);
  // evdevkit takes the preferred hosts in file order (ties on price keep that order): verified
  // reachable hosts first, spread across operators, then the unknown ones the same way. Two
  // hosts count as one operator when they share a registrable domain OR a /24 network: on the
  // 3 September 2026 run two "different" domains resolved to the same IP, which would let one
  // operator hold 2 of the 3 signer keys.
  const operator = (h) => String(h.domain || h.address).toLowerCase().split('.').slice(-2).join('.');
  const network = (h) => (h.reach && h.reach.ip) ? h.reach.ip.split('.').slice(0, 3).join('.') : null;
  const spreadByOperator = (list) => {
    const seen = new Set(); const first = []; const rest = [];
    for (const h of list) {
      const keys = [operator(h), network(h)].filter(Boolean);
      if (keys.some((k) => seen.has(k))) rest.push(h); else { keys.forEach((k) => seen.add(k)); first.push(h); }
    }
    return first.concat(rest);
  };
  let top = spreadByOperator(reachable).concat(spreadByOperator(unknown)).slice(0, limit);
  // EVERLINK_PREFER_HOSTS: host accounts to put first (e.g. the hosts of a cluster that is known
  // to have formed a mesh), if they are active with a free slot; the ranked list follows.
  const prefer = String(process.env.EVERLINK_PREFER_HOSTS || '').split(/[\s,;]+/).filter((a) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a));
  if (prefer.length) {
    const byAddr = new Map(free.map((h) => [h.address, h]));
    const first = [];
    for (const a of prefer) {
      const h = byAddr.get(a);
      if (!h) { say(`preferred host ${a}: not active with a free slot, skipped`); continue; }
      if (!h.reach) { try { h.domain = await new evernode.XrplAccount(h.address, null, { xrplApi: api }).getDomain(); } catch (e) { /* keep */ } h.reach = await probe(h.domain); }
      first.push(h);
    }
    top = first.concat(top.filter((h) => !first.includes(h))).slice(0, Math.max(limit, first.length));
    say(`preferred hosts first: ${first.map((h) => h.address).join(' ')}`);
  }
  const leases = free.map((h) => h.leaseEvr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const median = leases.length ? leases[Math.floor(leases.length / 2)] : 0;
  say(`${free.length} with free slots (lease EVR/moment: min ${leases[0]}, median ${median}, max ${leases[leases.length - 1]}); top ${top.length}:`);
  for (const h of top) say(`  ${h.address}  ${String(h.domain).padEnd(28)} ${h.country || "--"}  ${String(h.reach.ip || '?').padEnd(15)}  slots ${h.freeSlots}/${h.totalSlots}  lease ${h.leaseEvr} EVR/moment  rep ${h.reputation}  v${h.version}  ${h.cpuCores} cores ${h.ramMb} MB  open ports ${h.reach.open}/${h.reach.probed}`);
  const pick = top.slice(0, 3);
  if (pick.length === 3) say(`3 leases x 4 moments on the top 3 = ${(pick.reduce((s, h) => s + h.leaseEvr, 0) * 4).toFixed(6)} EVR`);
  fs.writeFileSync(path.join(__dirname, `hosts.${NETWORK}.txt`), top.map((h) => h.address).join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, 'out', 'hosts.json'), JSON.stringify(free, null, 2));
  await reg.disconnect().catch(() => {});
  await api.disconnect().catch(() => {});
  if (free.length < 3) { say('fewer than 3 hosts with free slots'); process.exit(2); }
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
