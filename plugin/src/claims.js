'use strict';

// Xahau/XRPL payment-channel claims (copy of contract/src/core/claims.js so the plugin has no dependency on the contract package). A claim is the channel owner's signature over
// "CLM\0" || channelId || amount(uint64 BE drops). Verification is pure crypto, so every
// node of the cluster reaches the same verdict without talking to the ledger.

const codec = require('ripple-binary-codec');
const kp = require('ripple-keypairs');

function signingData(channelId, drops) {
  return codec.encodeForSigningClaim({ channel: channelId, amount: String(drops) });
}

function verifyClaim({ channel, amount, signature, publicKey }) {
  try {
    return kp.verify(signingData(channel, amount), signature, publicKey);
  } catch (e) {
    return false;
  }
}

// Used by peers (the plugin) — never by the contract, which holds no channel keys.
function signClaim({ channel, amount, privateKey }) {
  return kp.sign(signingData(channel, amount), privateKey);
}

module.exports = { verifyClaim, signClaim, signingData };
