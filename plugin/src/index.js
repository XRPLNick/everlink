'use strict';

// ilp-plugin-hotpocket: an ILP "plugin" (the interface ilp-protocol-stream and friends
// expect: connect/disconnect/isConnected/sendData/registerDataHandler) that talks to a
// Nomad Connector cluster over the HotPocket user channel.
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
    const ok = await this._client.connect();
    if (ok === false) throw new Error('could not connect to the connector cluster');
    this._connected = true;
    this.emit('connect');
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;
    for (const [id, p] of this._pending) { clearTimeout(p.timer); p.resolve(localReject('T00', 'plugin disconnected')); this._pending.delete(id); }
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
    const { submissionStatus } = await this._client.submitContractInput(JSON.stringify(obj));
    const status = await submissionStatus;
    if (!status || status.status !== 'accepted') throw new Error(`input rejected: ${status && status.reason}`);
    return status;
  }
  async _read(obj) {
    const res = await this._client.submitContractReadRequest(JSON.stringify(obj));
    return res ? JSON.parse(typeof res === 'string' ? res : res.toString()) : null;
  }

  _onOutputs({ outputs }) {
    for (const raw of outputs || []) {
      let msg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { continue; }
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
        let reply;
        if (!this._dataHandler) reply = localReject('F02', 'no data handler registered');
        else {
          try { reply = await this._dataHandler(packet); } catch (e) { reply = localReject('F00', String(e && e.message ? e.message : e)); }
        }
        await this._submit({ t: 'ilp', id: msg.id, p: reply.toString('base64') });
        return;
      }
      case 'claim_ack': {
        const r = this._acks.get(`${msg.ch}:${msg.amt}`);
        if (r) { this._acks.delete(`${msg.ch}:${msg.amt}`); r(msg); }
        this.emit('claim_ack', msg);
        return;
      }
      case 'payout': this.emit('payout', msg); return;
      case 'ack': this.emit('ack', msg); return;
      case 'err': this.emit('connector_error', msg); this._log('connector error', msg); return;
      default: this.emit('message', msg);
    }
  }
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
