#!/usr/bin/env node
'use strict';
// Writes contract/dist/everlink.config.json for this tenant and network from the template in
// deploy/testnet/everlink.config.testnet.json (Windows PowerShell 5.1's ConvertTo-Json is not
// reliable enough for this: it threw OutOfMemoryException on the same object).
//   node deploy/testnet/patch-config.js        (EV_NETWORK, EVERLINK_SIZE)
const fs = require('fs');
const path = require('path');

const NETWORK = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const SIZE = Number(process.env.EVERLINK_SIZE || 3);
const root = path.join(__dirname, '..', '..');
const cfgPath = path.join(root, 'contract', 'dist', 'everlink.config.json');
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${NETWORK}.json`), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'everlink.config.testnet.json'), 'utf8'));
const hostsFile = path.join(__dirname, `hosts.${NETWORK}.txt`);
const hosts = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, 'utf8').split(/\r?\n/).filter((l) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(l)).slice(0, 12) : [];

cfg.connector.masterAddress = tenant.address;
cfg.connector.evrIssuer = tenant.evrIssuer;
cfg.xahau.rippleServer = tenant.server;
cfg.xahau.network = NETWORK;
cfg.nomad.preferredHosts = hosts;
cfg.nomad.targetNodeCount = SIZE;
if (NETWORK === 'mainnet') {
  // Real money: 5 XAH never leaves the account (Xahau reserve is ~2 XAH with the SignerList,
  // trust line and lease tokens); EVR reserve tiny so the treasury never buys EVR on the DEX
  // during the demo (leases on the chosen hosts cost ~0.000001 EVR per moment).
  cfg.connector.ilpAddress = 'g.everlink';
  cfg.connector.reserveDrops = '5000000';
  cfg.connector.evrReserve = '0.01';
  cfg.connector.evrTopUpXahDrops = '1000000';
  cfg.connector.evrTopUpMinEvr = '1';
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`wrote ${cfgPath}`);
console.log(JSON.stringify(cfg, null, 2));
