'use strict';

// runRound's safety net around the bridge: a ledger observation or Nomad housekeeping that
// never returns is abandoned, the round still completes (no facts), and the per-node
// diagnostics file records it; {"t":"diag"} reads it back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runRound } = require('../contract/src/round');
const { makeConfig } = require('../contract/src/core/connector');

function fakeCtx({ readonly = false, lclSeqNo = 1, inputs = [] } = {}) {
  const sent = [];
  const user = { publicKey: 'aa'.repeat(32), inputs, send: async (m) => sent.push(typeof m === 'string' ? JSON.parse(m) : m) };
  return {
    ctx: {
      readonly, lclSeqNo, timestamp: 1_700_000_000_000,
      users: { list: () => [user], read: async (i) => Buffer.from(i), find: (pk) => (pk === user.publicKey ? user : null) },
      unl: { onMessage() {}, list: () => [] },
    },
    sent,
  };
}

test('a hanging observe/afterRound is abandoned and recorded; diag read request returns it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-round-'));
  const diagFile = path.join(dir, 'nomad-diag.json');
  const config = makeConfig({ masterAddress: 'rMaster' });
  const never = () => new Promise(() => {});
  const bridge = { observe: never, submit: async () => [], afterRound: never };
  const t0 = Date.now();
  const { ctx } = fakeCtx({ lclSeqNo: 3 });
  await runRound(ctx, { stateDir: dir, config, bridge, diagFile, timeouts: { observe: 100, after: 100 } });
  assert.ok(Date.now() - t0 < 2000, 'round completed despite the hanging bridge');
  const d = JSON.parse(fs.readFileSync(diagFile, 'utf8'));
  assert.equal(d.rounds.length, 1);
  assert.equal(d.last.lcl, 3);
  assert.equal(d.last.facts, null);
  assert.ok(d.last.errors.some((e) => e.startsWith('observe: observe: abandoned')), JSON.stringify(d.last.errors));
  assert.ok(d.last.errors.some((e) => e.startsWith('afterRound:')));
  assert.ok(d.last.phases.observe >= 100 && d.last.phases.after >= 100);

  const ro = fakeCtx({ readonly: true, inputs: [JSON.stringify({ t: 'diag' })] });
  await runRound(ro.ctx, { stateDir: dir, config, bridge, diagFile });
  assert.equal(ro.sent[0].t, 'diag');
  assert.equal(ro.sent[0].last.lcl, 3);
  assert.equal(ro.sent[0].state.rounds, 1);
  // other read requests still go to the core
  const ro2 = fakeCtx({ readonly: true, inputs: [JSON.stringify({ t: 'info' })] });
  await runRound(ro2.ctx, { stateDir: dir, config, bridge, diagFile });
  assert.equal(ro2.sent[0].t, 'info');
});
