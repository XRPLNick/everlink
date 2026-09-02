'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, makeConfig, processRound, handleReadRequest } = require('../contract/src/core/connector');
const { stableStringify } = require('../contract/src/core/state');
const H = require('./helpers');

const CFG = makeConfig({ masterAddress: 'rMaster', feeBps: 100, minExpiryWindowMs: 1000, redeemThresholdDrops: '1000000000' });
const T0 = 1_800_000_000_000;

function fundedState({ a = 1_000_000, b = 0 } = {}) {
  // Give peers balances via a real claim flow so the state is one the contract could reach.
  const s = initialState();
  const keysA = H.channelKeys();
  const chA = 'A'.repeat(64);
  processRound(s, CFG, { timestamp: T0, lclSeqNo: 1, connected: new Set([H.PEER_A, H.PEER_B]), inputs: [], facts: {
    ledgerIndex: 10, masterBalance: '100000000', evrBalance: '30', channelsComplete: true,
    channels: [H.channelFact(chA, { account: keysA.address, publicKey: keysA.publicKey, amount: 10_000_000 })],
  } });
  const inputs = [];
  if (a) inputs.push({ peer: H.PEER_A, raw: H.claimInput(chA, a, keysA.privateKey) });
  inputs.push({ peer: H.PEER_B, raw: JSON.stringify({ t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111' }) });
  const rc = processRound(s, CFG, { timestamp: T0 + 1, lclSeqNo: 2, connected: new Set([H.PEER_A, H.PEER_B]), inputs, facts: null });
  if (a) assert.equal(H.outputsTo(rc, H.PEER_A)[0].ok, true, 'claim accepted');
  if (b) s.peers[H.PEER_B].balance = String(b);
  return { s, keysA, chA };
}

function round(s, inputs, { ts = T0 + 10, lcl = 3, connected = [H.PEER_A, H.PEER_B], facts = null } = {}) {
  return processRound(s, CFG, { timestamp: ts, lclSeqNo: lcl, connected: new Set(connected), inputs, facts });
}

test('ILDCP tells a peer its address and the asset', () => {
  const s = initialState();
  const ILDCP = require('ilp-protocol-ildcp');
  const ilp = require('../contract/src/core/ilp');
  const raw = H.prepareInput('q1', { amount: 0, destination: 'peer.config', expiresAt: T0 + 30000, condition: ilp.PEER_PROTOCOL_CONDITION });
  const rc = round(s, [{ peer: H.PEER_A, raw }]);
  const outMsg = H.outputsTo(rc, H.PEER_A)[0];
  assert.equal(H.decodeOut(outMsg).type, 13);
  const info = ILDCP.deserializeIldcpResponse(Buffer.from(outMsg.p, 'base64'));
  assert.equal(info.clientAddress, `${CFG.ilpAddress}.${H.PEER_A}`);
  assert.equal(info.assetCode, 'XAH');
  assert.equal(info.assetScale, 6);
});

test('prepare -> forward -> fulfill moves value minus the fee; state stays balanced', () => {
  const { s } = fundedState({ a: 1_000_000 });
  const { fulfillment, condition } = H.condition();
  const dest = `${H.peerAddress(CFG, H.PEER_B)}.stream1`;
  const rc1 = round(s, [{ peer: H.PEER_A, raw: H.prepareInput('p1', { amount: 100_000, destination: dest, expiresAt: T0 + 30_000, condition }) }]);
  const toB = H.outputsTo(rc1, H.PEER_B);
  assert.equal(toB.length, 1);
  const fwd = H.decodeOut(toB[0]);
  assert.equal(fwd.type, 12);
  assert.equal(fwd.data.amount, '99000'); // 1% fee
  assert.equal(fwd.data.destination, dest);
  assert.equal(fwd.data.expiresAt.getTime(), T0 + 30_000 - 1000);
  assert.equal(s.peers[H.PEER_A].balance, '900000');
  assert.equal(s.peers[H.PEER_A].held, '100000');

  const rc2 = round(s, [{ peer: H.PEER_B, raw: H.fulfillInput(toB[0].id, fulfillment) }], { lcl: 4 });
  const toA = H.outputsTo(rc2, H.PEER_A);
  assert.equal(H.decodeOut(toA[0]).type, 13);
  assert.equal(toA[0].id, 'p1');
  assert.equal(s.peers[H.PEER_A].held, '0');
  assert.equal(s.peers[H.PEER_B].balance, '99000');
  assert.equal(s.treasury.feesAccrued, '1000');
  assert.deepEqual(s.pending, {});
});

test('wrong fulfillment is ignored; reject from the next hop refunds the sender', () => {
  const { s } = fundedState({ a: 1_000_000 });
  const { condition } = H.condition();
  const dest = H.peerAddress(CFG, H.PEER_B);
  const rc1 = round(s, [{ peer: H.PEER_A, raw: H.prepareInput('p1', { amount: 50_000, destination: dest, expiresAt: T0 + 30_000, condition }) }]);
  const outId = H.outputsTo(rc1, H.PEER_B)[0].id;
  const rc2 = round(s, [{ peer: H.PEER_B, raw: H.fulfillInput(outId, Buffer.alloc(32, 7)) }], { lcl: 4 });
  assert.equal(H.outputsTo(rc2, H.PEER_B)[0].t, 'err');
  assert.ok(s.pending[outId], 'still pending');
  const rc3 = round(s, [{ peer: H.PEER_B, raw: H.rejectInput(outId, 'F99', 'nope') }], { lcl: 5 });
  const rej = H.decodeOut(H.outputsTo(rc3, H.PEER_A)[0]);
  assert.equal(rej.type, 14);
  assert.equal(rej.data.code, 'F99');
  assert.equal(s.peers[H.PEER_A].balance, '1000000');
  assert.equal(s.peers[H.PEER_A].held, '0');
});

test('expired packets are refunded with R00 before inputs are processed', () => {
  const { s } = fundedState({ a: 1_000_000 });
  const { fulfillment, condition } = H.condition();
  const rc1 = round(s, [{ peer: H.PEER_A, raw: H.prepareInput('p1', { amount: 50_000, destination: H.peerAddress(CFG, H.PEER_B), expiresAt: T0 + 5_000, condition }) }]);
  const outId = H.outputsTo(rc1, H.PEER_B)[0].id;
  // Bob fulfills, but consensus time is already past the outgoing expiry (T0+4000).
  const rc2 = round(s, [{ peer: H.PEER_B, raw: H.fulfillInput(outId, fulfillment) }], { ts: T0 + 4_500, lcl: 4 });
  const toA = H.decodeOut(H.outputsTo(rc2, H.PEER_A)[0]);
  assert.equal(toA.data.code, 'R00');
  assert.equal(H.outputsTo(rc2, H.PEER_B)[0].reason, 'no such pending packet');
  assert.equal(s.peers[H.PEER_A].balance, '1000000');
  assert.equal(s.peers[H.PEER_B].balance, '0');
  assert.equal(s.stats.expiries, 1);
});

test('rejections: unfunded, unknown peer, offline peer, too large, short expiry, duplicate id', () => {
  const { s } = fundedState({ a: 1_000 });
  const { condition } = H.condition();
  const dest = H.peerAddress(CFG, H.PEER_B);
  const code = (rc) => H.decodeOut(H.outputsTo(rc, H.PEER_A)[0]).data.code;
  // balance 1000 + 10000 probe credit < 20000
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x1', { amount: 20_000, destination: dest, expiresAt: T0 + 30_000, condition }) }])), 'T04');
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x2', { amount: 10, destination: H.peerAddress(CFG, H.PEER_C), expiresAt: T0 + 30_000, condition }) }])), 'F02');
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x3', { amount: 10, destination: 'g.elsewhere.bob', expiresAt: T0 + 30_000, condition }) }])), 'F02');
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x4', { amount: 10, destination: dest, expiresAt: T0 + 30_000, condition }) }], { connected: [H.PEER_A] })), 'T01');
  const big = round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x5', { amount: '5000000000', destination: dest, expiresAt: T0 + 30_000, condition }) }]);
  const bigOut = H.decodeOut(H.outputsTo(big, H.PEER_A)[0]).data;
  assert.equal(bigOut.code, 'F08');
  assert.equal(bigOut.data.readBigUInt64BE(8), 1_000_000_000n);
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('x6', { amount: 10, destination: dest, expiresAt: T0 + 1_500, condition }) }])), 'R02');
  const ok = round(s, [{ peer: H.PEER_A, raw: H.prepareInput('dup', { amount: 10, destination: dest, expiresAt: T0 + 30_000, condition }) }]);
  assert.equal(H.outputsTo(ok, H.PEER_B).length, 1);
  assert.equal(code(round(s, [{ peer: H.PEER_A, raw: H.prepareInput('dup', { amount: 10, destination: dest, expiresAt: T0 + 30_000, condition }) }])), 'F00');
  assert.equal(s.peers[H.PEER_A].balance, '990');
  assert.equal(s.peers[H.PEER_A].held, '10');
});

