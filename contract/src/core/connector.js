'use strict';

// The deterministic heart of the Nomad Connector.
//
// One call of processRound() is one HotPocket consensus round. It takes the persisted
// state, the agreed inputs of the round (user messages, consensus timestamp, ledger
// facts the cluster has voted on) and returns the new state, the outputs to send to
// peers and the on-ledger "intents" the cluster should multisign. It never reads a
// clock, never touches the network and never uses randomness, so every node of the
// cluster computes byte-identical state — which is what HotPocket consensus needs.
//
// Money model (prepaid, trust-minimised):
//   * A peer funds itself by opening a Xahau payment channel *to* the connector's
//     multisig account and streaming signed claims. Claims are verified here with pure
//     crypto and credited immediately; the cluster redeems them on-ledger in batches.
//   * A peer can only send ILP Prepares up to its credited balance. Nothing is ever
//     lent, so the connector carries no credit risk on peers.
//   * Fulfilled packets move value between peer balances minus the connector's fee.
//   * Peers are paid out by multisigned Payments once their balance crosses a
//     threshold (or on request). A peer's exposure to the connector is bounded by that
//     threshold; the connector's custodial exposure is its float plus unredeemed claims.

const { toBig, str, toSigned, sstr, bpsOf } = require('./amounts');
const ilp = require('./ilp');
const codec = require('./codec');
const claims = require('./claims');

const STATE_VERSION = 1;
const OFFER_BACKOFF_ROUNDS = 20;  // rounds to wait after a failed EVR top-up before retrying
const REDEEM_RETRY_ROUNDS = 200;  // a redemption never confirmed is retried after this many rounds
const PRUNE_EVERY_ROUNDS = 100;

const DEFAULT_CONFIG = Object.freeze({
  // ILP
  ilpAddress: 'g.nomad',            // peers get `${ilpAddress}.${peerPubkey}`
  assetCode: 'XAH',
  assetScale: 6,                    // drops
  feeBps: 10,                       // 0.10% spread
  feeFlat: '0',                     // extra drops per fulfilled packet
  minExpiryWindowMs: 5000,          // shaved off expiry at each hop; must exceed a round
  maxPacketAmount: '1000000000',    // 1000 XAH per packet
  maxPendingPerPeer: 500,
  probeCreditDrops: '10000',        // tiny credit line (0.01 XAH) so unfunded peers can probe rates
  maxPeers: 10000,                  // cap on peer records (each HotPocket key is a potential peer)
  idlePeerRounds: 20000,            // forget peers with nothing owed that have been silent this long
  minSettleDelaySec: 3600,          // channels closing faster than this are not accepted for claims
  // Settlement (all drops)
  masterAddress: null,              // the cluster's multisig Xahau account
  redeemThresholdDrops: '10000000', // redeem a channel once 10 XAH of claims are unredeemed
  payoutThresholdDrops: '5000000',  // pay a peer out once it is owed 5 XAH
  minPayoutDrops: '1000000',        // ... or 1 XAH on explicit withdraw
  reserveDrops: '20000000',         // never spend the account below this (reserve + buffer)
  baseFeeDrops: '12',               // per-signer fee; everpocket multiplies by signers+2
  // Treasury (EVR keeps the hosts paid)
  evrIssuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8',
  evrReserve: '20',                 // keep at least this many EVR
  evrTopUpXahDrops: '5000000',      // spend up to 5 XAH per top-up on the Xahau DEX
  evrTopUpMinEvr: '10',             // ask at least this many EVR for it (limit order)
});

function makeConfig(overrides = {}) {
  return Object.freeze({ ...DEFAULT_CONFIG, ...overrides });
}

function initialState() {
  return {
    version: STATE_VERSION,
    seq: 0,                 // deterministic id counter
    rounds: 0,
    peers: {},              // pubkey -> peer record
    pending: {},            // outId -> in-flight packet
    channels: {},           // channelId -> observed channel + claim bookkeeping
    payouts: {},            // intentId -> payout record
    treasury: {
      masterBalance: '0', evrBalance: '0', feesAccrued: '0',
      ledgerIndex: 0, offerPending: null, offerBackoffUntilLcl: 0,
    },
    stats: { prepares: 0, fulfills: 0, rejects: 0, expiries: 0, claims: 0 },
  };
}

