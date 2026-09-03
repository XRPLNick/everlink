'use strict';

// Shared helpers for the testnet scripts: Xahau client (xrpl.js), faucet accounts, payment
// channels. Testnet only.

const xrpl = require('xrpl');
const kp = require('ripple-keypairs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function connect(server) {
  const client = new xrpl.Client(server, { connectionTimeout: 20000 });
  await client.connect();
  return client;
}

async function faucetAccount(client, server) {
  const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
  const pair = kp.deriveKeypair(seed);
  const address = kp.deriveAddress(pair.publicKey);
  const host = server.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  const url = `https://${host}/newcreds?account=${address}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch((e) => ({ status: 'ERR ' + e.message, text: async () => '' }));
  say(`faucet ${url} -> ${res.status}`);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const bal = await client.getXrpBalance(address).catch(() => null);
    if (bal && Number(bal) > 0) return { address, seed, publicKey: pair.publicKey, privateKey: pair.privateKey, xah: Number(bal) };
  }
  throw new Error(`faucet did not fund ${address}`);
}

async function submit(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta && res.result.meta.TransactionResult;
  if (code !== 'tesSUCCESS') throw new Error(`${tx.TransactionType} failed: ${code}`);
  return res.result;
}

// Opens a payment channel from `wallet` to `destination`; returns the channel id.
async function createChannel(client, wallet, destination, drops, settleDelay = 3600) {
  const result = await submit(client, wallet, {
    TransactionType: 'PaymentChannelCreate', Account: wallet.classicAddress, Destination: destination,
    Amount: String(drops), SettleDelay: settleDelay, PublicKey: wallet.publicKey,
  });
  const created = (result.meta.AffectedNodes || []).map((n) => n.CreatedNode).find((n) => n && n.LedgerEntryType === 'PayChannel');
  if (!created) throw new Error('channel id not found in tx meta');
  return { channelId: created.LedgerIndex, hash: result.hash };
}

async function accountChannels(client, account, destination) {
  const res = await client.request({ command: 'account_channels', account, destination_account: destination });
  return res.result.channels || [];
}

async function xahBalance(client, address) {
  const bal = await client.getXrpBalance(address).catch(() => '0');
  return Number(bal);
}

module.exports = { connect, faucetAccount, submit, createChannel, accountChannels, xahBalance, sleep, say, xrpl };
