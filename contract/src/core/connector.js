'use strict';

// The deterministic heart of the Everlink.
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
//   * The cluster pays for its own hosting: the voted "lease" fact says until when each node's
//     Evernode lease is paid; the core renews the most urgent one per round (an "extend" intent
//     the bridge carries out), backing off per node when a host will not take the payment, so
//     that one bad host never stops the others from being renewed.
//   * The last will: the cluster's account is controlled only by its nodes' signer keys, so
//     when the nodes' hosting is about to lapse and has not been extended, the connector stops
//     taking money, redeems every claim and pays every peer out to where its money belongs —
//     while it can still sign. Driven by the same lease fact.

const { toBig, str, toSigned, sstr, bpsOf, min: bigMin } = require('./amounts');
const ilp = require('./ilp');
const codec = require('./codec');
const claims = require('./claims');

const STATE_VERSION = 1;
const OFFER_BACKOFF_ROUNDS = 20;  // rounds to wait after a failed EVR top-up before retrying
const REDEEM_RETRY_ROUNDS = 200;  // a redemption never confirmed is retried after this many rounds
const PRUNE_EVERY_ROUNDS = 100;
const PAYOUT_BACKOFF_ROUNDS = 20; // after a failed payout: wait this long, doubling per failure ...
const PAYOUT_BACKOFF_MAX_ROUNDS = 2000; // ... up to this (100 minutes at 3 s), until settle_to or a success resets it
const MAX_INTENTS_PER_ROUND = 4;  // each intent is a full multisign over NPL; a round must stay well inside its time limit
const LEASE_RETRY_ROUNDS = 20;    // after a failed lease renewal: wait this long, doubling per failure ...
const LEASE_RETRY_MAX_ROUNDS = 200; // ... up to this (10 minutes at 3 s); a success resets it
const LEASE_PENDING_ROUNDS = 2;   // a renewal's result always arrives in its own round; older "pending" means the round died
const LEASE_FACT_LAG_ROUNDS = 100; // after a renewal, wait this long for the fact to show it before renewing the node again
const DEFAULT_MOMENT_MS = 3600000;
const TF_CLOSE = 0x00020000;      // PaymentChannelClaim flag: close the channel (immediate for the destination)
const MEMO_TYPE = Buffer.from('everlink/intent').toString('hex').toUpperCase();

// Every transaction the cluster submits names the intent it fulfils in a memo, so a round that
// died between submitting and recording can be reconciled against the ledger afterwards.
function intentMemo(id) {
  return [{ Memo: { MemoType: MEMO_TYPE, MemoData: Buffer.from(id).toString('hex').toUpperCase() } }];
}
function intentIdFromMemos(memos) {
  for (const m of memos || []) {
    const memo = m && m.Memo;
    if (memo && String(memo.MemoType || '').toUpperCase() === MEMO_TYPE && memo.MemoData) return Buffer.from(memo.MemoData, 'hex').toString('utf8');
  }
  return null;
}

const DEFAULT_CONFIG = Object.freeze({
  // ILP
  ilpAddress: 'g.everlink',            // peers get `${ilpAddress}.${peerPubkey}`
  assetCode: 'XAH',
  assetScale: 6,                    // drops
  feeBps: 10,                       // 0.10% spread
  feeFlat: '0',                     // extra drops per fulfilled packet
  minExpiryWindowMs: 5000,          // shaved off expiry at each hop; must exceed a round
  maxPacketAmount: '1000000000',    // 1000 XAH per packet
  maxPendingPerPeer: 500,
  probeCreditDrops: '10000',        // tiny credit line (0.01 XAH) so unfunded peers can probe rates
  devFaucetDrops: '0',              // DEV ONLY: starting balance for every new peer (local clusters without a ledger)
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
  // Last will (see money.md). The lease fact says when the signer quorum's hosting is paid
  // until; if that is this close and the renewals (above) have not managed it, wind down: no new
  // Prepares or claims, redeem everything, pay every peer's balance to its payout address —
  // or, failing one, back to the account that funded its channel. 0 disables.
  lastWillSec: 1800,
  lastWillMinDrops: '1000',         // balances below this are not worth a transaction and are left behind
  lastWillReserveDrops: '3000000',  // while winding down, keep only this much back (the ledger's own reserve for the account) instead of reserveDrops
  lastWillGraceRounds: 100,         // no wind-down in a cluster's first rounds: the first renewals come first
  // Hosting (see money.md). Each node's Evernode lease is renewed by the cluster itself once
  // it has this many moments left (on the lease fact's pessimistic clock), by this many moments,
  // most urgent node first, one per round. 0 for leaseExtendAheadMoments disables renewals.
  leaseExtendAheadMoments: 2,
  leaseExtendMoments: 24,
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
      evrSpentSinceFact: 0, // EVR paid for renewals since the last observation reported the balance
      lease: null,          // latest voted lease fact: { deadlineMs, quorum, signers, momentMs, ... }
      leaseNote: null,      // why the bridge could not (fully) tell, when it could not
      clock: null,          // Evernode's moment clock once a vote carried it: { momentSec, baseIdx }
    },
    lastWill: null,         // set while winding down: { sinceLcl, sinceTs, deadlineMs }
    leases: {},             // node pubkey -> renewal bookkeeping: { pending, attempts, backoffUntilLcl, lastLcl, extendedLcl, moments }
    stats: { prepares: 0, fulfills: 0, rejects: 0, expiries: 0, claims: 0 },
  };
}

