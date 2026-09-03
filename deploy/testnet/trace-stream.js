#!/usr/bin/env node
'use strict';

// Packet-level trace of an ILP/STREAM payment through the cluster.
//
// Records every ILP packet the two peers' plugins see - Alice's Prepares and the cluster's
// replies, the Prepares the cluster forwards to Bob and his replies - decodes them (RFC 27),
// decrypts the STREAM frames inside with the receiver's shared secret (RFC 29) and checks every
// Fulfill against its Prepare's condition. The result is a text trace anyone can read and a
// JSON file (raw packets included) anyone can re-check.
//
//   node deploy/testnet/trace-stream.js [amountDrops]      default 1000000 (1 XAH)
//
// Mainnet: Alice opens a channel of amount + 1 XAH, claims exactly `amount`, pays Bob over
// STREAM; Bob has named his payout address so the cluster pays him out on-ledger; Alice closes
// her channel afterwards. Reads tenant.<net>.json, peers.<net>.json (mainnet, identities are
// persisted there) and contract/dist/cluster.json. Writes out/stream-trace.txt and .json.

const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-js-client');
const { createConnection, createServer } = require('ilp-protocol-stream');
const { HotPocketPlugin, hotPocketClientFactory } = require(path.join(__dirname, '..', '..', 'plugin', 'src'));
const { Tracer } = require('./trace-lib');
const L = require('./lib');

const net = (process.env.EV_NETWORK || 'testnet').toLowerCase();
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, `tenant.${net}.json`), 'utf8'));
const cluster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contract', 'dist', 'cluster.json'), 'utf8'));
const nodes = cluster.nodes.filter((n) => n.domain && n.userPort);
const AMOUNT = BigInt(process.argv[2] || '1000000');
const XAH = (d) => `${(Number(d) / 1e6).toFixed(6)} XAH`;
const { say, sleep } = L;
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const tracer = new Tracer();

async function writeTrace() {
  await tracer.analyse();
  const head = [
    `ILP/STREAM packet trace through the Everlink cluster on Xahau ${net}, ${new Date().toISOString()}`,
    `cluster account ${tenant.address}; nodes ${nodes.map((n) => `${n.domain}:${n.userPort}`).join(', ')}`,
    'Every line is a real ILP packet (RFC 27) as seen by the two peers\' plugins, with the STREAM frames inside decrypted (RFC 29).',
    '',
  ].join('\n');
  const text = head + tracer.render();
  fs.writeFileSync(path.join(outDir, 'stream-trace.txt'), text);
  fs.writeFileSync(path.join(outDir, 'stream-trace.json'), JSON.stringify({ network: net, cluster: tenant.address, nodes: nodes.map((n) => `${n.domain}:${n.userPort}`), at: new Date().toISOString(), summary: tracer.summary(), packets: tracer.entries }, (k, v) => (typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? v.toString('hex') : v), 2));
  return text;
}

