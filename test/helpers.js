'use strict';

const crypto = require('crypto');
const kp = require('ripple-keypairs');
const IlpPacket = require('ilp-packet');
const { signClaim } = require('../contract/src/core/claims');
const { peerAddress } = require('../contract/src/core/connector');

const PEER_A = `ed${'a'.repeat(64)}`;
const PEER_B = `ed${'b'.repeat(64)}`;
const PEER_C = `ed${'c'.repeat(64)}`;

function condition() {
  const fulfillment = crypto.randomBytes(32);
  return { fulfillment, condition: crypto.createHash('sha256').update(fulfillment).digest() };
}

function prepareInput(id, { amount, destination, expiresAt, condition: cond, data = Buffer.alloc(0) }) {
  const packet = IlpPacket.serializeIlpPrepare({ amount: String(amount), destination, expiresAt: new Date(expiresAt), executionCondition: cond, data });
  return JSON.stringify({ t: 'ilp', id, p: packet.toString('base64') });
}
function fulfillInput(id, fulfillment, data = Buffer.alloc(0)) {
  return JSON.stringify({ t: 'ilp', id, p: IlpPacket.serializeIlpFulfill({ fulfillment, data }).toString('base64') });
}
function rejectInput(id, code, message = '') {
  return JSON.stringify({ t: 'ilp', id, p: IlpPacket.serializeIlpReject({ code, triggeredBy: 'test.peer', message, data: Buffer.alloc(0) }).toString('base64') });
}
function decodeOut(msg) {
  return IlpPacket.deserializeIlpPacket(Buffer.from(msg.p, 'base64'));
}

// A peer's Xahau keypair for channel claims.
function channelKeys() {
  const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
  const pair = kp.deriveKeypair(seed);
  return { ...pair, address: kp.deriveAddress(pair.publicKey) };
}
function claimInput(channel, amount, privateKey) {
  return JSON.stringify({ t: 'claim', ch: channel, amt: String(amount), sig: signClaim({ channel, amount: String(amount), privateKey }) });
}

function channelFact(id, { account, publicKey, amount, balance = 0, expiration = null }) {
  return { id, account, publicKey, amount: String(amount), balance: String(balance), settleDelay: 3600, expiration };
}

function outputsTo(rc, peer) { return rc.outputs.filter((o) => o.peer === peer).map((o) => o.msg); }

module.exports = {
  PEER_A, PEER_B, PEER_C, condition, prepareInput, fulfillInput, rejectInput, decodeOut,
  channelKeys, claimInput, channelFact, outputsTo, peerAddress,
};
