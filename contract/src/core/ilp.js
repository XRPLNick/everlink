'use strict';

// Thin, deterministic helpers over ilp-packet (RFC-27 packets) and ILDCP (RFC-31).
// Everything here is pure: no clocks, no randomness, no I/O.

const crypto = require('crypto');
const IlpPacket = require('ilp-packet');
const ILDCP = require('ilp-protocol-ildcp');

const { Type } = IlpPacket;

// The well-known "peer protocol" fulfillment/condition used by ILDCP (`peer.config`).
const PEER_PROTOCOL_FULFILLMENT = Buffer.alloc(32);
const PEER_PROTOCOL_CONDITION = crypto.createHash('sha256').update(PEER_PROTOCOL_FULFILLMENT).digest();

function decode(buf) {
  // Returns { type: 'prepare'|'fulfill'|'reject', data } or throws.
  const pkt = IlpPacket.deserializeIlpPacket(buf);
  switch (pkt.type) {
    case Type.TYPE_ILP_PREPARE: return { type: 'prepare', data: pkt.data };
    case Type.TYPE_ILP_FULFILL: return { type: 'fulfill', data: pkt.data };
    case Type.TYPE_ILP_REJECT: return { type: 'reject', data: pkt.data };
    default: throw new Error('unknown ILP packet type');
  }
}

function encodePrepare(p) { return IlpPacket.serializeIlpPrepare(p); }
function encodeFulfill(f) { return IlpPacket.serializeIlpFulfill(f); }
function encodeReject(r) { return IlpPacket.serializeIlpReject(r); }

function reject(code, message, triggeredBy, data = Buffer.alloc(0)) {
  return encodeReject({ code, triggeredBy, message, data });
}

function conditionMatches(fulfillment, executionCondition) {
  if (!Buffer.isBuffer(fulfillment) || fulfillment.length !== 32) return false;
  const h = crypto.createHash('sha256').update(fulfillment).digest();
  return crypto.timingSafeEqual(h, executionCondition);
}

function isIldcpRequest(prepare) {
  return prepare.destination === 'peer.config' && prepare.executionCondition.equals(PEER_PROTOCOL_CONDITION);
}

// Build the ILDCP reply for a peer: tells it its ILP address and the connector's asset.
// (serializeIldcpResponse already returns a complete ILP Fulfill packet.)
function ildcpResponse({ clientAddress, assetCode, assetScale }) {
  return ILDCP.serializeIldcpResponse({ clientAddress, assetCode, assetScale });
}

// ILP address grammar (RFC-15): scheme.segment.segment, segments [a-zA-Z0-9_~-]+, max 1023 chars.
const ADDRESS_RE = /^(g|private|example|peer|self|test[1-3]?|local)([.][a-zA-Z0-9_~-]+)+$/;
function isValidAddress(a) {
  return typeof a === 'string' && a.length <= 1023 && ADDRESS_RE.test(a);
}

module.exports = {
  decode, encodePrepare, encodeFulfill, encodeReject, reject,
  conditionMatches, isIldcpRequest, ildcpResponse, isValidAddress,
  PEER_PROTOCOL_CONDITION, PEER_PROTOCOL_FULFILLMENT,
};
