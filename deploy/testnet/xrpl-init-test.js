#!/usr/bin/env node
'use strict';
// Reproduces the contract's ledger initialisation outside HotPocket: everpocket XrplContext
// init (the step that never completes inside the cluster) with a fake HotPocket context, a
// 1 s ticker that shows whether the event loop is alive, and a hard exit after 60 s.
//   node deploy/testnet/xrpl-init-test.js [network] [server] [address]
const t0 = Date.now();
const say = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)} ms`, ...a);
const network = process.argv[2] || 'mainnet';
const server = process.argv[3] || 'wss://xahau.network';
const address = process.argv[4] || 'r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC';

const ticker = setInterval(() => say('tick (event loop alive)'), 1000);
setTimeout(() => { say('GIVING UP after 60 s'); process.exit(9); }, 60000).unref();
process.on('exit', (c) => say(`exit ${c}`));
process.on('uncaughtException', (e) => { say('UNCAUGHT', e && e.stack ? e.stack : e); process.exit(4); });
process.on('unhandledRejection', (e) => { say('UNHANDLED', e && e.stack ? e.stack : e); process.exit(5); });

(async () => {
  say(`node ${process.version}; network ${network}; server ${server}; account ${address}`);
  const evernode = require('evernode-js-client');
  say('evernode-js-client loaded');
  const evp = require('everpocket-nodejs-contract');
  say('everpocket loaded');
  const same = (() => { try { return require.resolve('evernode-js-client') === require.resolve('evernode-js-client', { paths: [require.resolve('everpocket-nodejs-contract')] }); } catch (e) { return `? ${e.message}`; } })();
  say(`everpocket shares our evernode-js-client instance: ${same}`);

  // Same offline patch as the bridge.
  const original = evernode.Defaults.useNetwork.bind(evernode.Defaults);
  const defs = { mainnet: { governorAddress: 'rBvKgF3jSZWdJcwSsmoJspoXLLDVLDp6jg', rippledServer: 'wss://xahau.network', stateIndexId: 'evernodeprod', networkID: 21337 } };
  evernode.Defaults.useNetwork = async (n) => { if (defs[n]) evernode.Defaults.set(defs[n]); else await original(n); };

  const ctx = {
    readonly: false, publicKey: 'ed00', contractId: 'test', lclSeqNo: 1, lclHash: '0000', timestamp: Date.now(),
    unl: { onMessage() {}, send: async () => {}, list: () => [], count: () => 0 }, users: { list: () => [] },
  };
  const voteContext = new evp.VoteContext(ctx);
  const hpContext = new evp.HotPocketContext(ctx, { voteContext });
  say('contexts built');
  const xrplContext = new evp.XrplContext(hpContext, address, null, { network, rippleServer: server });
  say('XrplContext constructed (transactions.json written in cwd)');

  say('XrplContext.init() ...');
  await xrplContext.init();
  say(`init done: ledger ${xrplContext.xrplApi.ledgerIndex}, signers ${xrplContext.signerListInfo ? xrplContext.signerListInfo.signerList.length : 0}`);
  const info = await xrplContext.xrplAcc.getInfo();
  say(`account_info balance ${info.Balance}`);
  const objs = await xrplContext.xrplAcc.getAccountObjects({ type: 'payment_channel' });
  say(`payment channels: ${objs.length}`);
  const lines = await xrplContext.xrplAcc.getTrustLines('EVR', 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8');
  say(`EVR line: ${lines.length ? lines[0].balance : 'none'}`);
  await xrplContext.deinit();
  say('deinit done');
  clearInterval(ticker);
  process.exit(0);
})().catch((e) => { say('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
