'use strict';

// Minimal NPL "election" helper, in the spirit of everpocket's VoteContext but with no
// dependencies, used by the simulator bridge (the production bridge uses everpocket's
// VoteContext so that it shares the single NPL consumer with the Xrpl/Evernode contexts).
//
// Every node broadcasts {e: election, d: data}; vote() resolves with all votes received
// for that election once `expected` arrived or `timeoutMs` elapsed. Callers must reduce
// the result deterministically (majority, min, max...) — never "first received".

const crypto = require('crypto');

const buses = new WeakMap();

class NplBus {
  constructor(ctx) {
    this.ctx = ctx;
    this.elections = new Map(); // name -> { votes: [], waiters: [] }
    ctx.unl.onMessage((node, msg) => {
      let parsed;
      try { parsed = JSON.parse(msg.toString()); } catch (e) { return; }
      if (!parsed || typeof parsed.e !== 'string') return;
      const el = this.election(parsed.e);
      el.votes.push({ sender: node.publicKey, data: parsed.d });
      for (const w of el.waiters) w();
    });
  }
  election(name) {
    if (!this.elections.has(name)) this.elections.set(name, { votes: [], waiters: [] });
    return this.elections.get(name);
  }
  async vote(name, data, { expected, timeoutMs }) {
    const el = this.election(name);
    await this.ctx.unl.send(JSON.stringify({ e: name, d: data }));
    await new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); resolve(); }
      const check = () => { if (el.votes.length >= expected) done(); };
      el.waiters.push(check);
      check();
    });
    return el.votes.slice();
  }
}

function busFor(ctx) {
  if (!buses.has(ctx)) buses.set(ctx, new NplBus(ctx));
  return buses.get(ctx);
}

function digest(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

// Pick the value most nodes voted for; ties broken by digest order so every node agrees.
function majority(votes) {
  const tally = new Map();
  for (const v of votes) {
    const d = digest(v.data);
    const t = tally.get(d) || { count: 0, value: v.data };
    t.count += 1; tally.set(d, t);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  return ranked.length ? ranked[0][1].value : null;
}

module.exports = { busFor, majority, digest };
