#!/usr/bin/env node
'use strict';

// Lists Evernode hosts with free instance slots on the configured network and writes
// deploy/testnet/hosts.txt (one address per line, best candidates first).
//   node deploy/testnet/hosts.js [limit]

const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');

const NETWORK = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const tenantFile = path.join(__dirname, 'tenant.json');
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
  const all = await reg.getActiveHostsFromLedger();
  say(`${all.length} active hosts on ${NETWORK} (${server})`);
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
  say(`${free.length} with free slots; top ${Math.min(limit, free.length)}:`);
  for (const h of free.slice(0, limit)) say(`  ${h.address}  ${String(h.domain).padEnd(28)} ${h.country || '--'}  slots ${h.freeSlots}/${h.totalSlots}  lease ${h.leaseEvr} EVR/moment  rep ${h.reputation}  v${h.version}`);
  fs.writeFileSync(path.join(__dirname, 'hosts.txt'), free.slice(0, limit).map((h) => h.address).join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, 'out', 'hosts.json'), JSON.stringify(free, null, 2));
  await reg.disconnect().catch(() => {});
  await api.disconnect().catch(() => {});
  if (free.length < 3) { say('fewer than 3 hosts with free slots'); process.exit(2); }
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
