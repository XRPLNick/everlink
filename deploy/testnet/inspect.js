#!/usr/bin/env node
'use strict';
// Diagnostics for the EVR gift: what has the testnet foundation account been doing lately,
// and did our gift request land? Prints the last transactions with decoded memos.
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenant.json')));
const hex2s = (h) => { try { return Buffer.from(h, 'hex').toString('utf8'); } catch (e) { return h; } };
const fmtAmt = (a) => (typeof a === 'string' ? `${Number(a) / 1e6} XAH` : a ? `${a.value} ${a.currency}.${String(a.issuer).slice(0, 6)}` : '');
(async () => {
  const client = await L.connect(tenant.server);
  for (const [label, account] of [['foundation', tenant.foundation], ['tenant', tenant.address], ['evr issuer', tenant.evrIssuer]]) {
    console.log(`\n== ${label} ${account}`);
    const res = await client.request({ command: 'account_tx', account, limit: 40, forward: false }).catch((e) => ({ result: { transactions: [], error: e.message } }));
    if (res.result.error) console.log('  error', res.result.error);
    for (const t of res.result.transactions || []) {
      const tx = t.tx || t.tx_json || {};
      const memos = (tx.Memos || []).map((m) => `${hex2s(m.Memo.MemoType || '')}${m.Memo.MemoData ? '=' + hex2s(m.Memo.MemoData).slice(0, 40) : ''}`).join('|');
      const delivered = t.meta && t.meta.delivered_amount;
      console.log(`  ${new Date((tx.date + 946684800) * 1000).toISOString().slice(0, 19)} ${String(tx.TransactionType).padEnd(14)} ${String(tx.Account).slice(0, 10)}→${String(tx.Destination || '').slice(0, 10)} ${fmtAmt(delivered || tx.Amount)} ${memos ? 'memo:' + memos : ''} ${t.meta && t.meta.TransactionResult}`);
    }
  }
  await client.disconnect();
  process.exit(0);
})().catch((e) => { console.log('FAILED', e && e.stack ? e.stack : e); process.exit(1); });