test('claims: monotonic, bounded by funding, signature-checked, bound to first presenter', () => {
  const s = initialState();
  const keys = H.channelKeys();
  const ch = 'C'.repeat(64);
  round(s, [], { facts: { channels: [H.channelFact(ch, { account: keys.address, publicKey: keys.publicKey, amount: 5_000_000 })], channelsComplete: true, masterBalance: '0', evrBalance: '0', ledgerIndex: 1 } });
  let rc = round(s, [{ peer: H.PEER_A, raw: H.claimInput(ch, 2_000_000, keys.privateKey) }]);
  assert.deepEqual(H.outputsTo(rc, H.PEER_A)[0].credited, '2000000');
  rc = round(s, [{ peer: H.PEER_A, raw: H.claimInput(ch, 1_500_000, keys.privateKey) }]);
  assert.equal(H.outputsTo(rc, H.PEER_A)[0].ok, false, 'must exceed previous');
  rc = round(s, [{ peer: H.PEER_A, raw: H.claimInput(ch, 9_000_000, keys.privateKey) }]);
  assert.equal(H.outputsTo(rc, H.PEER_A)[0].reason, 'claim exceeds channel funding');
  rc = round(s, [{ peer: H.PEER_B, raw: H.claimInput(ch, 3_000_000, keys.privateKey) }]);
  assert.equal(H.outputsTo(rc, H.PEER_B)[0].reason, 'channel is bound to another peer');
  const other = H.channelKeys();
  rc = round(s, [{ peer: H.PEER_A, raw: H.claimInput(ch, 3_000_000, other.privateKey) }]);
  assert.equal(H.outputsTo(rc, H.PEER_A)[0].reason, 'bad signature');
  rc = round(s, [{ peer: H.PEER_A, raw: H.claimInput(ch, 3_000_000, keys.privateKey) }]);
  assert.equal(H.outputsTo(rc, H.PEER_A)[0].credited, '1000000');
  assert.equal(s.peers[H.PEER_A].balance, '3000000');
  assert.equal(s.channels[ch].lastClaimAmount, '3000000');
});