function ensurePeer(state, pubkey, lcl) {
  let p = state.peers[pubkey];
  if (!p) {
    p = state.peers[pubkey] = {
      balance: '0', held: '0', payoutAddress: null, payoutTag: null,
      withdrawRequested: false, inflight: {}, pendingPayout: null,
      firstSeenLcl: lcl, lastSeenLcl: lcl,
    };
  }
  p.lastSeenLcl = lcl;
  return p;
}

function peerAddress(config, pubkey) {
  return `${config.ilpAddress}.${pubkey}`;
}

function nextId(state, prefix) {
  state.seq += 1;
  return `${prefix}${state.seq}`;
}

// F08 data per RFC-27: receivedAmount (uint64) + maximumAmount (uint64).
function amountTooLargeData(received, maximum) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(received, 0);
  b.writeBigUInt64BE(maximum, 8);
  return b;
}

class RoundContext {
  constructor(state, config, { timestamp, lclSeqNo, connected }) {
    this.state = state;
    this.config = config;
    this.ts = timestamp;
    this.lcl = lclSeqNo;
    this.connected = connected || new Set();
    this.outputs = [];
    this.intents = [];
    this.log = [];
  }

  out(peer, msg) { this.outputs.push({ peer, msg }); }
  note(s) { this.log.push(s); }

  // ---- Ledger facts (already agreed by the cluster through NPL votes) --------------

  applyFacts(facts) {
    if (!facts) return;
    const { state } = this;
    const t = state.treasury;
    if (facts.ledgerIndex !== undefined) t.ledgerIndex = facts.ledgerIndex;
    if (facts.masterBalance !== undefined) t.masterBalance = str(facts.masterBalance);
    if (facts.evrBalance !== undefined) t.evrBalance = String(facts.evrBalance);

    // Channels paying into the connector.
    const seen = new Set();
    for (const c of facts.channels || []) {
      seen.add(c.id);
      const ch = state.channels[c.id] || {
        peer: null, lastClaimAmount: '0', lastClaimSig: null, redeemPending: null,
      };
      ch.owner = c.account;
      ch.publicKey = c.publicKey;
      ch.fundedAmount = str(c.amount);        // total ever funded
      ch.ledgerBalance = str(c.balance || 0); // total already redeemed on-ledger
      ch.expiration = c.expiration || null;   // ms epoch, set when the owner is closing
      ch.settleDelay = c.settleDelay;
      // A redemption is done once the ledger balance caught up with it.
      if (ch.redeemPending && toBig(ch.ledgerBalance) >= toBig(ch.redeemPending.amount)) ch.redeemPending = null;
      // The owner can also push funds on-ledger (PaymentChannelClaim by the source account).
      // Never double-count: fast-forward our claim watermark and credit the bound peer.
      if (toBig(ch.ledgerBalance) > toBig(ch.lastClaimAmount)) {
        const pushed = toBig(ch.ledgerBalance) - toBig(ch.lastClaimAmount);
        ch.lastClaimAmount = ch.ledgerBalance;
        if (ch.peer && state.peers[ch.peer]) {
          state.peers[ch.peer].balance = sstr(toSigned(state.peers[ch.peer].balance) + pushed);
          this.out(ch.peer, { t: 'claim_ack', ch: c.id, amt: ch.ledgerBalance, ok: true, credited: str(pushed), balance: state.peers[ch.peer].balance, onLedger: true });
        } else {
          this.note(`channel ${c.id}: ${pushed} drops delivered on-ledger before any claim; unattributed`);
        }
      }
      state.channels[c.id] = ch;
    }
    if (facts.channelsComplete) {
      for (const id of Object.keys(state.channels)) {
        if (!seen.has(id)) {
          const ch = state.channels[id];
          const lost = toBig(ch.lastClaimAmount) - toBig(ch.ledgerBalance);
          if (lost > 0n) this.note(`channel ${id} closed with ${lost} drops of claims unredeemed`);
          delete state.channels[id];
        }
      }
    }

    // Transactions the cluster submitted earlier.
    for (const v of facts.validatedTxs || []) this.settleTx(v.hash, true, v.resultCode);
    for (const f of facts.failedTxs || []) this.settleTx(f.hash, false, f.resultCode);
  }

