'use strict';

// Capture and render ILP packets as they pass through ilp-plugin-hotpocket: every Prepare a
// plugin sends (and the reply it gets back) and every Prepare it is handed (and the reply it
// produces), decoded with `ilp-packet` (RFC 27). With the STREAM shared secret the encrypted
// STREAM packets inside are decrypted and their frames listed (RFC 29). Fulfillments are
// checked against conditions. Used by trace-stream.js and by test/trace.test.js.

const crypto = require('crypto');
const IlpPacket = require('ilp-packet');
const { Packet: StreamPacket, FrameType } = require('ilp-protocol-stream/dist/src/packet');
const { generatePskEncryptionKey } = require('ilp-protocol-stream/dist/src/crypto');

const ILDCP = require('ilp-protocol-ildcp');

function decodeIlp(buf) {
  const p = IlpPacket.deserializeIlpPacket(buf);
  if (p.type === IlpPacket.Type.TYPE_ILP_PREPARE) return { type: 'PREPARE', amount: p.data.amount, destination: p.data.destination, expiresAt: p.data.expiresAt.toISOString(), condition: p.data.executionCondition.toString('hex'), data: p.data.data };
  if (p.type === IlpPacket.Type.TYPE_ILP_FULFILL) return { type: 'FULFILL', fulfillment: p.data.fulfillment.toString('hex'), data: p.data.data };
  return { type: 'REJECT', code: p.data.code, triggeredBy: p.data.triggeredBy, message: p.data.message, data: p.data.data };
}

// ILDCP (RFC 31): a Prepare to `peer.config` asks the connector for the sender's ILP address and asset.
const isIldcp = (prepare) => prepare.destination === 'peer.config';
function decodeIldcpReply(fulfill) {
  try { const r = ILDCP.deserializeIldcpResponse(IlpPacket.serializeIlpFulfill({ fulfillment: Buffer.from(fulfill.fulfillment, 'hex'), data: fulfill.data })); return { clientAddress: r.clientAddress, assetCode: r.assetCode, assetScale: r.assetScale }; } catch (e) { return null; }
}

class Tracer {
  constructor() { this.entries = []; this.pskKey = null; }

  // The receiver's shared secret (from server.generateAddressAndSecret()) unlocks the STREAM frames.
  async useSharedSecret(sharedSecret) { this.pskKey = await generatePskEncryptionKey(sharedSecret); }

  // Wrap a plugin: outgoing Prepares (sendData) and incoming ones (the registered data handler).
  wrap(plugin, side) {
    const entries = this.entries;
    const sendData = plugin.sendData.bind(plugin);
    plugin.sendData = async (buf) => {
      const e = { n: entries.length + 1, side, direction: 'out', t: Date.now(), prepare: decodeIlp(buf), raw: buf.toString('base64') };
      entries.push(e);
      const reply = await sendData(buf);
      e.rttMs = Date.now() - e.t; e.replyT = Date.now(); e.reply = decodeIlp(reply); e.replyRaw = reply.toString('base64');
      return reply;
    };
    const register = plugin.registerDataHandler.bind(plugin);
    plugin.registerDataHandler = (handler) => register(async (buf) => {
      const e = { n: entries.length + 1, side, direction: 'in', t: Date.now(), prepare: decodeIlp(buf), raw: buf.toString('base64') };
      entries.push(e);
      const reply = await handler(buf);
      e.rttMs = Date.now() - e.t; e.replyT = Date.now(); e.reply = decodeIlp(reply); e.replyRaw = reply.toString('base64');
      return reply;
    });
    return plugin;
  }

  async decodeStream(data) {
    if (!this.pskKey || !data || !data.length) return null;
    try {
      const pkt = await StreamPacket.decryptAndDeserialize(this.pskKey, data);
      return {
        sequence: pkt.sequence.toString(), ilpPacketType: pkt.ilpPacketType, prepareAmount: pkt.prepareAmount.toString(),
        frames: pkt.frames.map((f) => {
          const o = { frame: FrameType[f.type] };
          for (const [k, v] of Object.entries(f)) {
            if (k === 'type' || k === 'name') continue;
            o[k] = Buffer.isBuffer(v) ? v.toString('hex') : (v && typeof v === 'object' && typeof v.toString === 'function') ? v.toString() : v;
          }
          return o;
        }),
      };
    } catch (e) { return { undecryptable: e.message }; }
  }

  // Fills in decoded STREAM frames and fulfillment checks; returns the entries.
  async analyse() {
    for (const e of this.entries) {
      if (e.reply && e.reply.type === 'FULFILL') e.fulfillmentValid = crypto.createHash('sha256').update(Buffer.from(e.reply.fulfillment, 'hex')).digest('hex') === e.prepare.condition;
      if (isIldcp(e.prepare)) { e.ildcp = e.reply && e.reply.type === 'FULFILL' ? decodeIldcpReply(e.reply) : null; continue; }
      e.stream = await this.decodeStream(e.prepare.data);
      // Replies the connector itself produced (T04, F08 ...) carry no STREAM data; only note a
      // failed decryption when the reply came from the peer.
      const fromPeer = e.reply && (e.reply.type === 'FULFILL' || /\.[0-9a-f]{20,}/i.test(String(e.reply.triggeredBy || '')));
      e.replyStream = e.reply && fromPeer ? await this.decodeStream(e.reply.data) : null;
      if (e.replyStream && e.replyStream.undecryptable && !e.reply.data.length) e.replyStream = null;
    }
    return this.entries;
  }

