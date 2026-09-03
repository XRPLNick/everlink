#!/usr/bin/env node
'use strict';
// Generates the key pairs the MAINNET run needs and writes them, git-ignored, next to this file:
//   tenant.mainnet.json  - the cluster's tenant = the connector's multisig account (secret used
//                          once by evdevkit to buy leases and install the SignerList)
//   peers.mainnet.json   - Alice and Bob, the two demo peers
// Nothing is funded here and nothing leaves this machine: you send XAH (and EVR to the tenant)
// from your own wallet to the printed addresses. Existing files are kept, so re-running only
// prints the addresses again.
//   node deploy/testnet/gen-accounts.js        (EV_NETWORK=mainnet)
const fs = require('fs');
const path = require('path');
const kp = require('ripple-keypairs');

const NETWORK = (process.env.EV_NETWORK || 'mainnet').toLowerCase();
const MAINNET = { server: 'wss://xahau.network', evrIssuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', momentSize: 3600 };
const tenantFile = path.join(__dirname, `tenant.${NETWORK}.json`);
const peersFile = path.join(__dirname, `peers.${NETWORK}.json`);

const gen = () => { const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' }); const pair = kp.deriveKeypair(seed); return { address: kp.deriveAddress(pair.publicKey), seed }; };

if (NETWORK !== 'mainnet') { console.log(`gen-accounts is for mainnet (test networks use the faucet); EV_NETWORK=${NETWORK}`); process.exit(1); }

let tenant;
if (fs.existsSync(tenantFile)) {
  tenant = JSON.parse(fs.readFileSync(tenantFile, 'utf8'));
  console.log(`tenant exists: ${tenant.address}`);
} else {
  const t = gen();
  tenant = { network: 'mainnet', server: MAINNET.server, address: t.address, secret: t.seed, evrIssuer: MAINNET.evrIssuer, momentSize: MAINNET.momentSize, createdAt: new Date().toISOString() };
  fs.writeFileSync(tenantFile, JSON.stringify(tenant, null, 2));
  console.log(`tenant generated: ${tenant.address}  (saved ${tenantFile})`);
}
let peers;
if (fs.existsSync(peersFile)) {
  peers = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
  console.log(`peers exist: Alice ${peers.alice.address}, Bob ${peers.bob.address}`);
} else {
  peers = { network: 'mainnet', alice: gen(), bob: gen() };
  fs.writeFileSync(peersFile, JSON.stringify(peers, null, 2));
  console.log(`peers generated (saved ${peersFile})`);
}
console.log('');
console.log('Fund these from your own wallet (Xahau mainnet):');
console.log(`  tenant / connector account  ${tenant.address}   10 XAH  + a little EVR (1 EVR is plenty; send it AFTER run-mainnet.cmd has set the trust line)`);
console.log(`  Alice (payer)               ${peers.alice.address}    8 XAH  (5 go into her payment channel)`);
console.log(`  Bob (payee)                 ${peers.bob.address}    2 XAH  (account reserve; he receives the payout)`);
console.log('');
console.log('Then: run-mainnet.cmd (sets the EVR trust line, buys 3 leases, installs the 3-signer list, uploads the contract)');
console.log('      run-mainnet-demo.cmd (Alice pays Bob 1 XAH through the cluster; the cluster settles on Xahau)');
