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
//
// Diagnostics: with `diagFile` set (index.js points it outside the consensus state directory)
// every round appends its timings, facts summary, intents, results and errors to that per-node
// file, and the read request {"t":"diag"} returns it, optionally with connectivity probes
// ({"t":"diag","probe":true}). Per node, never part of consensus.

const fs = require('fs');
const dns = require('dns');
const net = require('net');
const path = require('path');
const { processRound, handleReadRequest } = require('./core/connector');
const stateStore = require('./core/state');

// A node that cannot reach the ledger must not hold up the round: observations and the Nomad
// housekeeping are abandoned after these limits (the core then sees no facts this round).
// Submissions are never abandoned mid-way (a payout that did go out must not be recorded as failed).
const OBSERVE_TIMEOUT_MS = 25000;
const AFTER_TIMEOUT_MS = 30000;
const DIAG_KEEP = 8;

function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: abandoned after ${ms} ms`)), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// Append-only progress marks (one line each) so a hung round can be located from another
// process: {"t":"diag"} returns the tail of this file too.
// HotPocket runs read requests from a read-only view of the state, so the marks are written
// wherever they can be (next to the diag file, and /tmp as a fallback shared by every
// execution in the instance) and read back from all of those places.
function eventFiles(file) {
  const base = file.replace(/\.json$/, '') + '-events.log';
  return [base, path.join(require('os').tmpdir(), 'nomad-diag-events.log')];
}
function diagMark(file, text) {
  if (!file) return;
  const line = `${new Date().toISOString()} pid ${process.pid} ${text}\n`;
  for (const f of eventFiles(file)) { try { fs.appendFileSync(f, line); } catch (e) { /* best effort */ } }
}
function diagEvents(file) {
  const seen = new Set(); const out = [];
  for (const f of eventFiles(file)) {
    try { for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) if (l && !seen.has(l)) { seen.add(l); out.push(l); } } catch (e) { /* absent */ }
  }
  return out.sort().slice(-60);
}

function diagLoad(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { rounds: [] }; }
}
function diagSave(file, d) {
  try { fs.writeFileSync(file, JSON.stringify(d, null, 1)); } catch (e) { /* diagnostics are best effort */ }
}

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

// Outbound connectivity as seen from this node (read requests only): name resolution and TCP
// reachability of the ledger, GitHub (evernode definitions) and the other cluster nodes' peer ports.
async function probeConnectivity(stateDir, targets = []) {
  const tcp = (host, port) => new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(`${r} ${Date.now() - t0}ms`); };
    s.setTimeout(4000, () => done('timeout'));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code || 'error'));
  });
  const list = [['xahau.network', 443], ['raw.githubusercontent.com', 443], ...targets];
  try {
    const cluster = JSON.parse(fs.readFileSync(path.join(stateDir, 'cluster.json'), 'utf8'));
    for (const n of cluster.nodes || []) if (n.domain && n.peerPort) list.push([n.domain, n.peerPort]);
  } catch (e) { /* no cluster.json (local run) */ }
  const out = {};
  await Promise.all(list.map(async ([host, port]) => {
    let ip = null;
    try { ip = (await dns.promises.lookup(host)).address; } catch (e) { ip = `dns ${e.code || e.message}`; }
    out[`${host}:${port}`] = `${ip} ${await tcp(host, port)}`;
  }));
  return out;
}

async function runRound(ctx, { stateDir, config, bridge = null, logger = null, diagFile = null, timeouts = {} }) {
  const observeTimeout = timeouts.observe || OBSERVE_TIMEOUT_MS;
  const afterTimeout = timeouts.after || AFTER_TIMEOUT_MS;
  const log = (...a) => logger && logger(...a);
  const state = stateStore.load(stateDir);

  if (ctx.readonly) {
    // Read requests: answer from the current state, never mutate, never persist.
    for (const user of ctx.users.list()) {
      for (const input of user.inputs || []) {
        const raw = await ctx.users.read(input);
        let req = null;
        try { req = JSON.parse(raw.toString()); } catch (e) { req = null; }
        if (req && req.t === 'diag') {
          const d = diagFile ? diagLoad(diagFile) : { rounds: [] };
          d.now = new Date().toISOString();
          d.state = { rounds: state.rounds, lastLcl: state.lastLcl, peers: Object.keys(state.peers || {}).length, channels: Object.keys(state.channels || {}).length, payouts: Object.keys(state.payouts || {}).length, treasury: state.treasury };
          if (req.probe) d.probe = await probeConnectivity(stateDir);
          if (req.ledger && bridge && bridge.probeLedger) d.ledger = await bridge.probeLedger().catch((e) => ({ error: String(e && e.message ? e.message : e) }));
          if (diagFile) d.events = diagEvents(diagFile);
          d.process = { node: process.version, pid: process.pid, rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(process.uptime()), cwd: process.cwd(), uid: typeof process.getuid === 'function' ? process.getuid() : null };
          try { d.dirs = { state: fs.readdirSync(stateDir).slice(0, 40), parent: fs.readdirSync(path.join(stateDir, '..')).slice(0, 40), tmp: fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('nomad')) }; } catch (e) { d.dirs = { error: e.message }; }
          try { const patch = JSON.parse(fs.readFileSync(fs.existsSync(path.join(stateDir, '..', 'patch.cfg')) ? path.join(stateDir, '..', 'patch.cfg') : path.join(stateDir, 'patch.cfg'), 'utf8')); d.patch = { consensus: patch.consensus, round_limits: patch.round_limits, npl: patch.npl, unl: (patch.unl || []).length, version: patch.version }; } catch (e) { d.patch = null; }
          await user.send(JSON.stringify({ t: 'diag', ...d }));
          continue;
        }
        await user.send(handleReadRequest(state, config, user.publicKey, raw));
      }
    }
    return { state, outputs: [], intents: [] };
  }

  const diag = { lcl: ctx.lclSeqNo, ts: ctx.timestamp, startedAt: new Date().toISOString(), phases: {}, errors: [] };
  const clock = () => Date.now();
  const mark = (text) => diagMark(diagFile, `lcl ${ctx.lclSeqNo} ${text}`);
  mark('round start');
  let t = clock();
  const { users, inputs } = await collectInputs(ctx, bridge);
  mark(`inputs collected: ${inputs.length} from ${users.length} users`);
  const connected = new Set(users.map((u) => u.publicKey));
  diag.inputs = inputs.length; diag.connected = connected.size; diag.phases.inputs = clock() - t;

  let facts = null;
  if (bridge) {
    t = clock();
    mark('observe start');
    try { facts = await withTimeout(bridge.observe(ctx, state), observeTimeout, 'observe'); } catch (e) {
      const msg = String(e && e.message ? e.message : e); log('observe failed', msg); diag.errors.push(`observe: ${msg}`);
    }
    diag.phases.observe = clock() - t;
    diag.facts = facts ? { ledgerIndex: facts.ledgerIndex, masterBalance: facts.masterBalance, evrBalance: facts.evrBalance, channels: (facts.channels || []).length, validated: (facts.validatedTxs || []).length, failed: (facts.failedTxs || []).length } : null;
  }

  mark(`observe done: ${facts ? 'facts' : 'no facts'}`);
  t = clock();
  const rc = processRound(state, config, {
    timestamp: ctx.timestamp, lclSeqNo: ctx.lclSeqNo, connected, inputs, facts,
  });
  diag.phases.core = clock() - t;
  mark(`core done: ${rc.intents.length} intents, ${rc.outputs.length} outputs`);
  diag.intents = rc.intents.map((i) => `${i.kind || i.tx.TransactionType}:${i.id}`);

  if (rc.intents.length && bridge) {
    t = clock();
    let results = [];
    try { results = await bridge.submit(ctx, rc.intents); } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      log('submit failed', msg); diag.errors.push(`submit: ${msg}`);
      results = rc.intents.map((i) => ({ id: i.id, ok: false, error: msg }));
    }
    rc.applyIntentResults(results);
    diag.phases.submit = clock() - t;
    diag.results = results;
    mark(`submit done: ${JSON.stringify(results)}`);
  }

  for (const { peer, msg } of rc.outputs) {
    const user = ctx.users.find(peer);
    if (user) await user.send(msg); // disconnected peers simply miss the output
  }
  for (const line of rc.log) log(line);
  diag.outputs = rc.outputs.length; diag.log = rc.log.slice(-5);

  stateStore.save(stateDir, state);
  mark('outputs sent, state saved');
  if (bridge && bridge.afterRound) {
    t = clock();
    try { await withTimeout(bridge.afterRound(ctx, state), afterTimeout, 'afterRound'); } catch (e) {
      const msg = String(e && e.message ? e.message : e); log('afterRound failed', msg); diag.errors.push(`afterRound: ${msg}`);
    }
    diag.phases.after = clock() - t;
  }
  diag.finishedAt = new Date().toISOString();
  diag.totalMs = Object.values(diag.phases).reduce((a, b) => a + b, 0);
  mark(`round done in ${diag.totalMs} ms${diag.errors.length ? ' errors: ' + diag.errors.join(' | ') : ''}`);
  if (diagFile) {
    const d = diagLoad(diagFile);
    d.rounds = (d.rounds || []).concat([diag]).slice(-DIAG_KEEP);
    d.last = diag;
    diagSave(diagFile, d);
  }
  return { state, outputs: rc.outputs, intents: rc.intents };
}

module.exports = { runRound, collectInputs, probeConnectivity, diagMark };
