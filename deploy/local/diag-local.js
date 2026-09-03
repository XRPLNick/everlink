#!/usr/bin/env node
'use strict';
// Asks each local hpdevkit node for the contract's diagnostics ({"t":"diag"}) and prints the
// last round summaries and progress marks. Read-only.
const HotPocket = require('hotpocket-js-client');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: timeout after ${ms} ms`); })]);
(async () => {
  for (const port of [8081, 8082, 8083]) {
    const keys = await HotPocket.generateKeys();
    const client = await HotPocket.createClient([`wss://localhost:${port}`], keys, { requiredConnectionCount: 1, connectionTimeoutMs: 8000 });
    try {
      if (!(await withTimeout(client.connect(), 15000, 'connect'))) { say(`node ${port}: connect failed`); continue; }
      const st = await withTimeout(client.getStatus(), 8000, 'status');
      const raw = await withTimeout(client.submitContractReadRequest(JSON.stringify({ t: 'diag', probe: true, ledger: true })), 60000, 'diag');
      const d = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : JSON.parse(Buffer.from(raw).toString('utf8'));
      say(`node ${port}: hp ${st.hpVersion} ledger ${st.ledgerSeqNo} vote ${st.voteStatus} unl ${st.currentUnl.length}; state rounds ${d.state && d.state.rounds}`);
      say(`  rounds: ${(d.rounds || []).map((r) => `${r.lcl}:${r.totalMs}ms${r.facts ? '*' : ''}${r.errors.length ? '!' : ''}`).join(' ')}`);
      if (d.last) say(`  last: lcl ${d.last.lcl} ${JSON.stringify(d.last.phases)} facts ${JSON.stringify(d.last.facts)} errors ${JSON.stringify(d.last.errors)}`);
      if (d.ledger) say(`  ledger probe: ${JSON.stringify(d.ledger)}`);
      if (d.patch) say(`  patch: ${JSON.stringify(d.patch)}`);
      for (const e of (d.events || []).slice(-30)) say(`    ${e}`);
    } catch (e) { say(`node ${port}: ${e.message}`); }
    finally { await client.close().catch(() => {}); }
  }
  process.exit(0);
})();