  settleTx(hash, ok, resultCode) {
    const { state } = this;
    for (const [id, p] of Object.entries(state.payouts)) {
      if (p.txHash !== hash || p.status !== 'submitted') continue;
      const peer = state.peers[p.peer];
      if (ok) {
        p.status = 'validated';
        this.out(p.peer, { t: 'payout', status: 'validated', amt: p.amount, tx: hash });
      } else {
        // Money never left: give it back.
        if (peer) peer.balance = sstr(toSigned(peer.balance) + toBig(p.amount));
        this.out(p.peer, { t: 'payout', status: 'failed', amt: p.amount, tx: hash, reason: resultCode });
      }
      if (peer && peer.pendingPayout === id) peer.pendingPayout = null;
      delete state.payouts[id];
    }
    for (const ch of Object.values(state.channels)) {
      if (ch.redeemPending && ch.redeemPending.hash === hash && !ok) ch.redeemPending = null;
    }
    const t = state.treasury;
    if (t.offerPending && t.offerPending.hash === hash) {
      t.offerPending = null;
      if (!ok) t.offerBackoffUntilLcl = this.lcl + OFFER_BACKOFF_ROUNDS;
    }
  }

  // ---- Expiry sweep (runs before inputs so late fulfills are rejected) -------------

  sweepExpired() {
    const { state } = this;
    for (const [outId, pend] of Object.entries(state.pending)) {
      if (this.ts <= pend.outExpiresAt) continue;
      this.releaseHold(pend, true);
      delete state.pending[outId];
      state.stats.expiries += 1;
      this.out(pend.from, codec.ilpOut(pend.inId,
        ilp.reject('R00', 'transfer timed out', this.config.ilpAddress)));
    }
  }

  releaseHold(pend, refund) {
    const from = this.state.peers[pend.from];
    if (!from) return;
    from.held = str(toBig(from.held) - toBig(pend.inAmount));
    if (refund) from.balance = sstr(toSigned(from.balance) + toBig(pend.inAmount));
    delete from.inflight[pend.inId];
  }

  // ---- Peer inputs -------------------------------------------------------------------

  handleInput(peer, raw) {
    const parsed = codec.parseInput(raw);
    if (parsed.error) { this.out(peer, { t: 'err', reason: parsed.error }); return; }
    const msg = parsed.msg;
    if (!this.state.peers[peer] && Object.keys(this.state.peers).length >= this.config.maxPeers) {
      return this.out(peer, { t: 'err', reason: 'connector is full' });
    }
    ensurePeer(this.state, peer, this.lcl);
    switch (msg.t) {
      case 'ilp': return this.handleIlp(peer, msg.id, msg.packet);
      case 'claim': return this.handleClaim(peer, msg);
      case 'settle_to': return this.handleSettleTo(peer, msg);
      case 'withdraw': return this.handleWithdraw(peer);
      default: return this.out(peer, { t: 'err', reason: 'read-only request sent as input', ref: msg.t });
    }
  }

  handleIlp(peer, id, packet) {
    let pkt;
    try { pkt = ilp.decode(packet); } catch (e) {
      return this.out(peer, { t: 'err', reason: 'undecodable ILP packet', ref: id });
    }
    if (pkt.type === 'prepare') return this.handlePrepare(peer, id, pkt.data);
    return this.handleReply(peer, id, pkt);
  }

