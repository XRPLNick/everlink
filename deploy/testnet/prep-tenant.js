#!/usr/bin/env node
'use strict';
// Mainnet tenant preparation (idempotent): checks the tenant account is funded and gives it an
// EVR trust line if it has none (one TrustSet, fee only), then records the balances in
// deploy/testnet/out/balance.json. Exit codes: 0 ok, 3 account not funded yet, 4 no EVR yet.
//   node deploy/testnet/prep-tenant.js        (EV_NETWORK=mainnet)
const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');

const NETWORK = (process.env.EV_NETWORK || 'mainnet').toLowerCase();
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${NETWORK}.json`), 'utf8'));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const record = (o) => { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', 'balance.json'), JSON.stringify(o, null, 2)); };

(async () => {
  await evernode.Defaults.useNetwork(NETWORK);
  const api = new evernode.XrplApi(tenant.server, { autoReconnect: false });
  await api.connect();
  evernode.Defaults.set({ rippledServer: tenant.server, xrplApi: api, useCentralizedRegistry: true });
  const client = new evernode.TenantClient(tenant.address, tenant.secret, { xrplApi: api });
  await client.connect();
  const evrIssuer = client.config.evrIssuerAddress;
  say(`tenant ${tenant.address} on ${tenant.server} (EVR issuer ${evrIssuer}, moment ${client.config.momentSize} s)`);

  const info = await client.xrplAcc.getInfo().catch(() => null);
  if (!info || !info.Balance) {
    say('the tenant account does not exist on the ledger yet: send it 10 XAH first');
    record({ address: tenant.address, xah: 0, evr: 0, funded: false, at: new Date().toISOString() });
    process.exit(3);
  }
  const xah = Number(info.Balance) / 1e6;
  say(`XAH balance ${xah}`);

  const lines = await client.xrplAcc.getTrustLines(evernode.EvernodeConstants.EVR, evrIssuer);
  if (!lines || lines.length === 0) {
    say('no EVR trust line yet: setting one (TrustSet, fee only) ...');
    await client.xrplAcc.setTrustLine(evernode.EvernodeConstants.EVR, evrIssuer, '99999999999999');
    say('trust line set');
  } else say('EVR trust line present');

  const evr = Number(await client.getEVRBalance());
  say(`EVR balance ${evr}`);
  record({ address: tenant.address, xah, evr, funded: true, trustLine: true, ledger: api.ledgerIndex, at: new Date().toISOString() });
  await client.disconnect().catch(() => {}); await api.disconnect().catch(() => {});
  if (evr <= 0) { say(`no EVR yet: send some EVR to ${tenant.address} (the trust line exists now), then run again`); process.exit(4); }
  process.exit(0);
})().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
