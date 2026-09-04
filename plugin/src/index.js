'use strict';

// ilp-plugin-hotpocket: an ILP "plugin" (the interface ilp-protocol-stream and friends
// expect: connect/disconnect/isConnected/sendData/registerDataHandler) that talks to a
// Everlink cluster over the HotPocket user channel.
//
// * sendData(prepare)  -> submits {"t":"ilp"} as a contract input and resolves with the
//                         Fulfill/Reject the contract emits for that id (or a locally
//                         generated R00 reject at the packet's expiry).
// * incoming Prepares  -> the contract forwards packets addressed to us as outputs; they
//                         are handed to the registered data handler and its reply is sent
//                         back under the same id.
// * settlement         -> sendClaim() streams signed payment-channel claims to fund our
//                         balance; setPayoutAddress() tells the connector where to pay us.
//
// The HotPocket client is injected (`createClient`) so the same plugin runs against the
// real hotpocket-js-client or the in-process simulator.

const EventEmitter = require('events');
const crypto = require('crypto');
const IlpPacket = require('ilp-packet');
const { signClaim } = require('./claims');

const OUTPUT_EVENT = 'contract_output';
const DEFAULT_TIMEOUT_GRACE_MS = 2000;
const SUBMIT_RETRIES = 20;
const SUBMIT_RETRY_MS = 500;
const REPLY_DRAIN_MS = 3000;

class HotPocketPlugin extends EventEmitter {
  constructor({ createClient, servers, keys, contractId = null, requiredConnectionCount = 1, log = () => {} } = {}) {
    super();
    if (typeof createClient !== 'function') throw new Error('createClient({servers, keys, contractId}) is required');
    this._createClient = createClient;
    this._servers = servers;
    this._keys = keys;
    this._contractId = contractId;
    this._requiredConnectionCount = requiredConnectionCount;
    this._log = log;
    this._client = null;
    this._connected = false;
    this._dataHandler = null;
    this._pending = new Map(); // id -> { resolve, timer }
    this._clientOpen = false;
    this._inflightReplies = 0;
    this._acks = new Map();    // claim channel -> resolve
    this.publicKey = keys && keys.publicKey ? hex(keys.publicKey) : null;
  }

  // ---- ilp-plugin interface ------------------------------------------------------------

