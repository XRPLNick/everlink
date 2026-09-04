'use strict';

// A tiny in-memory stand-in for the Xahau ledger: XAH balances, an EVR IOU balance,
// payment channels with real claim-signature verification, multisigned submissions that
// are idempotent per intent (so N cluster nodes submitting the same tx behave like
// rippled returning tefALREADY/tefPAST_SEQ to all but one), validation on ledger close,
// an "instant fill" DEX for XAH->EVR, and Evernode-style leases that a host must be paid
// for in EVR.

const crypto = require('crypto');
const { verifyClaim } = require('../contract/src/core/claims');

class MockXahau {
  constructor({ evrIssuer = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', dropsPerEvr = 250000n } = {}) {
    this.evrIssuer = evrIssuer;
    this.dropsPerEvr = dropsPerEvr; // DEX price: 0.25 XAH per EVR
    this.ledgerIndex = 1;
    this.accounts = new Map(); // address -> { balance: bigint, evr: number }
    this.channels = new Map(); // id -> channel
    this.applied = new Map();  // dedupeKey -> result
    this.txByHash = new Map(); // hash -> { tx, resultCode, ledgerIndex }
    this.pendingValidation = [];
    this.validated = [];       // { hash, resultCode, ledgerIndex }
    this.leases = new Map();   // nodePubkey -> { host, expiresAt, evrPerMoment, momentMs }
    this.log = [];
  }

  acct(addr) {
    if (!this.accounts.has(addr)) this.accounts.set(addr, { balance: 0n, evr: 0 });
    return this.accounts.get(addr);
  }
  fund(addr, drops) { this.acct(addr).balance += BigInt(drops); }
  fundEvr(addr, evr) { this.acct(addr).evr += Number(evr); }
  balance(addr) { return this.acct(addr).balance; }
  evr(addr) { return this.acct(addr).evr; }

  // Peer-side helper: open a channel to the connector (a normal single-signed tx).
  createChannel({ account, destination, amount, publicKey, settleDelay = 3600 }) {
    const a = this.acct(account);
    amount = BigInt(amount);
    if (a.balance < amount) throw new Error('tecUNFUNDED');
    a.balance -= amount;
    const id = crypto.createHash('sha256').update(`${account}|${destination}|${this.ledgerIndex}|${this.channels.size}`).digest('hex').toUpperCase();
    this.channels.set(id, { id, account, destination, amount, balance: 0n, publicKey, settleDelay, expiration: null });
    return id;
  }
  fundChannel(id, drops) {
    const ch = this.channels.get(id); const a = this.acct(ch.account);
    drops = BigInt(drops);
    if (a.balance < drops) throw new Error('tecUNFUNDED');
    a.balance -= drops; ch.amount += drops;
  }
  // Owner asks to close: sets expiration = now + settleDelay (the connector must redeem before then).
  requestClose(id, nowMs) {
    const ch = this.channels.get(id);
    ch.expiration = nowMs + ch.settleDelay * 1000;
  }
  accountChannels(destination) {
    return [...this.channels.values()].filter((c) => c.destination === destination).map((c) => ({
      id: c.id, account: c.account, destination: c.destination, amount: c.amount.toString(), balance: c.balance.toString(),
      publicKey: c.publicKey, settleDelay: c.settleDelay, expiration: c.expiration,
    }));
  }

  // The cluster's multisigned submissions. `dedupeKey` (the intent id) makes the call
  // idempotent across nodes, standing in for sequence-number collisions on a real ledger.
  submitMultisigned(tx, dedupeKey) {
    if (this.applied.has(dedupeKey)) return this.applied.get(dedupeKey);
    const hash = crypto.createHash('sha256').update(JSON.stringify(tx)).update(dedupeKey).digest('hex').toUpperCase();
    let resultCode = 'tesSUCCESS';
    try { this.apply(tx); } catch (e) { resultCode = e.message; }
    const result = { hash, resultCode };
    this.applied.set(dedupeKey, result);
    this.txByHash.set(hash, { tx, resultCode, ledgerIndex: this.ledgerIndex });
    if (resultCode === 'tesSUCCESS' || resultCode.startsWith('tec')) this.pendingValidation.push({ hash, resultCode });
    this.log.push({ ledgerIndex: this.ledgerIndex, type: tx.TransactionType, resultCode, hash });
    return result;
  }

  apply(tx) {
    const from = this.acct(tx.Account);
    const fee = BigInt(tx.Fee || 0);
    switch (tx.TransactionType) {
      case 'Payment': {
        if (typeof tx.Amount === 'string') {
          const amt = BigInt(tx.Amount);
          if (from.balance < amt + fee) throw new Error('tecUNFUNDED_PAYMENT');
          from.balance -= amt + fee;
          this.acct(tx.Destination).balance += amt;
        } else if (tx.Amount && tx.Amount.currency === 'EVR') {
          const v = Number(tx.Amount.value);
          if (from.evr < v) throw new Error('tecPATH_PARTIAL');
          from.evr -= v; from.balance -= fee;
          this.acct(tx.Destination).evr += v;
        } else throw new Error('temBAD_AMOUNT');
        return;
      }
      case 'PaymentChannelClaim': {
        const ch = this.channels.get(tx.Channel);
        if (!ch) throw new Error('tecNO_ENTRY');
        if (tx.Account !== ch.destination && tx.Account !== ch.account) throw new Error('tecNO_PERMISSION');
        if (tx.Balance !== undefined) {
          const balance = BigInt(tx.Balance);
          const amount = BigInt(tx.Amount || tx.Balance);
          if (tx.Account !== ch.account) {
            if (!verifyClaim({ channel: tx.Channel, amount: amount.toString(), signature: tx.Signature, publicKey: tx.PublicKey })) throw new Error('temBAD_SIGNATURE');
            if (tx.PublicKey !== ch.publicKey) throw new Error('temBAD_SIGNER');
          }
          if (balance > amount || balance > ch.amount) throw new Error('tecUNFUNDED_PAYMENT');
          if (balance <= ch.balance) throw new Error('tecUNFUNDED_PAYMENT');
          const delta = balance - ch.balance;
          ch.balance = balance;
          this.acct(ch.destination).balance += delta;
        }
        from.balance -= fee;
        // tfClose from the destination closes at once: the unclaimed remainder goes back to the owner.
        if ((Number(tx.Flags || 0) & 0x00020000) && tx.Account === ch.destination) {
          this.acct(ch.account).balance += ch.amount - ch.balance;
          this.channels.delete(ch.id);
        }
        return;
      }
      case 'OfferCreate': {
        // Instant-fill DEX: sell TakerGets XAH for EVR at the fixed price; IOC semantics.
        const gets = BigInt(tx.TakerGets);
        if (from.balance < gets + fee) throw new Error('tecUNFUNDED_OFFER');
        const evrOut = Number(gets / this.dropsPerEvr);
        if (evrOut < Number(tx.TakerPays.value)) throw new Error('tecKILLED'); // limit not met
        from.balance -= gets + fee;
        from.evr += evrOut;
        return;
      }
      default:
        throw new Error('temUNKNOWN');
    }
  }

  // Leases: a node's hosting runs out at `expiresAt` unless the tenant pays the host. A host
  // with `refuse` set will not take the payment (its hook rejects it), as a host that has gone
  // inactive on the Evernode registry would.
  addLease(nodePubkey, { host, expiresAt, evrPerMoment = 2, momentMs = 3600000, refuse = false }) {
    this.leases.set(nodePubkey, { host, expiresAt, evrPerMoment, momentMs, refuse });
  }
  extendLease(tenant, nodePubkey, moments, dedupeKey) {
    const lease = this.leases.get(nodePubkey);
    if (!lease) throw new Error('no lease');
    if (lease.refuse) {
      if (this.applied.has(dedupeKey)) return this.applied.get(dedupeKey);
      const result = { hash: crypto.createHash('sha256').update(dedupeKey).digest('hex').toUpperCase(), resultCode: 'tecHOOK_REJECTED' };
      this.applied.set(dedupeKey, result);
      this.log.push({ ledgerIndex: this.ledgerIndex, type: 'Payment', resultCode: result.resultCode, hash: result.hash, lease: nodePubkey });
      return result;
    }
    const fresh = !this.applied.has(dedupeKey); // N nodes submit the same renewal: one payment, one extension
    const res = this.submitMultisigned({
      TransactionType: 'Payment', Account: tenant, Destination: lease.host, Fee: '12',
      Amount: { currency: 'EVR', issuer: this.evrIssuer, value: String(lease.evrPerMoment * moments) },
      Memos: [{ type: 'evnExtendLease', data: nodePubkey }],
    }, dedupeKey);
    if (fresh && res.resultCode === 'tesSUCCESS') lease.expiresAt += moments * lease.momentMs;
    return res;
  }

  close() {
    this.ledgerIndex += 1;
    for (const v of this.pendingValidation.splice(0)) this.validated.push({ ...v, ledgerIndex: this.ledgerIndex });
  }
  validatedSince(ledgerIndex) {
    return this.validated.filter((v) => v.ledgerIndex > ledgerIndex);
  }
}

module.exports = { MockXahau };