  handlePrepare(peer, id, prepare) {
    const { state, config } = this;
    const me = config.ilpAddress;
    const reply = (buf) => this.out(peer, codec.ilpOut(id, buf));
    const rej = (code, message, data) => { state.stats.rejects += 1; reply(ilp.reject(code, message, me, data)); };

    // ILDCP: "who am I?" — free and answered from config.
    if (ilp.isIldcpRequest(prepare)) {
      return reply(ilp.ildcpResponse({
        clientAddress: peerAddress(config, peer), assetCode: config.assetCode, assetScale: config.assetScale,
      }));
    }

    state.stats.prepares += 1;
    const from = state.peers[peer];
    if (from.inflight[id]) return rej('F00', 'duplicate packet id');
    if (!ilp.isValidAddress(prepare.destination)) return rej('F00', 'invalid destination address');

    // Routing: the only routes are our own peers, addressed as <ilpAddress>.<pubkey>[.suffix].
    const prefix = `${me}.`;
    if (!prepare.destination.startsWith(prefix)) return rej('F02', 'destination not reachable through this connector');
    const hop = prepare.destination.slice(prefix.length).split('.')[0];
    if (!state.peers[hop]) return rej('F02', 'unknown peer');
    if (hop === peer) return rej('F02', 'cannot route to self');
    if (!this.connected.has(hop)) return rej('T01', 'peer is not connected');

    let amount;
    try { amount = toBig(prepare.amount); } catch (e) { return rej('F00', 'invalid amount'); }
    const maxPacket = toBig(config.maxPacketAmount);
    if (amount > maxPacket) return rej('F08', 'packet exceeds maximum amount', amountTooLargeData(amount, maxPacket));

    const inExpiresAt = prepare.expiresAt.getTime();
    const window = config.minExpiryWindowMs;
    if (!(inExpiresAt > this.ts + 2 * window)) return rej('R02', 'insufficient timeout');
    const outExpiresAt = inExpiresAt - window;

    // Liquidity is the sender's own prepaid balance (plus a negligible probe credit so that
    // STREAM's exchange-rate probes from unfunded receivers get answered). We lend nothing else.
    if (amount > toSigned(from.balance) + toBig(config.probeCreditDrops)) return rej('T04', 'insufficient prepaid balance; send a payment-channel claim');
    if (Object.keys(from.inflight).length >= config.maxPendingPerPeer) return rej('T03', 'too many packets in flight');

    const fee = amount > 0n ? bpsOf(amount, config.feeBps) + toBig(config.feeFlat) : 0n;
    const outAmount = amount > fee ? amount - fee : 0n;

    // Hold the sender's funds and forward.
    from.balance = sstr(toSigned(from.balance) - amount);
    from.held = str(toBig(from.held) + amount);
    const outId = nextId(state, 'n');
    from.inflight[id] = outId;
    state.pending[outId] = {
      from: peer, inId: id, to: hop,
      inAmount: str(amount), outAmount: str(outAmount),
      condition: prepare.executionCondition.toString('hex'),
      inExpiresAt, outExpiresAt, lcl: this.lcl,
    };
    this.out(hop, codec.ilpOut(outId, ilp.encodePrepare({
      amount: str(outAmount),
      executionCondition: prepare.executionCondition,
      expiresAt: new Date(outExpiresAt),
      destination: prepare.destination,
      data: prepare.data,
    })));
  }

