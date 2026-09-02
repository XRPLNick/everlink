'use strict';

// Glue between a HotPocket contract context (real, or the in-process simulator — both
// expose the same shape as hotpocket-nodejs-contract) and the deterministic core.
//
// Order of a round:
//   1. read the agreed user inputs (users sorted by public key, inputs in submission order)
//   2. bridge.observe(): the cluster's agreed view of the Xahau ledger, if any this round
//   3. processRound(): pure state transition -> outputs + intents
//   4. bridge.submit(): multisign & submit the intents (everpocket votes on the result)
//   5. deliver outputs to connected users, persist state
//
// A `bridge` is { observe(ctx, state) -> facts|null, submit(ctx, intents) -> results, afterRound?(ctx, state) }.

const { processRound, handleReadRequest } = require('./core/connector');
const stateStore = require('./core/state');

async function collectInputs(ctx, bridge = null) {
  const users = ctx.users.list().slice().sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0));
  const inputs = [];
  for (const user of users) {
    for (const input of user.inputs || []) {
      const raw = await ctx.users.read(input);
      // Cluster-management messages (everpocket) share the user channel; let the bridge take them.
      if (bridge && bridge.consumeInput && await bridge.consumeInput(ctx, user, raw)) continue;
      inputs.push({ peer: user.publicKey, raw });
    }
  }
  return { users, inputs };
}

async function runRound(ctx, { stateDir, config, bridge = null, logger = null }) {
  const log = (...a) => logger && logger(...a);
  const state = stateStore.load(stateDir);

  if (ctx.readonly) {
    // Read requests: answer from the current state, never mutate, never persist.
    for (const user of ctx.users.list()) {
      for (const input of user.inputs || []) {
        const raw = await ctx.users.read(input);
        await user.send(handleReadRequest(state, config, user.publicKey, raw));
      }
    }
    return { state, outputs: [], intents: [] };
  }

  const { users, inputs } = await collectInputs(ctx, bridge);
  const connected = new Set(users.map((u) => u.publicKey));

  let facts = null;
  if (bridge) {
    try { facts = await bridge.observe(ctx, state); } catch (e) { log('observe failed', e && e.message ? e.message : e); }
  }

  const rc = processRound(state, config, {
    timestamp: ctx.timestamp, lclSeqNo: ctx.lclSeqNo, connected, inputs, facts,
  });

  if (rc.intents.length && bridge) {
    let results = [];
    try { results = await bridge.submit(ctx, rc.intents); } catch (e) {
      log('submit failed', e && e.message ? e.message : e);
      results = rc.intents.map((i) => ({ id: i.id, ok: false, error: String(e && e.message ? e.message : e) }));
    }
    rc.applyIntentResults(results);
  }

  for (const { peer, msg } of rc.outputs) {
    const user = ctx.users.find(peer);
    if (user) await user.send(msg); // disconnected peers simply miss the output
  }
  for (const line of rc.log) log(line);

  stateStore.save(stateDir, state);
  if (bridge && bridge.afterRound) {
    try { await bridge.afterRound(ctx, state); } catch (e) { log('afterRound failed', e && e.message ? e.message : e); }
  }
  return { state, outputs: rc.outputs, intents: rc.intents };
}

module.exports = { runRound, collectInputs };