  async connect() {
    if (this._connected) return;
    this._client = await this._createClient({
      servers: this._servers, keys: this._keys, contractId: this._contractId, requiredConnectionCount: this._requiredConnectionCount,
    });
    this._client.on(OUTPUT_EVENT, (r) => this._onOutputs(r));
    // Diagnostics only: the real client reconnects on its own and tells us about it.
    if (typeof this._client.on === 'function') {
      this._client.on('connection_change', (server, action) => this._log(`connection ${action}: ${server}`));
      this._client.on('disconnect', () => this._log('client reports it gave up its connections'));
    }
    const ok = await this._client.connect();
    if (ok === false) throw new Error('could not connect to the connector cluster');
    this._connected = true;
    this._clientOpen = true;
    this._inflightReplies = 0;
    this.emit('connect');
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;
    for (const [id, p] of this._pending) { clearTimeout(p.timer); p.resolve(localReject('T00', 'plugin disconnected')); this._pending.delete(id); }
    // STREAM disconnects the plugin from inside its own packet handling (the peer's mirrored
    // ConnectionClose is what triggers it). Let replies that are already being produced go out
    // before the socket closes, otherwise the peer's packet sits at the connector until it
    // is rejected.
    const deadline = Date.now() + REPLY_DRAIN_MS;
    while (this._inflightReplies > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    this._clientOpen = false;
    await this._client.close();
    this.emit('disconnect');
  }

  isConnected() { return this._connected; }

  registerDataHandler(handler) {
    if (this._dataHandler) throw new Error('data handler already registered');
    this._dataHandler = handler;
  }
  deregisterDataHandler() { this._dataHandler = null; }

  // Money handlers exist in the interface for legacy plugins; settlement here is explicit.
  registerMoneyHandler() {}
  deregisterMoneyHandler() {}
  async sendMoney() {}

  async sendData(buffer) {
    if (!this._connected) throw new Error('plugin not connected');
    const pkt = IlpPacket.deserializeIlpPacket(buffer);
    if (pkt.type !== IlpPacket.Type.TYPE_ILP_PREPARE) throw new Error('sendData expects an ILP Prepare');
    const id = crypto.randomBytes(8).toString('hex');
    const reply = new Promise((resolve) => {
      const ttl = Math.max(0, pkt.data.expiresAt.getTime() - Date.now()) + DEFAULT_TIMEOUT_GRACE_MS;
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) resolve(localReject('R00', 'no reply from connector before expiry'));
      }, ttl);
      this._pending.set(id, { resolve, timer });
    });
    await this._submit({ t: 'ilp', id, p: buffer.toString('base64') });
    return reply;
  }

  // ---- settlement helpers --------------------------------------------------------------

  // Send a signed payment-channel claim (cumulative drops). Resolves with the claim_ack.
  async sendClaim({ channel, amount, privateKey, signature }) {
    const sig = signature || signClaim({ channel, amount: String(amount), privateKey });
    const ack = new Promise((resolve) => this._acks.set(`${channel}:${amount}`, resolve));
    await this._submit({ t: 'claim', ch: channel, amt: String(amount), sig });
    return ack;
  }
  async setPayoutAddress(address, tag = null) {
    return this._submit({ t: 'settle_to', addr: address, tag });
  }
  async withdraw() { return this._submit({ t: 'withdraw' }); }
  async getInfo() { return this._read({ t: 'info' }); }
  async getBalance() { return this._read({ t: 'balance' }); }

  // ---- internals -------------------------------------------------------------------------

  async _submit(obj) {
    // HotPocket requires each user's input nonces to be strictly increasing. The client's
    // default nonce is Date.now(), which collides when STREAM fires several packets in the same
    // millisecond, so keep our own monotonic one.
    const text = JSON.stringify(obj);
    // hotpocket-js-client returns null while it is between connections (it reconnects on its
    // own); give it a moment rather than failing the packet.
    for (let attempt = 0; ; attempt++) {
      this._nonce = Math.max((this._nonce || 0) + 1, Date.now());
      const submission = this._clientOpen ? await this._client.submitContractInput(text, this._nonce) : null;
      if (submission && submission.submissionStatus) {
        const status = await submission.submissionStatus;
        if (!status || status.status !== 'accepted') throw new Error(`input rejected: ${status && status.reason}`);
        return status;
      }
      if (!this._clientOpen) throw new Error('plugin is disconnected');
      if (attempt >= SUBMIT_RETRIES) throw new Error('no connection to the connector cluster');
      if (attempt === 0) this._log('submit: client had no connection, waiting for it to reconnect');
      await new Promise((r) => setTimeout(r, SUBMIT_RETRY_MS));
    }
  }
  async _read(obj) {
    const res = await this._client.submitContractReadRequest(JSON.stringify(obj));
    return res ? decodeOutput(res) : null;
  }

  _onOutputs({ outputs }) {
    for (const raw of outputs || []) {
      let msg;
      try { msg = decodeOutput(raw); } catch (e) { this._log('undecodable output', e); continue; }
      if (!msg || typeof msg !== 'object') continue;
      this._onMessage(msg).catch((e) => this._log('output handling failed', e));
    }
  }

  async _onMessage(msg) {
    switch (msg.t) {
      case 'ilp': {
        const packet = Buffer.from(msg.p, 'base64');
        const pend = this._pending.get(msg.id);
        if (pend) { // reply to one of ours
          clearTimeout(pend.timer); this._pending.delete(msg.id); pend.resolve(packet); return;
        }
        // A Prepare forwarded to us: answer it.
        this._inflightReplies += 1;
        try {
          let reply;
          if (!this._dataHandler) reply = localReject('F02', 'no data handler registered');
          else {
            try { reply = await this._dataHandler(packet); } catch (e) { reply = localReject('F00', String(e && e.message ? e.message : e)); }
          }
          await this._submit({ t: 'ilp', id: msg.id, p: reply.toString('base64') });
        } finally {
          this._inflightReplies -= 1;
        }
        return;
      }
      case 'claim_ack': {
        const r = this._acks.get(`${msg.ch}:${msg.amt}`);
        if (r) { this._acks.delete(`${msg.ch}:${msg.amt}`); r(msg); }
        this.emit('claim_ack', msg);
        return;
      }
      case 'payout': this.emit('payout', msg); return;
      case 'last_will': this.emit('last_will', msg); this._log(msg.active ? 'connector is winding down' : 'connector back to normal operation', msg); return;
      case 'ack': this.emit('ack', msg); return;
      case 'err': this.emit('connector_error', msg); this._log('connector error', msg); return;
      default: this.emit('message', msg);
    }
  }
}

// HotPocket's JSON protocol hands contract outputs to the client already parsed (the contract's
// bytes are embedded in the server's JSON message), so a real node delivers objects; the
// simulator and the BSON protocol deliver strings/buffers. Accept all three.
function decodeOutput(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) return raw;
  return JSON.parse(Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw));
}

function localReject(code, message) {
  return IlpPacket.serializeIlpReject({ code, triggeredBy: 'local.plugin', message, data: Buffer.alloc(0) });
}
function hex(k) { return typeof k === 'string' ? k : Buffer.from(k).toString('hex'); }

// Factory for the real client (hotpocket-js-client). Servers: ["wss://host:port", ...].
function hotPocketClientFactory() {
  const HotPocket = require('hotpocket-js-client');
  return async ({ servers, keys, contractId, requiredConnectionCount }) => {
    const client = await HotPocket.createClient(servers, keys, { contractId, requiredConnectionCount });
    return client;
  };
}

module.exports = { HotPocketPlugin, hotPocketClientFactory, signClaim };