  handleReply(peer, outId, pkt) {
    const { state, config } = this;
    const pend = state.pending[outId];
    if (!pend || pend.to !== peer) {
      // Unknown, already expired, or not this peer's packet. Nothing to do.
      return this.out(peer, { t: 'err', reason: 'no such pending packet', ref: outId });
    }
    const from = state.peers[pend.from];
    const to = state.peers[peer];
    if (pkt.type === 'fulfill') {
      const condition = Buffer.from(pend.condition, 'hex');
      if (!ilp.conditionMatches(pkt.data.fulfillment, condition)) {
        // Wrong fulfillment: the packet stays pending until it expires (as ilp-connector does).
        return this.out(peer, { t: 'err', reason: 'fulfillment does not match condition', ref: outId });
      }
      const inAmount = toBig(pend.inAmount);
      const outAmount = toBig(pend.outAmount);
      from.held = str(toBig(from.held) - inAmount);
      to.balance = sstr(toSigned(to.balance) + outAmount);
      state.treasury.feesAccrued = str(toBig(state.treasury.feesAccrued) + (inAmount - outAmount));
      delete from.inflight[pend.inId];
      delete state.pending[outId];
      state.stats.fulfills += 1;
      this.out(pend.from, codec.ilpOut(pend.inId, ilp.encodeFulfill({
        fulfillment: pkt.data.fulfillment, data: pkt.data.data,
      })));
    } else {
      this.releaseHold(pend, true);
      delete state.pending[outId];
      state.stats.rejects += 1;
      const r = pkt.data;
      this.out(pend.from, codec.ilpOut(pend.inId, ilp.encodeReject({
        code: r.code, triggeredBy: r.triggeredBy || config.ilpAddress, message: r.message, data: r.data,
      })));
    }
  }

  handleClaim(peer, { channel, amount, signature }) {
    const { state } = this;
    const ack = (ok, extra) => this.out(peer, { t: 'claim_ack', ch: channel, amt: amount, ok, ...extra });
    const ch = state.channels[channel];
    if (!ch) return ack(false, { reason: 'channel not (yet) observed on ledger' });
    if (ch.peer && ch.peer !== peer) return ack(false, { reason: 'channel is bound to another peer' });
    const amt = toBig(amount);
    const last = toBig(ch.lastClaimAmount);
    if (amt <= last) return ack(false, { reason: 'claim amount must exceed previous claim', last: ch.lastClaimAmount });
    if (amt > toBig(ch.fundedAmount)) return ack(false, { reason: 'claim exceeds channel funding', funded: ch.fundedAmount });
    if (ch.expiration && ch.expiration <= this.ts) return ack(false, { reason: 'channel is expired' });
    if (ch.settleDelay !== undefined && ch.settleDelay !== null && ch.settleDelay < this.config.minSettleDelaySec) return ack(false, { reason: 'settle delay too short', minSettleDelaySec: this.config.minSettleDelaySec });
    if (!claims.verifyClaim({ channel, amount, signature, publicKey: ch.publicKey })) return ack(false, { reason: 'bad signature' });

    const credit = amt - last;
    ch.peer = ch.peer || peer;
    ch.lastClaimAmount = str(amt);
    ch.lastClaimSig = signature;
    const p = state.peers[peer];
    p.balance = sstr(toSigned(p.balance) + credit);
    state.stats.claims += 1;
    ack(true, { credited: str(credit), balance: p.balance });
  }

  handleSettleTo(peer, { address, tag }) {
    const p = this.state.peers[peer];
    p.payoutAddress = address;
    p.payoutTag = tag;
    this.out(peer, { t: 'ack', of: 'settle_to', addr: address, tag });
  }

  handleWithdraw(peer) {
    const p = this.state.peers[peer];
    if (!p.payoutAddress) return this.out(peer, { t: 'err', reason: 'set a payout address first (settle_to)' });
    p.withdrawRequested = true;
    this.out(peer, { t: 'ack', of: 'withdraw' });
  }

  // ---- Settlement & treasury planning -------------------------------------------------

  liabilities() {
    let sum = 0n;
    for (const p of Object.values(this.state.peers)) sum += toSigned(p.balance) + toBig(p.held);
    for (const po of Object.values(this.state.payouts)) sum += toBig(po.amount);
    return sum;
  }

  prunePeers() {
    const { state, config } = this;
    if (this.lcl % PRUNE_EVERY_ROUNDS !== 0) return;
    const bound = new Set(Object.values(state.channels).map((c) => c.peer));
    for (const [pub, p] of Object.entries(state.peers)) {
      const idle = this.lcl - (p.lastSeenLcl || 0) > config.idlePeerRounds;
      const empty = toSigned(p.balance) === 0n && toBig(p.held) === 0n && !p.pendingPayout && Object.keys(p.inflight).length === 0;
      if (idle && empty && !bound.has(pub)) delete state.peers[pub];
    }
  }