  summary() {
    const es = this.entries.filter((e) => e.reply);
    const out = es.filter((e) => e.direction === 'out'); const inn = es.filter((e) => e.direction === 'in');
    const sum = (list) => list.filter((e) => e.reply.type === 'FULFILL').reduce((s, e) => s + BigInt(e.prepare.amount), 0n);
    return { prepares: es.length, sentIn: out.length, forwarded: inn.length, fulfilled: es.filter((e) => e.reply.type === 'FULFILL').length, rejected: es.filter((e) => e.reply.type === 'REJECT').length, senderFulfilledDrops: sum(out), receiverFulfilledDrops: sum(inn), allFulfillmentsValid: es.filter((e) => e.reply.type === 'FULFILL').every((e) => e.fulfillmentValid) };
  }

  // Human-readable trace. names: display name per side, e.g. { alice: 'Alice', bob: 'Bob' }.
  render(names = { alice: 'Alice', bob: 'Bob' }) {
    const who = (side) => names[side] || side;
    const ts = (d) => new Date(d).toISOString().slice(11, 23);
    const frames = (s) => {
      if (!s) return null;
      if (s.undecryptable) return `STREAM: not decryptable (${s.undecryptable})`;
      const fr = s.frames.map((f) => { const args = Object.entries(f).filter(([k]) => k !== 'frame').map(([k, v]) => `${k}=${v}`).join(', '); return `${f.frame}${args ? `(${args})` : ''}`; }).join(', ');
      return `STREAM seq ${s.sequence}${s.prepareAmount !== '0' ? ` prepareAmount ${s.prepareAmount}` : ''}: ${fr || '(no frames)'}`;
    };
    const lines = [];
    for (const e of this.entries) {
      const [from, to] = e.direction === 'out' ? [who(e.side), 'cluster'] : ['cluster', who(e.side)];
      const p = e.prepare;
      const what = isIldcp(p) ? 'PREPARE  ILDCP: "what is my ILP address?" (peer.config)' : `PREPARE  ${String(p.amount).padStart(8)} drops  to ${p.destination}`;
      lines.push(`#${String(e.n).padStart(2)}  ${ts(e.t)}  ${from} -> ${to}`.padEnd(40) + what);
      lines.push(`${''.padEnd(40)}expires ${p.expiresAt}  condition ${p.condition}`);
      const f1 = frames(e.stream); if (f1) lines.push(`${''.padEnd(40)}${f1}`);
      if (!e.reply) { lines.push(`${''.padEnd(40)}(no reply recorded)`); lines.push(''); continue; }
      const r = e.reply;
      if (r.type === 'FULFILL') lines.push(`     ${ts(e.replyT)}  ${to} -> ${from}`.padEnd(40) + `FULFILL  fulfillment ${r.fulfillment}  sha256 == condition: ${e.fulfillmentValid ? 'yes' : 'NO'}  (${e.rttMs} ms)`);
      else lines.push(`     ${ts(e.replyT)}  ${to} -> ${from}`.padEnd(40) + `REJECT ${r.code} from ${r.triggeredBy}${r.message ? ` "${r.message}"` : ''}  (${e.rttMs} ms)`);
      if (e.ildcp) lines.push(`${''.padEnd(40)}ILDCP answer: address ${e.ildcp.clientAddress}, asset ${e.ildcp.assetCode} scale ${e.ildcp.assetScale}`);
      const f2 = frames(e.replyStream); if (f2) lines.push(`${''.padEnd(40)}${f2}`);
      lines.push('');
    }
    const s = this.summary();
    const sides = [...new Set(this.entries.map((e) => e.side))];
    const per = sides.map((side) => { const es = this.entries.filter((e) => e.side === side && e.reply); return `${who(side)}: ${es.filter((e) => e.direction === 'out').length} sent into the cluster, ${es.filter((e) => e.direction === 'in').length} delivered by the cluster`; }).join('; ');
    lines.push(`${s.prepares} Prepares (${per}); ${s.fulfilled} fulfilled, ${s.rejected} rejected - STREAM's rate probes, ILDCP has its own reply, and the connection close are meant to be rejected.`);
    lines.push(`Fulfilled money leaving senders: ${s.senderFulfilledDrops} drops; fulfilled money reaching receivers: ${s.receiverFulfilledDrops} drops; the ${s.senderFulfilledDrops - s.receiverFulfilledDrops} drops in between are the connector's fee. ${s.allFulfillmentsValid ? 'Every fulfillment hashes to its condition.' : 'SOME FULFILLMENTS DO NOT MATCH THEIR CONDITION.'}`);
    return lines.join('\n') + '\n';
  }
}

module.exports = { Tracer, decodeIlp };
