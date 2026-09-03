'use strict';

// An in-process HotPocket simulator: N contract instances, one consensus round at a time,
// each instance given a context object with the same shape hotpocket-nodejs-contract
// builds (users / inputs / outputs / unl / NPL / lcl / timestamp / readonly). After every
// round the simulator hashes each node's state directory and refuses to continue if the
// nodes disagree — the same property real HotPocket enforces by consensus. Outputs are
// likewise compared across nodes before they are delivered to users.
//
// This is not a consensus engine (no proposals, no voting on inputs); it is a harness
// that lets the *unchanged* contract handler be exercised as a cluster without Docker.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const events = Object.freeze({ contractOutput: 'contract_output', disconnect: 'disconnect' });

function edKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { publicKey: `ed${pub.toString('hex')}`, privateKey: `ed${Buffer.concat([priv, pub]).toString('hex')}` };
}

function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, `${rel}${name}/`);
      else { h.update(`${rel}${name}\0`); h.update(fs.readFileSync(full)); h.update('\0'); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name); const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

class SimUser {
  constructor(publicKey, channel, inputs) {
    this.publicKey = publicKey;
    this.inputs = inputs;
    this._channel = channel;
  }
  async send(msg) {
    const text = Buffer.isBuffer(msg) ? msg.toString() : (typeof msg === 'string' ? msg : JSON.stringify(msg));
    this._channel.push(text);
  }
}

class SimUsers {
  constructor(buffer, usersObj) {
    this._buffer = buffer;
    this._users = {};
    for (const [pub, { inputs, outbox }] of Object.entries(usersObj)) this._users[pub] = new SimUser(pub, outbox, inputs);
  }
  find(pub) { return this._users[pub]; }
  list() { return Object.values(this._users); }
  count() { return Object.keys(this._users).length; }
  async read([offset, size]) { return Buffer.from(this._buffer.subarray(offset, offset + size)); }
}

class SimUnl {
  constructor(node, bus, readonly) {
    this._node = node; this._bus = bus; this._readonly = readonly;
    this.nodes = {};
    if (!readonly) for (const n of bus.nodes) this.nodes[n.publicKey] = { publicKey: n.publicKey, activeOn: 0 };
    this._consumed = false;
  }
  find(pub) { return this.nodes[pub]; }
  list() { return Object.values(this.nodes); }
  count() { return Object.keys(this.nodes).length; }
  onMessage(cb) {
    if (this._readonly) throw new Error('NPL messages not available in readonly mode.');
    if (this._consumed) throw new Error('NPL channel already consumed.');
    this._consumed = true;
    this._bus.subscribe(this._node.publicKey, cb);
  }
  async send(msg) {
    if (this._readonly) throw new Error('NPL messages not available in readonly mode.');
    this._bus.broadcast(this._node.publicKey, Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg)));
  }
}

// Node-party-line for one round: delivers every broadcast to every node (self included),
// asynchronously. Like the real NPL pipe, messages that arrive before a node has started
// listening are queued and delivered as soon as it does.
class NplBus {
  constructor(nodes) { this.nodes = nodes; this._subs = new Map(); this._queues = new Map(); }
  subscribe(pub, cb) {
    this._subs.set(pub, cb);
    const q = this._queues.get(pub) || [];
    this._queues.delete(pub);
    for (const [senderPub, buf] of q) setImmediate(() => cb({ publicKey: senderPub, activeOn: 0 }, Buffer.from(buf)));
  }
  broadcast(senderPub, buf) {
    for (const n of this.nodes) {
      const cb = this._subs.get(n.publicKey);
      if (cb) setImmediate(() => cb({ publicKey: senderPub, activeOn: 0 }, Buffer.from(buf)));
      else {
        if (!this._queues.has(n.publicKey)) this._queues.set(n.publicKey, []);
        this._queues.get(n.publicKey).push([senderPub, Buffer.from(buf)]);
      }
    }
  }
}

class SimCluster extends EventEmitter {
  constructor({ nodeCount = 3, roundTimeMs = 50, contractId = 'everlink-sim', handler, baseDir = null, clock = () => Date.now() } = {}) {
    super();
    if (typeof handler !== 'function') throw new Error('handler(ctx) required');
    this.handler = handler;
    this.roundTimeMs = roundTimeMs;
    this.contractId = contractId;
    this.clock = clock;
    this.baseDir = baseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hp-sim-'));
    this.nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      const keys = edKeys();
      const stateDir = path.join(this.baseDir, `node${i}`, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      this.nodes.push({ index: i, ...keys, stateDir });
    }
    this.lclSeqNo = 0;
    this.lclHash = '0'.repeat(64);
    this.users = new Map(); // pub -> { queue: [], emitter, connected }
    this._timer = null;
    this._running = false;
    this._roundInProgress = null;
    this.forked = false;
  }

  // ---- users -----------------------------------------------------------------------
  connectUser(pub, emitter) { this.users.set(pub, { queue: [], emitter, connected: true }); }
  disconnectUser(pub) { this.users.delete(pub); }
  queueInput(pub, text) {
    const u = this.users.get(pub);
    if (!u) throw new Error('user not connected');
    return new Promise((resolve) => u.queue.push({ text, resolve }));
  }