  plan() {
    const { state, config } = this;
    this.prunePeers();
    if (!config.masterAddress) return;
    const master = config.masterAddress;
    const fee = config.baseFeeDrops;

    // 1. Redeem channels: on threshold, or as soon as the owner starts closing them.
    for (const [id, ch] of Object.entries(state.channels)) {
      if (ch.redeemPending && this.lcl - (ch.redeemPending.lcl || this.lcl) > REDEEM_RETRY_ROUNDS) {
        this.note(`channel ${id}: redemption ${ch.redeemPending.intentId} never confirmed; retrying`);
        ch.redeemPending = null;
      }
      if (ch.redeemPending) continue;
      const unredeemed = toBig(ch.lastClaimAmount) - toBig(ch.ledgerBalance);
      if (unredeemed <= 0n) continue;
      const closing = !!ch.expiration;
      if (!closing && unredeemed < toBig(config.redeemThresholdDrops)) continue;
      const intentId = nextId(state, 'r');
      ch.redeemPending = { intentId, amount: ch.lastClaimAmount, hash: null, lcl: this.lcl };
      this.intents.push({
        id: intentId, kind: 'redeem', channel: id,
        tx: {
          TransactionType: 'PaymentChannelClaim', Account: master, Channel: id,
          Balance: ch.lastClaimAmount, Amount: ch.lastClaimAmount,
          Signature: ch.lastClaimSig, PublicKey: ch.publicKey, Fee: fee,
        },
      });
    }

    // 2. Pay peers out, but only from funds that are really on the ledger.
    let available = toBig(state.treasury.masterBalance) - toBig(config.reserveDrops);
    for (const po of Object.values(state.payouts)) available -= toBig(po.amount);
    const peers = Object.keys(state.peers).sort(); // deterministic order
    for (const pub of peers) {
      const p = state.peers[pub];
      if (!p.payoutAddress || p.pendingPayout) continue;
      const bal = toSigned(p.balance);
      const due = bal >= toBig(config.payoutThresholdDrops) || (p.withdrawRequested && bal >= toBig(config.minPayoutDrops));
      if (!due) continue;
      if (bal > available) { this.note(`payout to ${pub} deferred: waiting for redemptions`); continue; }
      const intentId = nextId(state, 'p');
      p.balance = '0';
      p.withdrawRequested = false;
      p.pendingPayout = intentId;
      state.payouts[intentId] = { peer: pub, amount: str(bal), status: 'planned', txHash: null, lcl: this.lcl };
      available -= bal;
      const tx = { TransactionType: 'Payment', Account: master, Destination: p.payoutAddress, Amount: str(bal), Fee: fee };
      if (p.payoutTag !== null && p.payoutTag !== undefined) tx.DestinationTag = p.payoutTag;
      this.intents.push({ id: intentId, kind: 'payout', peer: pub, tx });
    }

    // 3. Treasury: keep enough EVR to pay the hosts, bought with earned XAH on the DEX.
    const t = state.treasury;
    const offerAllowed = !t.offerPending && (t.offerBackoffUntilLcl || 0) <= this.lcl;
    if (offerAllowed && Number(t.evrBalance) < Number(config.evrReserve)) {
      const equity = toBig(t.masterBalance) - toBig(config.reserveDrops) - this.liabilities();
      const spend = toBig(config.evrTopUpXahDrops);
      if (equity >= spend) {
        const intentId = nextId(state, 'o');
        t.offerPending = { intentId, hash: null, spend: str(spend) };
        this.intents.push({
          id: intentId, kind: 'evr-topup',
          tx: {
            TransactionType: 'OfferCreate', Account: master, Fee: fee,
            TakerGets: str(spend), // we give XAH
            TakerPays: { currency: 'EVR', issuer: config.evrIssuer, value: String(config.evrTopUpMinEvr) },
            Flags: 0x00080000, // tfImmediateOrCancel: fill what the book has, never rest an order
          },
        });
      } else {
        this.note('EVR low but no free equity to buy more');
      }
    }
  }

