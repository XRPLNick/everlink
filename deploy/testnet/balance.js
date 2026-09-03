#!/usr/bin/env node
'use strict';
// Prints and records the tenant's XAH/EVR balances (deploy/testnet/out/balance.json).
const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenant.json')));
(async () => {
  await evernode.Defaults.useNetwork(tenant.network || 'testnet');
  const api = new evernode.XrplApi(tenant.server, { autoReconnect: false });
  await api.connect();
  evernode.Defaults.set({ rippledServer: tenant.server, xrplApi: api });
  const client = new evernode.HostClient(tenant.address, tenant.secret, { xrplApi: api });
  await client.connect();
  const info = await client.xrplAcc.getInfo();
  const evr = await client.getEVRBalance();
  const out = { address: tenant.address, xah: Number(info.Balance) / 1e6, evr: Number(evr), ledger: api.ledgerIndex, at: new Date().toISOString() };
  console.log(JSON.stringify(out));
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'balance.json'), JSON.stringify(out, null, 2));
  await client.disconnect().catch(() => {}); await api.disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