  // ---- lifecycle -------------------------------------------------------------------
  start() {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try { await this.runRound(); } catch (e) { this.emit('error', e); this._running = false; return; }
      if (this._running) this._timer = setTimeout(tick, this.roundTimeMs);
    };
    this._timer = setTimeout(tick, this.roundTimeMs);
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this._roundInProgress) await this._roundInProgress;
  }

  // ---- one consensus round -----------------------------------------------------------
  async runRound() {
    if (this._roundInProgress) return this._roundInProgress;
    this._roundInProgress = this._runRound();
    try { return await this._roundInProgress; } finally { this._roundInProgress = null; }
  }

  async _runRound() {
    const timestamp = this.clock();
    const lclSeqNo = ++this.lclSeqNo;

    // Agree on this round's users and inputs: everything queued up to now.
    const chunks = []; let offset = 0;
    const usersObj = {}; const pending = [];
    for (const [pub, u] of [...this.users.entries()].sort()) {
      const inputs = [];
      for (const item of u.queue.splice(0)) {
        const buf = Buffer.from(item.text);
        inputs.push([offset, buf.length]); chunks.push(buf); offset += buf.length;
        pending.push(item);
      }
      usersObj[pub] = inputs;
    }
    const buffer = Buffer.concat(chunks);

    const bus = new NplBus(this.nodes);
    const perNode = this.nodes.map((node) => {
      const outboxes = {};
      const uo = {};
      for (const [pub, inputs] of Object.entries(usersObj)) { outboxes[pub] = []; uo[pub] = { inputs: inputs.slice(), outbox: outboxes[pub] }; }
      const ctx = {
        contractId: this.contractId, publicKey: node.publicKey, privateKey: node.privateKey,
        readonly: false, timestamp, lclSeqNo, lclHash: this.lclHash,
        users: new SimUsers(buffer, uo), unl: new SimUnl(node, bus, false),
        getConfig: async () => ({ consensus: { roundtime: this.roundTimeMs } }),
        updateConfig: async () => {}, updatePeers: async () => {},
        // simulator extras (not part of HotPocket's API)
        sim: { stateDir: node.stateDir, node: node.index },
      };
      return { node, ctx, outboxes };
    });

    await Promise.all(perNode.map(({ ctx }) => this.handler(ctx)));

    // Consensus check: identical state and identical outputs on every node.
    const hashes = perNode.map(({ node }) => hashDir(node.stateDir));
    const outs = perNode.map(({ outboxes }) => JSON.stringify(outboxes));
    if (new Set(hashes).size !== 1 || new Set(outs).size !== 1) {
      this.forked = true;
      const err = new Error(`nodes diverged at ledger ${lclSeqNo}: states ${JSON.stringify(hashes.map((h) => h.slice(0, 8)))}`);
      err.outputs = outs;
      for (const item of pending) item.resolve({ status: 'rejected', reason: 'consensus failure' });
      throw err;
    }
    this.lclHash = crypto.createHash('sha256').update(this.lclHash).update(hashes[0]).update(outs[0]).digest('hex');
    for (const item of pending) item.resolve({ status: 'accepted', ledgerSeqNo: lclSeqNo, ledgerHash: this.lclHash });

    for (const [pub, outbox] of Object.entries(perNode[0].outboxes)) {
      const u = this.users.get(pub);
      if (u && outbox.length) u.emitter.emit(events.contractOutput, { ledgerSeqNo: lclSeqNo, ledgerHash: this.lclHash, outputs: outbox.slice() });
    }
    this.emit('round', { lclSeqNo, timestamp, inputs: pending.length });
    return { lclSeqNo, timestamp };
  }

  // Read request: run node 0's handler in readonly mode on a throwaway copy of its state.
  async readRequest(pub, text) {
    const node = this.nodes[0];
    const tmp = fs.mkdtempSync(path.join(this.baseDir, 'ro-'));
    const tmpState = path.join(tmp, 'state');
    copyDir(node.stateDir, tmpState);
    const buf = Buffer.from(text);
    const outbox = [];
    const ctx = {
      contractId: this.contractId, publicKey: node.publicKey, privateKey: node.privateKey,
      readonly: true, timestamp: this.clock(), lclSeqNo: undefined, lclHash: undefined,
      users: new SimUsers(buf, { [pub]: { inputs: [[0, buf.length]], outbox } }), unl: new SimUnl(node, new NplBus([]), true),
      getConfig: async () => ({}), updateConfig: async () => {}, updatePeers: async () => {},
      sim: { stateDir: tmpState, node: 0 },
    };
    try { await this.handler(ctx); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return outbox[0] || null;
  }
}

// Mirrors the subset of hotpocket-js-client the plugin uses.
class SimClient extends EventEmitter {
  constructor(cluster, keys) {
    super();
    this.cluster = cluster;
    this.keys = keys || edKeys();
    this.publicKey = this.keys.publicKey;
    this._connected = false;
  }
  async connect() { this.cluster.connectUser(this.publicKey, this); this._connected = true; return true; }
  async close() { if (this._connected) { this.cluster.disconnectUser(this.publicKey); this._connected = false; this.emit(events.disconnect); } }
  isConnected() { return this._connected; }
  async submitContractInput(input, nonce = null) { // nonce accepted for API parity; the simulator orders by arrival
    const text = typeof input === 'string' ? input : input.toString();
    const submissionStatus = this.cluster.queueInput(this.publicKey, text);
    return { hash: crypto.createHash('sha256').update(text).digest('hex'), submissionStatus };
  }
  async submitContractReadRequest(request) {
    return this.cluster.readRequest(this.publicKey, typeof request === 'string' ? request : request.toString());
  }
  clear(event) { this.removeAllListeners(event); }
}

module.exports = { SimCluster, SimClient, events, edKeys, hashDir };