  // Results of this round's multisig submissions (agreed by everpocket's own votes).
  applyIntentResults(results) {
    const { state } = this;
    for (const r of results || []) {
      const po = state.payouts[r.id];
      if (po) {
        const peer = state.peers[po.peer];
        if (r.ok) {
          po.status = 'submitted'; po.txHash = r.hash;
          this.out(po.peer, { t: 'payout', status: 'submitted', amt: po.amount, tx: r.hash });
        } else {
          if (peer) { peer.balance = sstr(toSigned(peer.balance) + toBig(po.amount)); peer.pendingPayout = null; }
          delete state.payouts[r.id];
          this.out(po.peer, { t: 'payout', status: 'failed', amt: po.amount, reason: r.error || r.resultCode });
        }
        continue;
      }
      for (const ch of Object.values(state.channels)) {
        if (ch.redeemPending && ch.redeemPending.intentId === r.id) {
          if (r.ok) ch.redeemPending.hash = r.hash; else ch.redeemPending = null;
        }
      }
      const t = state.treasury;
      if (t.offerPending && t.offerPending.intentId === r.id) {
        if (r.ok) { t.offerPending.hash = r.hash; } else {
          // The book did not have EVR at our limit price; try again later, not every round.
          t.offerPending = null;
          t.offerBackoffUntilLcl = this.lcl + OFFER_BACKOFF_ROUNDS;
        }
      }
    }
  }
}

// Run one consensus round. Mutates `state` and returns { state, outputs, intents, log, ctx }.
// `input` = { timestamp, lclSeqNo, connected: Set<pubkey>, inputs: [{ peer, raw }], facts }
function processRound(state, config, input) {
  const rc = new RoundContext(state, config, input);
  state.rounds += 1;
  rc.applyFacts(input.facts);
  rc.sweepExpired();
  for (const { peer, raw } of input.inputs || []) rc.handleInput(peer, raw);
  rc.plan();
  return rc;
}

// Read-only request (HotPocket readonly mode): pure function of state, no mutation.
function handleReadRequest(state, config, peer, raw) {
  const parsed = codec.parseInput(raw);
  if (parsed.error) return { t: 'err', reason: parsed.error };
  const p = state.peers[peer];
  switch (parsed.msg.t) {
    case 'info':
      return {
        t: 'info',
        ilpAddress: peerAddress(config, peer), connectorAddress: config.ilpAddress,
        assetCode: config.assetCode, assetScale: config.assetScale,
        feeBps: config.feeBps, feeFlat: config.feeFlat, maxPacketAmount: config.maxPacketAmount,
        minExpiryWindowMs: config.minExpiryWindowMs, masterAddress: config.masterAddress,
        redeemThresholdDrops: config.redeemThresholdDrops, payoutThresholdDrops: config.payoutThresholdDrops,
        minPayoutDrops: config.minPayoutDrops, rounds: state.rounds, stats: state.stats,
      };
    case 'balance':
      return {
        t: 'balance', balance: p ? p.balance : '0', held: p ? p.held : '0',
        payoutAddress: p ? p.payoutAddress : null, pendingPayout: p && p.pendingPayout ? state.payouts[p.pendingPayout] : null,
      };
    case 'channels': {
      const mine = Object.entries(state.channels).filter(([, c]) => c.peer === peer || (!c.peer && c.owner === (p && p.payoutAddress)));
      return { t: 'channels', channels: mine.map(([id, c]) => ({ id, ...c })) };
    }
    default:
      return { t: 'err', reason: 'not a read request', ref: parsed.msg.t };
  }
}

module.exports = {
  DEFAULT_CONFIG, makeConfig, initialState, processRound, handleReadRequest, peerAddress, STATE_VERSION,
};