test('redemption intents: on threshold, and immediately when the owner starts closing', () => {
  const s = initialState();
  const keys = H.channelKeys();
  const ch = 'D'.repeat(64);
  const cfg = makeConfig({ masterAddress: 'rMaster', redeemThresholdDrops: '1000000' });
  const facts = (extra = {}) => ({ ledgerIndex: 5, masterBalance: '30000000', evrBalance: '30', channelsComplete: true, channels: [H.channelFact(ch, { account: keys.address, publicKey: keys.publicKey, amount: 10_000_000, ...extra })] });
  processRound(s, cfg, { timestamp: T0, lclSeqNo: 1, connected: new Set(), inputs: [], facts: facts() });
  let rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 2, connected: new Set(), inputs: [{ peer: H.PEER_A, raw: H.claimInput(ch, 500_000, keys.privateKey) }], facts: null });
  assert.equal(rc.intents.length, 0, 'below threshold');
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 3, connected: new Set(), inputs: [{ peer: H.PEER_A, raw: H.claimInput(ch, 1_200_000, keys.privateKey) }], facts: null });
  assert.equal(rc.intents.length, 1);
  assert.equal(rc.intents[0].tx.TransactionType, 'PaymentChannelClaim');
  assert.equal(rc.intents[0].tx.Balance, '1200000');
  assert.equal(rc.intents[0].tx.PublicKey, keys.publicKey);
  rc.applyIntentResults([{ id: rc.intents[0].id, ok: true, hash: 'H1', resultCode: 'tesSUCCESS' }]);
  assert.equal(s.channels[ch].redeemPending.hash, 'H1');
  // Ledger catches up -> pending cleared; a further small claim + owner closing -> redeem now.
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 4, connected: new Set(), inputs: [{ peer: H.PEER_A, raw: H.claimInput(ch, 1_250_000, keys.privateKey) }], facts: facts({ balance: 1_200_000, expiration: T0 + 3600_000 }) });
  assert.equal(s.channels[ch].redeemPending.intentId, rc.intents[0].id);
  assert.equal(rc.intents[0].tx.Balance, '1250000');
});

