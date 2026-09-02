'use strict';

// Simulator bridge between the contract and the mock Xahau ledger. It mirrors what the
// production bridge does with everpocket: every node observes the ledger itself, the
// cluster votes over NPL on what it saw, and the majority view becomes the round's facts.
// Submissions are voted on the same way, so a node that saw a different result cannot
// diverge in state.

const { busFor, majority } = require('../contract/src/adapters/npl-vote');

class MockBridge {
  constructor(mock, { masterAddress, factsEvery = 1, voteTimeoutMs = 25, leaseMomentsAhead = 2, leaseExtendMoments = 4 }) {
    this.mock = mock;
    this.master = masterAddress;
    this.factsEvery = factsEvery;
    this.voteTimeoutMs = voteTimeoutMs;
    this.leaseMomentsAhead = leaseMomentsAhead;
    this.leaseExtendMoments = leaseExtendMoments;
    this._closedForRound = 0;
  }

  async observe(ctx, state) {
    if (ctx.lclSeqNo % this.factsEvery !== 0) return null;
    const m = this.mock;
    const since = state.treasury.ledgerIndex || 0;
    const seen = m.validatedSince(since);
    const local = {
      ledgerIndex: m.ledgerIndex,
      masterBalance: m.balance(this.master).toString(),
      evrBalance: String(m.evr(this.master)),
      channels: m.accountChannels(this.master),
      channelsComplete: true,
      validatedTxs: seen.filter((v) => v.resultCode === 'tesSUCCESS').map((v) => ({ hash: v.hash, resultCode: v.resultCode })),
      failedTxs: seen.filter((v) => v.resultCode !== 'tesSUCCESS').map((v) => ({ hash: v.hash, resultCode: v.resultCode })),
    };
    const votes = await busFor(ctx).vote(`facts:${ctx.lclSeqNo}`, local, { expected: ctx.unl.count(), timeoutMs: this.voteTimeoutMs });
    return majority(votes);
  }

  async submit(ctx, intents) {
    const local = intents.map((i) => {
      const r = this.mock.submitMultisigned(i.tx, i.id); // idempotent per intent across nodes
      return { id: i.id, ok: r.resultCode === 'tesSUCCESS', hash: r.hash, resultCode: r.resultCode };
    });
    const votes = await busFor(ctx).vote(`submit:${ctx.lclSeqNo}`, local, { expected: ctx.unl.count(), timeoutMs: this.voteTimeoutMs });
    return majority(votes) || local;
  }

  // Housekeeping that the Nomad model does through everpocket: keep our own hosting paid.
  async afterRound(ctx, state) {
    const m = this.mock;
    for (const [nodePub, lease] of m.leases) {
      const remainingMoments = (lease.expiresAt - ctx.timestamp) / lease.momentMs;
      if (remainingMoments < this.leaseMomentsAhead) {
        // dedupe key includes the expiry so every node extends the same lease exactly once
        const r = m.extendLease(this.master, nodePub, this.leaseExtendMoments, `lease:${nodePub}:${lease.expiresAt}`);
        if (r.resultCode !== 'tesSUCCESS' && this.onLeaseProblem) this.onLeaseProblem(nodePub, r.resultCode);
      }
    }
    // The ledger closes once per round (guard: N nodes call this).
    if (this._closedForRound !== ctx.lclSeqNo) { this._closedForRound = ctx.lclSeqNo; m.close(); }
  }
}

module.exports = { MockBridge };
