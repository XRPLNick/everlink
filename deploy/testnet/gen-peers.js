#!/usr/bin/env node
'use strict';
// Generates two fresh Xahau accounts (Alice, Bob) for the settlement demo and writes
// deploy/testnet/peers.<network>.json with their seeds. Nothing is funded here: on mainnet you
// fund the printed addresses yourself (Alice ≥ 8 XAH, Bob ≥ 2 XAH).
const fs = require('fs');
const path = require('path');
const kp = require('ripple-keypairs');
const NETWORK = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const out = path.join(__dirname, `peers.${NETWORK}.json`);
if (fs.existsSync(out)) { const p = JSON.parse(fs.readFileSync(out)); console.log(`peers exist: Alice ${p.alice.address}, Bob ${p.bob.address}`); process.exit(0); }
const gen = () => { const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' }); const pair = kp.deriveKeypair(seed); return { address: kp.deriveAddress(pair.publicKey), seed }; };
const peers = { network: NETWORK, alice: gen(), bob: gen() };
fs.writeFileSync(out, JSON.stringify(peers, null, 2));
console.log(`Alice ${peers.alice.address}  (fund with >= 8 XAH: 5 go into the payment channel)`);
console.log(`Bob   ${peers.bob.address}  (fund with >= 2 XAH: account reserve; receives the payout)`);
console.log(`saved ${out}`);
