'use strict';

// Wire protocol between a peer and the connector, carried as JSON strings over the
// HotPocket user channel. The peer's identity is its HotPocket user public key
// ("ed" + 64 hex) — HotPocket authenticates every input with an ed25519 signature,
// so the connector never has to authenticate peers itself.
//
// Peer -> connector (contract inputs):
//   {"t":"ilp","id":"<peer-chosen id>","p":"<base64 ILP packet>"}
//        Prepare: a new packet to route. Fulfill/Reject: reply to a Prepare the connector
//        forwarded to this peer under that id.
//   {"t":"claim","ch":"<64-hex channel id>","amt":"<cumulative drops>","sig":"<hex>"}
//        Inbound settlement: a signed Xahau payment-channel claim (RFC "CLM\0" format).
//   {"t":"settle_to","addr":"r...","tag":123}
//        Where outbound payouts for this peer should go (Xahau classic address).
//   {"t":"withdraw"}
//        Ask for the whole available balance to be paid out now.
//
// Peer -> connector (read requests, served in readonly mode, no state change):
//   {"t":"info"}  {"t":"balance"}  {"t":"channels"}
//
// Connector -> peer (contract outputs):
//   {"t":"ilp","id":..,"p":..}          forwarded Prepare, or Fulfill/Reject reply
//   {"t":"claim_ack","ch":..,"amt":..,"ok":true|false,"reason":..,"credited":..}
//   {"t":"payout","status":"submitted"|"validated"|"failed","amt":..,"tx":..}
//   {"t":"last_will","active":true|false,"deadline":..,"balance":..,"payoutTo":..}  winding down / recovered
//   {"t":"err","reason":..,"ref":..}

const MAX_INPUT_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64_RE = /^[0-9A-Fa-f]{64}$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const DROPS_RE = /^[0-9]{1,20}$/;
const XRPL_ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function parseInput(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
  if (buf.length === 0 || buf.length > MAX_INPUT_BYTES) return { error: 'bad size' };
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return { error: 'not json' }; }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return { error: 'missing type' };
  switch (msg.t) {
    case 'ilp': {
      if (!ID_RE.test(msg.id || '')) return { error: 'bad id' };
      if (typeof msg.p !== 'string' || msg.p.length > 48 * 1024) return { error: 'bad packet' };
      let packet;
      try { packet = Buffer.from(msg.p, 'base64'); } catch (e) { return { error: 'bad packet' }; }
      if (packet.length === 0) return { error: 'bad packet' };
      return { msg: { t: 'ilp', id: msg.id, packet } };
    }
    case 'claim': {
      if (!HEX64_RE.test(msg.ch || '')) return { error: 'bad channel' };
      if (!DROPS_RE.test(msg.amt || '')) return { error: 'bad amount' };
      if (typeof msg.sig !== 'string' || !HEX_RE.test(msg.sig) || msg.sig.length > 200) return { error: 'bad signature' };
      return { msg: { t: 'claim', channel: msg.ch.toUpperCase(), amount: msg.amt, signature: msg.sig.toUpperCase() } };
    }
    case 'settle_to': {
      if (!XRPL_ADDR_RE.test(msg.addr || '')) return { error: 'bad address' };
      let tag = null;
      if (msg.tag !== undefined && msg.tag !== null) {
        if (!Number.isInteger(msg.tag) || msg.tag < 0 || msg.tag > 0xffffffff) return { error: 'bad tag' };
        tag = msg.tag;
      }
      return { msg: { t: 'settle_to', address: msg.addr, tag } };
    }
    case 'withdraw':
      return { msg: { t: 'withdraw' } };
    case 'info': case 'balance': case 'channels':
      return { msg: { t: msg.t } };
    default:
      return { error: 'unknown type' };
  }
}

function ilpOut(id, packetBuf) {
  return { t: 'ilp', id, p: packetBuf.toString('base64') };
}

module.exports = { parseInput, ilpOut, MAX_INPUT_BYTES };
