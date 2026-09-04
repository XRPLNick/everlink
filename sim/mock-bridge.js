'use strict';

// Simulator bridge between the contract and the mock Xahau ledger. It mirrors what the
// production bridge does with everpocket: every node observes the ledger itself, the
// cluster votes over NPL on what it saw, and the majority view becomes the round's facts.
// Submissions are voted on the same way, so a node that saw a different result cannot
// diverge in state. Lease renewals are the core's "extend" intents, as in production.

const { busFor, majority } = require('../contract/src/adapters/npl-vote');

class MockBridge {
  constructor(mock, { masterAddress, factsEvery = 1, voteTimeoutMs = 25 }) {
    this.mock = mock;
    this.master = masterAddress;
    this.factsEvery = factsEvery;
    this.voteTimeoutMs = voteTimeoutMs;
    this._closedForRound = 0;
  }

  // As the production bridge: every `factsEvery` rounds, and whenever there is ledger work
  // (a settlement or renewal in flight, or a renewal just made) whose outcome the facts carry.
  _hasLedgerWork(state, lcl) {
    return Object.keys(state.payouts).length > 0
      || Object.values(state.channels).some((c) => c.redeemPending)
      || Object.values(state.leases || {}).some((l) => l && (l.pending || (l.extendedLcl && lcl - l.extendedLcl <= 2)))
      || !!state.treasury.offerPending;
  }

  async observe(ctx, state) {
    if (ctx.lclSeqNo % this.factsEvery !== 0 && !this._hasLedgerWork(state, ctx.lclSeqNo)) return null;
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
      lease: this._lease(ctx),
    };
    const votes = await busFor(ctx).vote(`facts:${ctx.lclSeqNo}`, local, { expected: ctx.unl.count(), timeoutMs: this.voteTimeoutMs });
    return majority(votes);
  }

  // The lease fact, as the production bridge derives it from cluster.json and the SignerList:
  // every node with the time its hosting is paid until, and when the hosting of a signing
  // quorum (a majority of the nodes here) runs out.
  _lease(ctx) {
    const leases = [...this.mock.leases.entries()];
    if (!leases.length) return null;
    const nodes = leases.map(([id, l]) => ({ id, expiresAt: l.expiresAt, signer: true, nomadPending: false, maxReached: false, life: 0, maxLife: 0, leaseAmount: l.evrPerMoment })).sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1));
    const expiries = nodes.map((n) => n.expiresAt).sort((a, b) => b - a);
    const quorum = Math.floor(leases.length / 2) + 1;
    return { deadlineMs: expiries[quorum - 1], quorum, signers: leases.length, momentMs: leases[0][1].momentMs, aligned: true, expiries, nodes, asOf: ctx.timestamp };
  }

  async submit(ctx, intents) {
    const local = intents.map((i) => {
      // A lease renewal: the EVR payment to the node's host (everpocket's extend flow, in
      // production). Keyed per round so every node's call is the same one submission.
      const r = i.kind === 'extend'
        ? this.mock.extendLease(this.master, i.node, i.moments, `extend:${i.node}:${ctx.lclSeqNo}`)
        : this.mock.submitMultisigned(i.tx, i.id); // idempotent per intent across nodes
      return { id: i.id, ok: r.resultCode === 'tesSUCCESS', hash: r.hash, resultCode: r.resultCode };
    });
    const votes = await busFor(ctx).vote(`submit:${ctx.lclSeqNo}`, local, { expected: ctx.unl.count(), timeoutMs: this.voteTimeoutMs });
    return majority(votes) || local;
  }

  // The ledger closes once per round (guard: N nodes call this).
  async afterRound(ctx) {
    if (this._closedForRound !== ctx.lclSeqNo) { this._closedForRound = ctx.lclSeqNo; this.mock.close(); }
  }
}

module.exports = { MockBridge };