function ensurePeer(state, pubkey, lcl, config) {
  let p = state.peers[pubkey];
  if (!p) {
    p = state.peers[pubkey] = {
      balance: str((config && config.devFaucetDrops) || '0'), held: '0', payoutAddress: null, payoutTag: null,
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

// Where a peer's money goes when it is paid out without asking: the address it registered with
// settle_to, or else the account that owned the first channel it funded itself from (remembered
// on the peer record when the channel was bound, so it survives the channel closing). Null when
// neither exists.
function payoutHome(state, pubkey) {
  const p = state.peers[pubkey];
  if (!p) return null;
  if (p.payoutAddress) return { address: p.payoutAddress, tag: p.payoutTag, source: 'settle_to' };
  if (p.channelOwner) return { address: p.channelOwner, tag: null, source: 'channel' };
  const mine = Object.entries(state.channels).filter(([, c]) => c.peer === pubkey && c.owner).sort(([a], [b]) => (a < b ? -1 : 1));
  if (mine.length) return { address: mine[0][1].owner, tag: null, source: 'channel' };
  return null;
}

// Rounds to wait before retrying a peer's payout after it failed n times in a row.
function payoutBackoff(failures) {
  return Math.min(PAYOUT_BACKOFF_ROUNDS * 2 ** Math.max(0, failures - 1), PAYOUT_BACKOFF_MAX_ROUNDS);
}
// Rounds to wait before renewing a node's lease again after n failures in a row.
function leaseBackoff(failures) {
  return Math.min(LEASE_RETRY_ROUNDS * 2 ** Math.max(0, failures - 1), LEASE_RETRY_MAX_ROUNDS);
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
    if (facts.evrBalance !== undefined) { t.evrBalance = String(facts.evrBalance); t.evrSpentSinceFact = 0; }
    // The cluster's own hosting: until when the signer quorum's leases are paid (null = unknown
    // this round; the last known value is kept, so an unknown never changes the wind-down state).
    if (facts.lease && typeof facts.lease.deadlineMs === 'number') t.lease = facts.lease;
    // Evernode's moment clock, once any vote carried it: from then on every node derives the
    // lease fact from this agreed value rather than from what it cached itself.
    if (facts.clock && facts.clock.momentSec > 0 && Number.isFinite(facts.clock.baseIdx)) t.clock = { momentSec: facts.clock.momentSec, baseIdx: facts.clock.baseIdx };

    // Payouts planned in a round that never got to record its submissions (the process died
    // between submitting and saving): the bridge looked for them on the ledger by their memo.
    for (const r of facts.reconciled || []) {
      const po = state.payouts[r.id];
      if (!po || po.status !== 'planned') continue;
      if (r.hash) {
        po.status = 'submitted'; po.txHash = r.hash;
        const msg = { t: 'payout', status: 'submitted', amt: po.amount, tx: r.hash };
        if (po.lastWill) msg.lastWill = true;
        this.out(po.peer, msg);
        this.note(`payout ${r.id} recovered from the ledger as ${r.hash}`);
        if (r.resultCode) this.settleTx(r.hash, r.resultCode === 'tesSUCCESS', r.resultCode);
      } else if (r.lost) {
        this.note(`payout ${r.id} was never submitted; refunding`);
        this.payoutFailed(r.id, po, 'submission lost', null, { countsAsFailure: false });
      }
    }
    if (facts.leaseNote !== undefined) t.leaseNote = facts.leaseNote || null;

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

  // The last will. `lease.deadlineMs` is when the signer quorum's hosting runs out unless the
  // renewals extend it — which start two moments before this point, so being this close means
  // they could not (no EVR, no host answering, no ledger). Enter the wind-down with `lastWillSec` of
  // hosting left; leave it once a full moment more than that is paid for again (hysteresis).
  windDown() {
    const { state, config } = this;
    const lease = state.treasury.lease;
    const peersConnected = () => [...this.connected].filter((pub) => state.peers[pub]).sort();
    if (!config.lastWillSec) {
      if (state.lastWill) { state.lastWill = null; this.note('last will disabled by configuration; back to normal operation'); }
      return;
    }
    if (!lease) return;
    const left = lease.deadlineMs - this.ts;
    if (!state.lastWill) {
      // A cluster's first rounds: its leases may be short by design (a fresh deployment) and
      // the first renewals are still to come.
      if (state.rounds < config.lastWillGraceRounds) return;
      if (left > config.lastWillSec * 1000) return;
      state.lastWill = { sinceLcl: this.lcl, sinceTs: this.ts, deadlineMs: lease.deadlineMs };
      this.note(`last will: the signer quorum's hosting ends in ${Math.max(0, Math.round(left / 60000))} min and was not extended; winding down`);
      for (const pub of peersConnected()) this.out(pub, this.lastWillNotice(pub));
    } else if (left >= config.lastWillSec * 1000 + (lease.momentMs || DEFAULT_MOMENT_MS)) {
      state.lastWill = null;
      this.note('last will: hosting extended again; back to normal operation');
      for (const pub of peersConnected()) this.out(pub, { t: 'last_will', active: false, deadline: lease.deadlineMs });
    } else {
      state.lastWill.deadlineMs = lease.deadlineMs; // keep telling peers the current deadline
    }
  }

  lastWillNotice(pub) {
    const p = this.state.peers[pub];
    const home = payoutHome(this.state, pub);
    const msg = { t: 'last_will', active: true, deadline: this.state.lastWill.deadlineMs, balance: p ? p.balance : '0', payoutTo: home ? home.address : null, payoutSource: home ? home.source : null };
    if (!home) msg.hint = 'no payout address and no channel of yours is known: send settle_to to be paid out';
    return msg;
  }

  payoutFailed(id, po, reason, hash, { countsAsFailure = true } = {}) {
    const { state } = this;
    const peer = state.peers[po.peer];
    if (peer) {
      // Money never left: give it back, and do not try again every round (fees are charged even
      // for a rejected Payment — a destination that does not exist would drain the account).
      // A submission that never happened cost nothing and is not the address's fault.
      peer.balance = sstr(toSigned(peer.balance) + toBig(po.amount));
      if (peer.pendingPayout === id) peer.pendingPayout = null;
      if (countsAsFailure) {
        peer.payoutFailures = (peer.payoutFailures || 0) + 1;
        peer.payoutBackoffUntilLcl = this.lcl + payoutBackoff(peer.payoutFailures);
      }
    }
    delete state.payouts[id];
    const msg = { t: 'payout', status: 'failed', amt: po.amount, reason };
    if (hash) msg.tx = hash;
    if (peer) msg.retryAfterRounds = Math.max(0, (peer.payoutBackoffUntilLcl || 0) - this.lcl);
    if (po.lastWill) msg.lastWill = true;
    this.out(po.peer, msg);
  }

  settleTx(hash, ok, resultCode) {
    const { state } = this;
    for (const [id, p] of Object.entries(state.payouts)) {
      if (p.txHash !== hash || p.status !== 'submitted') continue;
      const peer = state.peers[p.peer];
      if (ok) {
        p.status = 'validated';
        if (peer) { peer.payoutFailures = 0; peer.payoutBackoffUntilLcl = 0; if (peer.pendingPayout === id) peer.pendingPayout = null; }
        const msg = { t: 'payout', status: 'validated', amt: p.amount, tx: hash };
        if (p.lastWill) msg.lastWill = true;
        this.out(p.peer, msg);
        delete state.payouts[id];
      } else {
        this.payoutFailed(id, p, resultCode, hash);
      }
    }
    for (const ch of Object.values(state.channels)) {
      if (ch.redeemPending && ch.redeemPending.hash === hash && !ok) ch.redeemPending = null;
      if (ch.closePending && ch.closePending.hash === hash && !ok) ch.closePending = null;
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

  // A packet whose next hop went away would otherwise hold the sender's funds until expiry.
  // Runs after inputs so a Fulfill that arrived in the same round as the disconnect still wins.
  sweepDisconnected() {
    const { state } = this;
    for (const [outId, pend] of Object.entries(state.pending)) {
      if (this.connected.has(pend.to)) continue;
      this.releaseHold(pend, true);
      delete state.pending[outId];
      state.stats.rejects += 1;
      this.out(pend.from, codec.ilpOut(pend.inId, ilp.reject('T01', 'peer disconnected', this.config.ilpAddress)));
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
    ensurePeer(this.state, peer, this.lcl, this.config);
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
    if (state.lastWill) return rej('F02', 'connector is winding down: its hosting ends soon and balances are being paid out');
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
    if (state.lastWill) return ack(false, { reason: 'connector is winding down', deadline: state.lastWill.deadlineMs });
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
    const p = state.peers[peer];
    if (!ch.peer) {
      ch.peer = peer;
      // The account this peer's money came from: where it goes back to if the peer never names a
      // payout address and the connector has to wind down. Remembered here because the channel
      // itself may be closed and gone from state by then.
      if (!p.channelOwner && ch.owner) p.channelOwner = ch.owner;
    }
    ch.lastClaimAmount = str(amt);
    ch.lastClaimSig = signature;
    p.balance = sstr(toSigned(p.balance) + credit);
    state.stats.claims += 1;
    ack(true, { credited: str(credit), balance: p.balance });
  }

  handleSettleTo(peer, { address, tag }) {
    const p = this.state.peers[peer];
    const sameTag = (p.payoutTag === null || p.payoutTag === undefined) ? (tag === null || tag === undefined) : p.payoutTag === tag;
    if (p.payoutAddress !== address || !sameTag) {
      p.payoutFailures = 0; p.payoutBackoffUntilLcl = 0; // a new address deserves a fresh attempt; the same one does not
    }
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

  planRenewals() {
    const { state, config } = this;
    if (!state.leases) state.leases = {}; // state written before renewals existed
    const lease = state.treasury.lease;
    const nodes = lease && Array.isArray(lease.nodes) ? lease.nodes : [];
    // Bookkeeping for nodes that are gone (pruned, replaced) goes with them.
    const known = new Set(nodes.map((n) => n.id));
    for (const id of Object.keys(state.leases)) if (!known.has(id)) delete state.leases[id];
    if (!config.leaseExtendAheadMoments || !nodes.length) return;
    const ahead = config.leaseExtendAheadMoments * (lease.momentMs || DEFAULT_MOMENT_MS);
    const due = nodes
      .filter((n) => typeof n.expiresAt === 'number' && !n.nomadPending && !n.maxReached && n.expiresAt - this.ts <= ahead)
      .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1));
    for (const n of due) {
      const rec = state.leases[n.id] || { pending: null, attempts: 0, backoffUntilLcl: 0, lastLcl: 0, extendedLcl: 0, moments: 0, expiresAt: null };
      // A renewal whose result never came back: the round that submitted it died. Whether the
      // payment went out is unknown; count it as failed and try again after a backoff (a second
      // payment only buys the node more life, and the fact then underestimates it, which is safe).
      if (rec.pending && this.lcl - rec.lastLcl >= LEASE_PENDING_ROUNDS) {
        rec.pending = null; rec.attempts += 1; rec.backoffUntilLcl = this.lcl + leaseBackoff(rec.attempts);
        this.note(`lease: renewal of ${n.id.slice(0, 10)} planned at lcl ${rec.lastLcl} never reported back; retrying after ${rec.backoffUntilLcl - this.lcl} rounds`);
        state.leases[n.id] = rec;
      }
      if (rec.pending || rec.backoffUntilLcl > this.lcl) continue;
      // Just renewed, and the fact has not caught up with the ledger yet: not again — unless it
      // never catches up, in which case one more purchase beats a lapsed lease.
      if (rec.extendedLcl && rec.expiresAt === n.expiresAt && this.lcl - rec.extendedLcl < LEASE_FACT_LAG_ROUNDS) continue;
      if (this.intents.length >= MAX_INTENTS_PER_ROUND) return;
      // How much to buy: the configured amount, within the node's maximum life, and — when the
      // fact says what a moment costs — within the EVR on hand (never less than one moment).
      let moments = config.leaseExtendMoments;
      if (n.maxLife > 0 && n.life >= 0) moments = Math.min(moments, n.maxLife - n.life);
      if (n.leaseAmount > 0) {
        const evr = Number(state.treasury.evrBalance) - (Number(state.treasury.evrSpentSinceFact) || 0);
        if (Number.isFinite(evr)) moments = Math.min(moments, Math.floor(evr / n.leaseAmount + 1e-9));
      }
      if (moments < 1) { this.note(`lease: cannot afford a moment for ${n.id.slice(0, 10)} (EVR ${state.treasury.evrBalance})`); continue; }
      const intentId = nextId(state, 'x');
      rec.pending = intentId; rec.lastLcl = this.lcl; rec.moments = moments; rec.expiresAt = n.expiresAt;
      state.leases[n.id] = rec;
      this.note(`lease: renewing ${n.id.slice(0, 10)} by ${moments} moments (${Math.max(0, Math.round((n.expiresAt - this.ts) / 60000))} min left${rec.attempts ? `, attempt ${rec.attempts + 1}` : ''})`);
      this.intents.push({ id: intentId, kind: 'extend', node: n.id, moments });
      return; // one renewal per round: each is a multisign election of its own
    }
  }

  plan() {
    const { state, config } = this;
    this.prunePeers();
    if (!config.masterAddress) return;
    const master = config.masterAddress;
    const fee = config.baseFeeDrops;
    const winding = !!state.lastWill;
    // Each intent is a multisign election over NPL and a ledger submission; a round that tries
    // to do dozens would hit HotPocket's execution limit and die with its submissions
    // unrecorded. Whatever does not fit is planned in the next round — the order is
    // deterministic, so every node defers the same ones.
    const room = () => this.intents.length < MAX_INTENTS_PER_ROUND;

    const ledger = state.treasury.ledgerIndex || 0;

    // 0. Keep the hosts paid. The lease fact lists every node with the time its hosting is paid
    //    until; the one closest to running out is renewed first, one per round, and a node whose
    //    host would not take the payment waits out a backoff of its own so the others get their
    //    turn. Nodes everpocket is still buying initial life for, and nodes at their maximum, are
    //    left to it. This comes before everything else: a cluster that dies can do nothing else.
    this.planRenewals();

    // 1. Redeem channels: on threshold, as soon as the owner starts closing them — and all of
    //    them, whatever the amount, while winding down (a claim not on the ledger dies with us).
    //    Closing channels first: their claims die with the settle delay, the others can wait.
    const channels = Object.entries(state.channels).sort(([a], [b]) => (a < b ? -1 : 1));
    const bareCloses = [];
    for (const closingFirst of [true, false]) {
      for (const [id, ch] of channels) {
        if (ch.redeemPending && this.lcl - (ch.redeemPending.lcl || this.lcl) > REDEEM_RETRY_ROUNDS) {
          this.note(`channel ${id}: redemption ${ch.redeemPending.intentId} never confirmed; retrying`);
          ch.redeemPending = null;
        }
        if (ch.redeemPending) continue;
        const unredeemed = toBig(ch.lastClaimAmount) - toBig(ch.ledgerBalance);
        const closing = !!ch.expiration;
        if (closing !== closingFirst) continue;
        if (unredeemed <= 0n) {
          // Nothing left to redeem but the owner wants out: close it for them right away (the
          // destination's tfClose is immediate) instead of making them wait out the settle delay.
          if (ch.closePending && this.lcl - (ch.closePending.lcl || this.lcl) > REDEEM_RETRY_ROUNDS) ch.closePending = null;
          if (closing && !ch.closePending) bareCloses.push([id, ch]);
          continue;
        }
        if (!closing && !winding && unredeemed < toBig(config.redeemThresholdDrops)) continue;
        if (!room()) continue;
        const intentId = nextId(state, 'r');
        ch.redeemPending = { intentId, amount: ch.lastClaimAmount, hash: null, lcl: this.lcl, ledger };
        const tx = {
          TransactionType: 'PaymentChannelClaim', Account: master, Channel: id,
          Balance: ch.lastClaimAmount, Amount: ch.lastClaimAmount,
          Signature: ch.lastClaimSig, PublicKey: ch.publicKey, Fee: fee, Memos: intentMemo(intentId),
        };
        // The owner asked to close: as the destination we can close it at once (tfClose), which
        // returns the unclaimed remainder to the owner without waiting out the settle delay.
        if (closing) tx.Flags = TF_CLOSE;
        this.intents.push({ id: intentId, kind: 'redeem', channel: id, tx });
      }
    }

    // 2. Pay peers out, but only from funds that are really on the ledger. Normally on the
    //    threshold or on request, to the registered address; while winding down, everyone with
    //    a known home, whatever the amount (above dust), each time a balance appears — redeemed
    //    claims and released holds included — for as long as the cluster can still sign. The
    //    wind-down keeps back only the ledger's own reserve, not the operating buffer: the
    //    buffer is peers' money too once there is no tomorrow to buffer for.
    const reserve = winding ? bigMin(toBig(config.reserveDrops), toBig(config.lastWillReserveDrops)) : toBig(config.reserveDrops);
    let available = toBig(state.treasury.masterBalance) - reserve;
    for (const po of Object.values(state.payouts)) available -= toBig(po.amount);
    const peers = Object.keys(state.peers).sort(); // deterministic order
    for (const pub of peers) {
      if (!room()) break;
      const p = state.peers[pub];
      if (p.pendingPayout || (p.payoutBackoffUntilLcl || 0) > this.lcl) continue;
      const bal = toSigned(p.balance);
      let home = p.payoutAddress ? { address: p.payoutAddress, tag: p.payoutTag } : null;
      if (winding) {
        home = home || payoutHome(state, pub);
        if (!home || bal < toBig(config.lastWillMinDrops)) continue;
      } else {
        const due = bal >= toBig(config.payoutThresholdDrops) || (p.withdrawRequested && bal >= toBig(config.minPayoutDrops));
        if (!home || !due) continue;
      }
      if (bal > available) { this.note(`payout to ${pub} deferred: waiting for redemptions`); continue; }
      const intentId = nextId(state, 'p');
      p.balance = '0';
      p.withdrawRequested = false;
      p.pendingPayout = intentId;
      const tag = home.tag !== null && home.tag !== undefined ? home.tag : null;
      state.payouts[intentId] = { peer: pub, amount: str(bal), destination: home.address, tag, status: 'planned', txHash: null, lcl: this.lcl, plannedLedger: ledger, lastWill: winding };
      available -= bal;
      const tx = { TransactionType: 'Payment', Account: master, Destination: home.address, Amount: str(bal), Fee: fee, Memos: intentMemo(intentId) };
      if (tag !== null) tx.DestinationTag = tag;
      this.intents.push({ id: intentId, kind: 'payout', peer: pub, tx });
    }

    // 3. Channels with nothing left to redeem whose owners want out: close them (immediate for
    //    the destination). Last among the channel work: nothing is at stake but the owner's wait.
    for (const [id, ch] of bareCloses) {
      if (!room()) break;
      const intentId = nextId(state, 'c');
      ch.closePending = { intentId, hash: null, lcl: this.lcl, ledger };
      this.intents.push({ id: intentId, kind: 'close', channel: id, tx: { TransactionType: 'PaymentChannelClaim', Account: master, Channel: id, Flags: TF_CLOSE, Fee: fee, Memos: intentMemo(intentId) } });
    }

    // 4. Treasury: keep enough EVR to pay the hosts, bought with earned XAH on the DEX.
    const t = state.treasury;
    // An offer planned by a round that died before recording its submission: let it go after a while.
    if (t.offerPending && !t.offerPending.hash && this.lcl - (t.offerPending.lcl || this.lcl) > OFFER_BACKOFF_ROUNDS) t.offerPending = null;
    const offerAllowed = !t.offerPending && (t.offerBackoffUntilLcl || 0) <= this.lcl && room();
    if (offerAllowed && Number(t.evrBalance) < Number(config.evrReserve)) {
      const equity = toBig(t.masterBalance) - toBig(config.reserveDrops) - this.liabilities();
      const spend = toBig(config.evrTopUpXahDrops);
      if (equity >= spend) {
        const intentId = nextId(state, 'o');
        t.offerPending = { intentId, hash: null, spend: str(spend), lcl: this.lcl, ledger };
        this.intents.push({
          id: intentId, kind: 'evr-topup',
          tx: {
            TransactionType: 'OfferCreate', Account: master, Fee: fee,
            TakerGets: str(spend), // we give XAH
            TakerPays: { currency: 'EVR', issuer: config.evrIssuer, value: String(config.evrTopUpMinEvr) },
            Flags: 0x00080000, // tfImmediateOrCancel: fill what the book has, never rest an order
            Memos: intentMemo(intentId),
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
      const leaseNode = Object.keys(state.leases || {}).find((id) => state.leases[id].pending === r.id);
      if (leaseNode) {
        const rec = state.leases[leaseNode];
        rec.pending = null;
        if (r.ok) {
          rec.attempts = 0; rec.backoffUntilLcl = 0; rec.extendedLcl = this.lcl; rec.lastHash = r.hash || null;
          const node = ((state.treasury.lease && state.treasury.lease.nodes) || []).find((n) => n.id === leaseNode);
          if (node && node.leaseAmount > 0) state.treasury.evrSpentSinceFact = (Number(state.treasury.evrSpentSinceFact) || 0) + node.leaseAmount * rec.moments;
          this.note(`lease: ${leaseNode.slice(0, 10)} renewed by ${rec.moments} moments (${r.hash || 'no hash'})`);
        } else {
          rec.attempts += 1;
          rec.backoffUntilLcl = this.lcl + leaseBackoff(rec.attempts);
          this.note(`lease: ${leaseNode.slice(0, 10)} renewal failed (${String(r.error || r.resultCode || 'unknown').slice(0, 120)}); attempt ${rec.attempts}, next in ${rec.backoffUntilLcl - this.lcl} rounds`);
        }
        continue;
      }
      const po = state.payouts[r.id];
      if (po) {
        if (r.ok) {
          po.status = 'submitted'; po.txHash = r.hash;
          const msg = { t: 'payout', status: 'submitted', amt: po.amount, tx: r.hash };
          if (po.lastWill) msg.lastWill = true;
          this.out(po.peer, msg);
        } else {
          this.payoutFailed(r.id, po, r.error || r.resultCode, null);
        }
        continue;
      }
      for (const ch of Object.values(state.channels)) {
        if (ch.redeemPending && ch.redeemPending.intentId === r.id) {
          if (r.ok) ch.redeemPending.hash = r.hash; else ch.redeemPending = null;
        }
        if (ch.closePending && ch.closePending.intentId === r.id) {
          if (r.ok) ch.closePending.hash = r.hash; else ch.closePending = null;
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
  rc.windDown();
  rc.sweepExpired();
  for (const { peer, raw } of input.inputs || []) rc.handleInput(peer, raw);
  rc.sweepDisconnected();
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
        lastWillSec: config.lastWillSec, winding: !!state.lastWill, lastWill: state.lastWill || null,
        lease: state.treasury.lease || null, leaseNote: state.treasury.leaseNote || null,
        leases: state.leases || {},
      };
    case 'balance':
      return {
        t: 'balance', balance: p ? p.balance : '0', held: p ? p.held : '0',
        payoutAddress: p ? p.payoutAddress : null, pendingPayout: p && p.pendingPayout ? state.payouts[p.pendingPayout] : null,
        lastWillTo: payoutHome(state, peer),
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
  DEFAULT_CONFIG, makeConfig, initialState, processRound, handleReadRequest, peerAddress, payoutHome,
  intentMemo, intentIdFromMemos, MEMO_TYPE, STATE_VERSION,
};