test('payouts: threshold or withdraw, only from on-ledger funds, refund on failure', () => {
  const cfg = makeConfig({ masterAddress: 'rMaster', payoutThresholdDrops: '5000000', minPayoutDrops: '1000000', reserveDrops: '20000000' });
  const s = initialState();
  const facts = (masterBalance) => ({ ledgerIndex: 7, masterBalance, evrBalance: '30', channels: [], channelsComplete: true });
  processRound(s, cfg, { timestamp: T0, lclSeqNo: 1, connected: new Set(), inputs: [{ peer: H.PEER_B, raw: JSON.stringify({ t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111', tag: 7 }) }], facts: facts('21000000') });
  s.peers[H.PEER_B].balance = '6000000';
  let rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 2, connected: new Set(), inputs: [], facts: null });
  assert.equal(rc.intents.length, 0, 'deferred: only 1 XAH above reserve on ledger');
  assert.equal(rc.log[0].includes('deferred'), true);
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 3, connected: new Set([H.PEER_B]), inputs: [], facts: facts('40000000') });
  assert.equal(rc.intents.length, 1);
  const tx = rc.intents[0].tx;
  assert.equal(tx.TransactionType, 'Payment');
  assert.equal(tx.Amount, '6000000');
  assert.equal(tx.DestinationTag, 7);
  assert.equal(s.peers[H.PEER_B].balance, '0');
  rc.applyIntentResults([{ id: rc.intents[0].id, ok: false, error: 'tecUNFUNDED' }]);
  assert.equal(s.peers[H.PEER_B].balance, '6000000', 'refunded');
  assert.deepEqual(s.payouts, {});
  // Withdraw below threshold but above minimum.
  s.peers[H.PEER_B].balance = '1500000';
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 4, connected: new Set([H.PEER_B]), inputs: [{ peer: H.PEER_B, raw: JSON.stringify({ t: 'withdraw' }) }], facts: null });
  assert.equal(rc.intents.length, 1);
  rc.applyIntentResults([{ id: rc.intents[0].id, ok: true, hash: 'H9', resultCode: 'tesSUCCESS' }]);
  assert.equal(s.payouts[rc.intents[0].id].status, 'submitted');
  assert.equal(H.outputsTo(rc, H.PEER_B).at(-1).status, 'submitted');
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 5, connected: new Set([H.PEER_B]), inputs: [], facts: { ...facts('38500000'), validatedTxs: [{ hash: 'H9', resultCode: 'tesSUCCESS' }] } });
  assert.equal(H.outputsTo(rc, H.PEER_B)[0].status, 'validated');
  assert.deepEqual(s.payouts, {});
  assert.equal(s.peers[H.PEER_B].pendingPayout, null);
});

