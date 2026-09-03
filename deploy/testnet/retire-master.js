#!/usr/bin/env node
'use strict';

// Retire the tenant's master key: after this, the only way to move anything in the cluster
// account is the SignerList held by the cluster's nodes. Irreversible by design.
//
//   node deploy/testnet/retire-master.js          (EV_NETWORK=mainnet)
//
// Reads tenant.<net>.json (the last time its secret is ever needed) and contract/dist/cluster.json.
// Refuses unless the account has a SignerList whose quorum needs at least two signers and the
// cluster's nodes are answering. Submits one AccountSet with asfDisableMaster, signed by the
// master key, waits for validation and checks the lsfDisableMaster flag on the ledger.
// Writes out/retire-master.json.

const fs = require('fs');
const path = require('path');
const xrpl = require('xrpl');
const HotPocket = require('hotpocket-js-client');

const NETWORK = (process.env.EV_NETWORK || 'mainnet').toLowerCase();
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${NETWORK}.json`), 'utf8'));
const clusterFile = path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json');
const outFile = path.join(__dirname, 'out', 'retire-master.json');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const LSF_DISABLE_MASTER = 0x00100000;
const ASF_DISABLE_MASTER = 4;

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

async function nodeAnswers(node) {
  const keys = await HotPocket.generateKeys();
  const client = await HotPocket.createClient([`wss://${node.domain}:${node.userPort}`], keys, { requiredConnectionCount: 1, connectionTimeoutMs: 8000 });
  const ok = await withTimeout(client.connect(), 15000, 'connect');
  if (!ok) return null;
  try {
    const raw = await withTimeout(client.submitContractReadRequest(JSON.stringify({ t: 'info' })), 20000, 'read');
    const info = raw && typeof raw === 'object' ? raw : JSON.parse(Buffer.from(raw).toString('utf8'));
    return info && info.t === 'info' ? info : null;
  } finally { await client.close().catch(() => {}); }
}

async function main() {
  const client = new xrpl.Client(tenant.server, { connectionTimeout: 20000 });
  await client.connect();
  const wallet = xrpl.Wallet.fromSeed(tenant.secret, { algorithm: 'ecdsa-secp256k1' });
  if (wallet.classicAddress !== tenant.address) throw new Error(`tenant secret derives ${wallet.classicAddress}, not ${tenant.address}`);

  // 1. The account and its signer list.
  const info = await client.request({ command: 'account_info', account: tenant.address, signer_lists: true, ledger_index: 'validated' });
  const acct = info.result.account_data;
  const flags = Number(acct.Flags || 0);
  // rippled API v1 puts signer_lists inside account_data, v2 (xrpl.js 4) beside it.
  let lists = info.result.signer_lists || acct.signer_lists || [];
  if (!lists.length) {
    const objs = await client.request({ command: 'account_objects', account: tenant.address, type: 'signer_list', ledger_index: 'validated' });
    lists = objs.result.account_objects || [];
  }
  const sl = lists[0];
  say(`${tenant.address}: ${Number(acct.Balance) / 1e6} XAH, ${acct.OwnerCount} owner objects, flags 0x${flags.toString(16)}`);
  if (flags & LSF_DISABLE_MASTER) {
    say('the master key is already disabled; nothing to do');
    fs.writeFileSync(outFile, JSON.stringify({ address: tenant.address, alreadyDisabled: true, at: new Date().toISOString() }, null, 2));
    await client.disconnect(); return;
  }
  if (!sl) throw new Error('no SignerList on the account: disabling the master key would lock it for good');
  const signers = sl.SignerEntries.map((e) => e.SignerEntry.Account);
  say(`SignerList: quorum ${sl.SignerQuorum} of ${signers.length} signers (${signers.join(', ')})`);
  if (sl.SignerQuorum < 2 || signers.length < 3) throw new Error('refusing: the signer list is not a 2-of-3 (or stronger) cluster list');

  // 2. The cluster that holds those keys must be alive and must be the one on the list.
  const cluster = JSON.parse(fs.readFileSync(clusterFile, 'utf8'));
  const nodes = cluster.nodes.filter((n) => n.domain && n.userPort);
  const listed = nodes.filter((n) => signers.includes(n.signerAddress));
  if (listed.length !== signers.length) throw new Error(`cluster.json names ${listed.length} of the ${signers.length} signer accounts on the ledger; wrong cluster?`);
  let alive = 0;
  for (const n of nodes) {
    const i = await nodeAnswers(n).catch((e) => { say(`  ${n.domain}:${n.userPort}: ${e.message}`); return null; });
    if (i) { alive += 1; say(`  ${n.domain}:${n.userPort} answers: rounds ${i.rounds}, master ${i.masterAddress}`); if (i.masterAddress !== tenant.address) throw new Error('that node serves a different master account'); }
    else say(`  ${n.domain}:${n.userPort}: no answer`);
  }
  if (alive < sl.SignerQuorum) throw new Error(`only ${alive} nodes answer; the quorum needs ${sl.SignerQuorum}. Not disabling the key while the cluster cannot sign.`);

  // 3. The one transaction the master key signs last.
  say('disabling the master key (AccountSet asfDisableMaster) ...');
  const prepared = await client.autofill({ TransactionType: 'AccountSet', Account: tenant.address, SetFlag: ASF_DISABLE_MASTER });
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta && res.result.meta.TransactionResult;
  say(`${res.result.hash}: ${code} in ledger ${res.result.ledger_index}`);
  if (code !== 'tesSUCCESS') throw new Error(`AccountSet failed: ${code}`);

  // 4. Verify on the ledger.
  const after = await client.request({ command: 'account_info', account: tenant.address, ledger_index: 'validated' });
  const flagsAfter = Number(after.result.account_data.Flags || 0);
  const disabled = !!(flagsAfter & LSF_DISABLE_MASTER);
  say(disabled ? 'lsfDisableMaster is set: the cluster is now the only signer for this account' : 'WARNING: lsfDisableMaster not visible yet');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ address: tenant.address, tx: res.result.hash, ledger: res.result.ledger_index, result: code, flagsAfter, disabled, signers, quorum: sl.SignerQuorum, at: new Date().toISOString() }, null, 2));
  await client.disconnect();
  process.exit(disabled ? 0 : 2);
}

main().catch((e) => { say('FAILED', e && e.message ? e.message : e); process.exit(1); });