async function main() {
  const master = tenant.address;
  say(`cluster of ${nodes.length} nodes; account ${master}; Xahau ${tenant.server}; tracing a ${XAH(AMOUNT)} STREAM payment`);
  const client = await L.connect(tenant.server);
  const peersFile = path.join(__dirname, `peers.${net}.json`);
  let aliceX; let bobX;
  if (net === 'mainnet') {
    const peers = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
    const kp = require('ripple-keypairs');
    const load = async (p, name, min) => { const bal = await L.xahBalance(client, p.address); if (bal < min) throw new Error(`${name} ${p.address} needs at least ${min} XAH (has ${bal})`); const pair = kp.deriveKeypair(p.seed); return { ...p, publicKey: pair.publicKey, privateKey: pair.privateKey, xah: bal }; };
    aliceX = await load(peers.alice, 'alice', Number(AMOUNT) / 1e6 + 2.4); bobX = await load(peers.bob, 'bob', 1.2);
  } else {
    aliceX = await L.faucetAccount(client, tenant.server); bobX = await L.faucetAccount(client, tenant.server);
  }
  const aliceWallet = L.xrpl.Wallet.fromSeed(aliceX.seed, { algorithm: 'ecdsa-secp256k1' });
  if (aliceWallet.classicAddress !== aliceX.address) throw new Error(`wallet address ${aliceWallet.classicAddress} != ${aliceX.address}`);
  say(`Alice ${aliceX.address} (${aliceX.xah} XAH), Bob ${bobX.address} (${bobX.xah} XAH), cluster account ${XAH(await L.xahBalance(client, master) * 1e6)}`);

  // Peers with persistent HotPocket identities on mainnet, as in the demo.
  const factory = hotPocketClientFactory();
  const hex = (u) => Buffer.from(u).toString('hex');
  const mk = async (node, name) => {
    let keys;
    if (net === 'mainnet') {
      const peers = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
      if (peers[name].hp && peers[name].hp.privateKey) keys = await HotPocket.generateKeys(peers[name].hp.privateKey);
      else { keys = await HotPocket.generateKeys(); peers[name].hp = { privateKey: hex(keys.privateKey), publicKey: hex(keys.publicKey) }; fs.writeFileSync(peersFile, JSON.stringify(peers, null, 2)); }
    } else keys = await HotPocket.generateKeys();
    const plugin = new HotPocketPlugin({ keys, servers: [`wss://${node.domain}:${node.userPort}`], createClient: factory, log: (...a) => say(`plugin[${name}]:`, ...a) });
    plugin.on('connector_error', (m) => say(`[${name}] connector says:`, JSON.stringify(m)));
    plugin.on('payout', (m) => say(`[${name}] payout ${m.status}: ${XAH(m.amt)} ${m.tx || ''} ${m.reason || ''}`));
    return tracer.wrap(plugin, name);
  };
  const alice = await mk(nodes[0], 'alice'); const bob = await mk(nodes[1 % nodes.length], 'bob');
  await alice.connect(); await bob.connect();
  const info = await alice.getInfo();
  say('connector info:', JSON.stringify({ address: info.connectorAddress, master: info.masterAddress, feeBps: info.feeBps, rounds: info.rounds, stats: info.stats }));
  say(`Alice's ILP address: ${info.connectorAddress}.${alice.publicKey}; Bob's: ${info.connectorAddress}.${bob.publicKey}`);

  // Funding: a channel of amount + 1 XAH and a claim of exactly `amount` (unless credit is left over).
  let credit = BigInt((await alice.getBalance()).balance || 0);
  let channelId = null;
  if (credit < AMOUNT) {
    const chanDrops = AMOUNT + 1_000_000n;
    say(`Alice opens a ${XAH(chanDrops)} payment channel to the cluster account ...`);
    const c = await L.createChannel(client, aliceWallet, master, Number(chanDrops), 3600);
    channelId = c.channelId;
    say(`channel ${channelId} (tx ${c.hash})`);
    say('waiting for the cluster to see the channel, then claiming ...');
    let ack = null;
    for (let i = 0; i < 12 && !(ack && ack.ok); i++) {
      if (i) await sleep(10000);
      ack = await alice.sendClaim({ channel: channelId, amount: Number(AMOUNT), privateKey: aliceX.privateKey });
      say(`claim attempt ${i + 1}: ${ack.ok ? 'accepted' : ack.reason}`);
    }
    if (!ack || !ack.ok) throw new Error('claim never accepted: ' + JSON.stringify(ack));
    credit = BigInt((await alice.getBalance()).balance);
  }
  say(`Alice's connector credit: ${XAH(credit)}`);
  await bob.setPayoutAddress(bobX.address);

  // The payment. The receiver's shared secret is kept so the trace can decrypt the STREAM frames.
  const server = await createServer({ plugin: bob });
  let received = 0n;
  server.on('connection', (conn) => conn.on('stream', (s) => { s.setReceiveMax('100000000'); s.on('money', (a) => { received += BigInt(a); }); }));
  const { destinationAccount, sharedSecret } = server.generateAddressAndSecret();
  await tracer.useSharedSecret(sharedSecret);
  say(`Bob's STREAM destination: ${destinationAccount}`);
  const t0 = Date.now();
  const conn = await createConnection({ plugin: alice, destinationAccount, sharedSecret, slippage: 0.02 });
  say(`STREAM connection established in ${Date.now() - t0} ms`);
  const stream = conn.createStream();
  const t1 = Date.now();
  stream.setSendMax(AMOUNT.toString());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stalled: sent ${stream.totalSent}`)), 240000);
    stream.on('outgoing_money', (a) => { say(`  packet fulfilled: +${XAH(a)}`); if (BigInt(stream.totalSent) >= AMOUNT) { clearTimeout(timer); resolve(); } });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  say(`Alice paid Bob ${XAH(stream.totalSent)} in ${Date.now() - t1} ms; Bob received ${XAH(received)}`);
  try { await server.close(); } catch (e) { say('note: server close:', e.message); }
  try { await conn.end(); } catch (e) { say('note: connection end:', e.message); }
  await sleep(4000); // let the close packets' replies land in the trace

  console.log('\n' + await writeTrace());
  say(`trace written to ${path.join(outDir, 'stream-trace.txt')} and stream-trace.json`);

  // Settlement, for completeness: Bob's payout (0.5 XAH threshold) and Alice's channel close.
  say('watching Xahau for Bob\'s payout ...');
  const bobBefore = bobX.xah; let bobNow = bobBefore;
  for (let i = 0; i < 12 && !(bobNow > bobBefore); i++) { await sleep(10000); bobNow = await L.xahBalance(client, bobX.address); say(`  t+${(i + 1) * 10}s: Bob on-ledger ${bobNow} XAH (was ${bobBefore})`); }
  if (channelId) {
    say('Alice asks to close her channel ...');
    await L.submit(client, aliceWallet, { TransactionType: 'PaymentChannelClaim', Account: aliceWallet.classicAddress, Channel: channelId, Flags: 0x00020000 });
    let closed = false;
    for (let i = 0; i < 12 && !closed; i++) { await sleep(10000); closed = (await L.accountChannels(client, aliceX.address, master)).length === 0; say(`  t+${(i + 1) * 10}s: channel ${closed ? 'closed' : 'still open'}`); }
    say(`Alice on-ledger ${await L.xahBalance(client, aliceX.address)} XAH`);
  }
  await alice.disconnect(); await bob.disconnect(); await client.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  say('FAILED', e && e.stack ? e.stack : e);
  if (tracer.entries.length) { try { console.log('\n' + await writeTrace()); } catch (e2) { say('could not write the trace:', e2.message); } }
  process.exit(1);
});
