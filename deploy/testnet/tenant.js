#!/usr/bin/env node
'use strict';

// Creates and funds an Evernode *testnet* tenant account: XAH from the network faucet, an
// EVR trust line, and the foundation's EVR gift (the same steps as Evernode's
// test-account-generator, reimplemented so it runs from this repo's node_modules).
// Writes deploy/testnet/tenant.json (git-ignored). Testnet only — never use this for mainnet.
//
//   node deploy/testnet/tenant.js

const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');

const NETWORK = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const OUT = path.join(__dirname, 'tenant.json');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickServer(candidates) {
  for (const server of candidates) {
    say(`trying ${server} …`);
    const api = new evernode.XrplApi(server, { autoReconnect: false });
    try {
      await Promise.race([api.connect(), sleep(15000).then(() => { throw new Error('timeout'); })]);
      say(`  connected, ledger ${api.ledgerIndex}`);
      return { server, api };
    } catch (e) {
      say(`  no: ${e.message || e}`);
      try { await api.disconnect(); } catch (_) { /* ignore */ }
    }
  }
  throw new Error('no reachable Xahau server for ' + NETWORK);
}

async function main() {
  if (NETWORK !== 'testnet' && NETWORK !== 'devnet') throw new Error('this script funds test accounts only');
  if (fs.existsSync(OUT)) { say(`tenant already exists: ${JSON.parse(fs.readFileSync(OUT)).address} (delete ${OUT} to make a new one)`); return; }

  await evernode.Defaults.useNetwork(NETWORK);
  const defaults = evernode.Defaults.values;
  say('network definitions:', JSON.stringify({ rippledServer: defaults.rippledServer, governor: defaults.governorAddress, networkID: defaults.networkID }));
  const candidates = [process.env.EV_XAHAUD_SERVER, defaults.rippledServer, 'wss://xahau-test.net', 'wss://hooks-testnet-v3.xrpl-labs.com'].filter((v, i, a) => v && a.indexOf(v) === i);
  const { server, api } = await pickServer(candidates);
  evernode.Defaults.set({ rippledServer: server, xrplApi: api });

  const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
  const pair = kp.deriveKeypair(seed);
  const address = kp.deriveAddress(pair.publicKey);
  say(`new account ${address}`);

  // Faucet: the rippled host serves POST /newcreds?account=<address> on these test networks.
  const host = server.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  const faucets = [`https://${host}/newcreds?account=${address}`, `https://faucet.${host.replace(/^[^.]+\./, '')}/accounts`];
  let funded = false;
  for (const url of faucets) {
    try {
      say(`faucet ${url}`);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: url.endsWith('/accounts') ? JSON.stringify({ destination: address }) : undefined });
      say(`  http ${res.status}`);
      const text = await res.text().catch(() => '');
      if (text) say(`  ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      funded = res.ok || res.status === 0;
      if (funded) break;
    } catch (e) { say(`  failed: ${e.message}`); }
  }
  const acc = new evernode.XrplAccount(address, seed, { xrplApi: api });
  let xah = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const info = await acc.getInfo().catch(() => null);
    if (info && info.Balance) { xah = Number(info.Balance) / 1e6; break; }
  }
  if (!xah) throw new Error('XAH did not arrive from the faucet (tried: ' + faucets.join(' , ') + ')');
  say(`XAH balance ${xah}`);

  // EVR: trust line + the foundation's gift for test accounts.
  const client = new evernode.HostClient(address, seed, { xrplApi: api });
  await client.connect();
  const cfg = client.config;
  say('evernode config:', JSON.stringify({ evrIssuer: cfg.evrIssuerAddress, foundation: cfg.foundationAddress, momentSize: cfg.momentSize }));
  say('setting EVR trust line …');
  await acc.setTrustLine(evernode.EvernodeConstants.EVR, cfg.evrIssuerAddress, '99999999999999');
  say('requesting the EVR gift …');
  await acc.makePayment(cfg.foundationAddress, evernode.XrplConstants.MIN_XRP_AMOUNT, evernode.XrplConstants.XRP, null, [{ type: 'giftBetaEvr', format: '', data: '' }]);
  let evr = '0';
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    evr = await client.getEVRBalance();
    if (evr !== '0') break;
  }
  say(`EVR balance ${evr}`);
  const tenant = { network: NETWORK, server, address, secret: seed, xah, evr, createdAt: new Date().toISOString(), evrIssuer: cfg.evrIssuerAddress, foundation: cfg.foundationAddress, momentSize: cfg.momentSize };
  fs.writeFileSync(OUT, JSON.stringify(tenant, null, 2));
  say(`saved ${OUT}`);
  await client.disconnect().catch(() => {});
  await api.disconnect().catch(() => {});
  if (evr === '0') { say('WARNING: no EVR received; leases cannot be bought without EVR'); process.exit(2); }
}

main().then(() => process.exit(0)).catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