test('treasury buys EVR from free equity only', () => {
  const cfg = makeConfig({ masterAddress: 'rMaster', evrReserve: '20', evrTopUpXahDrops: '5000000', reserveDrops: '20000000' });
  const s = initialState();
  s.peers[H.PEER_A] = { ...initialState().peers, balance: '10000000', held: '0', payoutAddress: null, payoutTag: null, withdrawRequested: false, inflight: {}, pendingPayout: null, firstSeenLcl: 1, lastSeenLcl: 1 };
  let rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 1, connected: new Set(), inputs: [], facts: { ledgerIndex: 1, masterBalance: '34000000', evrBalance: '5', channels: [], channelsComplete: true } });
  assert.equal(rc.intents.length, 0, 'equity 4 XAH < 5 XAH top-up');
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 2, connected: new Set(), inputs: [], facts: { ledgerIndex: 2, masterBalance: '36000000', evrBalance: '5', channels: [], channelsComplete: true } });
  assert.equal(rc.intents.length, 1);
  assert.equal(rc.intents[0].tx.TransactionType, 'OfferCreate');
  assert.equal(rc.intents[0].tx.TakerGets, '5000000');
  rc.applyIntentResults([{ id: rc.intents[0].id, ok: true, hash: 'O1', resultCode: 'tesSUCCESS' }]);
  rc = processRound(s, cfg, { timestamp: T0, lclSeqNo: 3, connected: new Set(), inputs: [], facts: { ledgerIndex: 3, masterBalance: '31000000', evrBalance: '25', channels: [], channelsComplete: true, validatedTxs: [{ hash: 'O1', resultCode: 'tesSUCCESS' }] } });
  assert.equal(s.treasury.offerPending, null);
  assert.equal(rc.intents.length, 0);
});

test('read requests answer from state without mutating it', () => {
  const { s } = fundedState({ a: 123_456 });
  const before = stableStringify(s);
  const info = handleReadRequest(s, CFG, H.PEER_A, JSON.stringify({ t: 'info' }));
  assert.equal(info.ilpAddress, `${CFG.ilpAddress}.${H.PEER_A}`);
  const bal = handleReadRequest(s, CFG, H.PEER_A, JSON.stringify({ t: 'balance' }));
  assert.equal(bal.balance, '123456');
  assert.equal(handleReadRequest(s, CFG, H.PEER_A, 'garbage').t, 'err');
  assert.equal(stableStringify(s), before);
});

test('malformed inputs never throw and never change balances', () => {
  const { s } = fundedState({ a: 10 });
  const before = { ...s.peers[H.PEER_A] };
  const bad = ['', 'null', '{}', '{"t":"ilp"}', '{"t":"ilp","id":"x","p":"!!!"}', '{"t":"ilp","id":"x","p":"AAAA"}', '{"t":"claim","ch":"zz","amt":"1","sig":"00"}', '{"t":"settle_to","addr":"nope"}', '{"t":"withdraw"}', JSON.stringify({ t: 'ilp', id: 'y', p: Buffer.from([12, 0, 0]).toString('base64') })];
  const rc = round(s, bad.map((raw) => ({ peer: H.PEER_A, raw })));
  assert.equal(H.outputsTo(rc, H.PEER_A).length, bad.length);
  assert.equal(s.peers[H.PEER_A].balance, before.balance);
  assert.equal(s.peers[H.PEER_A].held, before.held);
});
