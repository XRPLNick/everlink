'use strict';

// The production bridge cannot reach Xahau from a unit test, so everpocket is replaced by a
// fake with the same surface (VoteContext over the simulator's NPL, XrplContext backed by
// the mock ledger). This proves the bridge's observe/submit/afterRound wiring and that the
// core stays consensus-safe when driven through it on a 3-node simulated cluster.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SimCluster, SimClient, edKeys } = require('../sim/hotpocket-sim');
const { MockXahau } = require('../sim/mock-xahau');
const { XahauBridge, leaseDeadline, EVERNODE_CACHE_FILE, LEASE_TIMESTAMP_SLACK_SEC, LEDGERS_UNTIL_LOST } = require('../contract/src/adapters/xahau-bridge');
const { runRound } = require('../contract/src/round');
const { makeConfig, intentMemo } = require('../contract/src/core/connector');
const stateStore = require('../contract/src/core/state');
const H = require('./helpers');

const MASTER = 'rEverlinkMasterAccountFake1111111111';
const MOMENT = 3600;
// Evernode's moment clock for the fakes: moments start at BASE_IDX + k × 3600 (unix seconds).
const BASE_IDX = Math.floor(Date.now() / 1000) - 3000; // we are 3000 s into the current moment
const SIGNERS = ['rSignerA111111111111111111111111111', 'rSignerB111111111111111111111111111', 'rSignerC111111111111111111111111111'];
const SIGNER_LIST = { LedgerEntryType: 'SignerList', SignerQuorum: 2, SignerEntries: SIGNERS.map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) };

// everpocket's cluster.json as evdevkit writes it, one signer node per cluster node.
function writeClusterJson(cluster, lifeMoments, createdOnTimestamp = Date.now()) {
  const nodes = cluster.nodes.map((n, i) => ({ pubkey: n.publicKey, signerAddress: SIGNERS[i], isUnl: true, isQuorum: true, lifeMoments, targetLifeMoments: lifeMoments, maxLifeMoments: 0, createdOnTimestamp, host: `rHost${i}`, owner: 0, status: { status: 1, onLcl: 0 } }));
  for (const n of cluster.nodes) fs.writeFileSync(path.join(n.stateDir, 'cluster.json'), JSON.stringify({ initialized: true, nodes, pendingNodes: [] }));
}

function fakeEverpocket(mock, calls, forgotten = new Set()) {
  // Same shape as everpocket's VoteContext: the bridge registers ctx.unl.onMessage once and
  // feeds every NPL message here; vote() broadcasts and collects for one election.
  class VoteContext {
    constructor(ctx) { this.ctx = ctx; this.n = 0; this.elections = new Map(); }
    getUniqueNumber() { return this.n++; }
    election(name) { if (!this.elections.has(name)) this.elections.set(name, { votes: [], waiters: [] }); return this.elections.get(name); }
    feedUnlMessage(sender, msg) {
      const { e, d } = JSON.parse(msg.toString());
      const el = this.election(e); el.votes.push({ sender, data: d }); el.waiters.forEach((w) => w());
    }
    async vote(name, votes, elector) {
      const el = this.election(name);
      await this.ctx.unl.send(JSON.stringify({ e: name, d: votes[0] }));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, elector.timeout);
        el.waiters.push(() => { if (el.votes.length >= elector.count) { clearTimeout(timer); resolve(); } });
        if (el.votes.length >= elector.count) { clearTimeout(timer); resolve(); }
      });
      return el.votes.slice();
    }
  }
  class AllVoteElector { constructor(count, timeout) { this.count = count; this.timeout = timeout; } }
  class HotPocketContext {
    constructor(ctx, { voteContext }) { this.ctx = ctx; this.voteContext = voteContext; this.lclSeqNo = ctx.lclSeqNo; this.timestamp = ctx.timestamp; }
    getContractUnl() { return this.ctx.unl.list(); }
  }
  class XrplContext {
    constructor(hpContext, address) {
      this.hpContext = hpContext; this.voteContext = hpContext.voteContext; this.address = address;
      this.xrplApi = {
        get ledgerIndex() { return mock.ledgerIndex; },
        // rippled `tx`: the ledger's own record, whatever everpocket remembers.
        getTxnInfo: async (hash) => {
          const v = mock.validated.find((x) => x.hash === hash);
          if (!v) throw new Error('txnNotFound');
          return { hash, validated: true, meta: { TransactionResult: v.resultCode }, ledger_index: v.ledgerIndex };
        },
      };
      this.xrplAcc = {
        getInfo: async () => ({ Balance: mock.balance(address).toString() }),
        getAccountObjects: async ({ type }) => {
          if (type === 'signer_list') return [SIGNER_LIST];
          if (type !== 'payment_channel') return [];
          return mock.accountChannels(address).map((c) => ({
            LedgerEntryType: 'PayChannel', index: c.id, Account: c.account, Destination: c.destination, PublicKey: c.publicKey,
            Amount: c.amount, Balance: c.balance, SettleDelay: c.settleDelay, Expiration: c.expiration ? Math.floor((c.expiration - 946684800000) / 1000) : undefined,
          }));
        },
        getTrustLines: async () => [{ currency: 'EVR', balance: String(mock.evr(address)) }],
        // account_tx as rippled returns it (API v1 shape), validated transactions only.
        getAccountTrx: async (minLedger) => mock.validated.filter((v) => v.ledgerIndex >= minLedger).map((v) => {
          const rec = mock.txByHash.get(v.hash);
          return { tx: { ...rec.tx, hash: v.hash }, meta: { TransactionResult: v.resultCode }, validated: true, ledger_index: v.ledgerIndex };
        }),
      };
      this.submitted = [];
    }
    async init() {
      calls.push('xrpl.init');
      // as everpocket: the list it signs with, loaded at init
      this.signerListInfo = { signerQuorum: SIGNER_LIST.SignerQuorum, signerList: SIGNER_LIST.SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) };
    }
    async deinit() { calls.push('xrpl.deinit'); }
    // everpocket's transactions.json — minus what a process killed before deinit never wrote.
    getValidatedTransactions() { return mock.validated.filter((v) => !forgotten.has(v.hash)).map((v) => ({ hash: v.hash, resultCode: v.resultCode })); }
    getPendingTransactions() { return mock.pendingValidation.filter((v) => !forgotten.has(v.hash)).map((v) => ({ hash: v.hash })); }
    async multiSignAndSubmitTransaction(tx) {
      // Real everpocket votes on the sequence, gathers signatures, submits once. Emulated by
      // the idempotent mock keyed on the tx body plus a per-round vote on the result.
      const key = JSON.stringify(tx);
      this.submitted.push(tx);
      if (tx.SigningPubKey !== '' || tx.NetworkID !== 21338) throw new Error('Xahau multisig envelope missing (SigningPubKey "", NetworkID)');
      const r = mock.submitMultisigned(tx, key);
      const votes = await this.voteContext.vote(`txSubmit${this.voteContext.getUniqueNumber()}`, [r], new AllVoteElector(this.hpContext.getContractUnl().length, 50));
      return votes[0].data;
    }
  }
  class EvernodeContext {
    constructor(x) { this.xrplContext = x; }
    getEvernodeConfig() { return { momentSize: MOMENT, momentBaseInfo: { baseIdx: BASE_IDX, baseTransitionMoment: 0 } }; }
    async deinit() { calls.push('evernode.deinit'); }
  }
  class ClusterContext { constructor(e) { this.evernodeContext = e; } async init() {} async deinit() { calls.push('cluster.deinit'); } async feedUserMessage(user, raw) { calls.push(`cluster.msg:${JSON.parse(raw.toString()).type}`); await user.send(JSON.stringify({ type: 'maturity_ack', status: 'ok' })); } }
  class NomadContext { constructor(c, o) { this.clusterContext = c; this.options = o; } async init() { calls.push('nomad.init'); } async deinit() { calls.push('nomad.deinit'); } }
  return { VoteContext, AllVoteElector, HotPocketContext, XrplContext, EvernodeContext, ClusterContext, NomadContext };
}

test('XahauBridge drives the core through fake everpocket on a 3-node cluster', async (t) => {
  const mock = new MockXahau();
  mock.fund(MASTER, 60_000_000n); mock.fundEvr(MASTER, 25);
  const calls = []; const forgotten = new Set();
  const config = makeConfig({ masterAddress: MASTER, feeBps: 100, minExpiryWindowMs: 300, redeemThresholdDrops: '1000000', payoutThresholdDrops: '1000000', lastWillGraceRounds: 3 });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'everlink-bridge-'));
  const bridge = new XahauBridge({
    masterAddress: MASTER, network: 'testnet', evrIssuer: config.evrIssuer, factsEvery: 1, nomadEvery: 1,
    nomad: { targetNodeCount: 3, lifeIncrMomentMinLimit: 2 }, evp: fakeEverpocket(mock, calls, forgotten), cacheDir,
  });
  const cluster = new SimCluster({ nodeCount: 3, roundTimeMs: 25, handler: (ctx) => runRound(ctx, { stateDir: ctx.sim.stateDir, config, bridge }) });
  t.after(() => cluster.stop());
  cluster.on('error', (e) => { throw e; });
  writeClusterJson(cluster, 5); // three signer nodes, five moments of hosting each

  const alice = new SimClient(cluster, edKeys()); const bob = new SimClient(cluster, edKeys());
  await alice.connect(); await bob.connect();
  const aOut = []; const bOut = [];
  alice.on('contract_output', ({ outputs }) => outputs.forEach((o) => aOut.push(JSON.parse(o))));
  bob.on('contract_output', ({ outputs }) => outputs.forEach((o) => bOut.push(JSON.parse(o))));

  const aliceX = H.channelKeys();
  mock.fund(aliceX.address, 20_000_000n);
  const channel = mock.createChannel({ account: aliceX.address, destination: MASTER, amount: 5_000_000n, publicKey: aliceX.publicKey });

  // A cluster-management message must be swallowed by the bridge, not the connector.
  await bob.submitContractInput(JSON.stringify({ type: 'maturity_ack', data: bob.publicKey }));
  await cluster.runRound();
  assert.ok(calls.includes('cluster.msg:maturity_ack'));
  assert.equal(bOut[0].type, 'maturity_ack');

  await alice.submitContractInput(H.claimInput(channel, 2_500_000, aliceX.privateKey));
  await bob.submitContractInput(JSON.stringify({ t: 'settle_to', addr: 'rBobPayoutAddress1111111111111111' }));
  await cluster.runRound();
  assert.equal(aOut.at(-1).ok, true);

  const { fulfillment, condition } = H.condition();
  await alice.submitContractInput(H.prepareInput('x', { amount: 1_500_000, destination: H.peerAddress(config, bob.publicKey), expiresAt: Date.now() + 20_000, condition }));
  await cluster.runRound();
  const fwd = bOut.find((m) => m.t === 'ilp');
  await bob.submitContractInput(H.fulfillInput(fwd.id, fulfillment));
  await cluster.runRound(); // fulfill; redemption (2.5 XAH) + payout (1.485 XAH) planned and submitted via "multisig"
  mock.close();
  await cluster.runRound(); // facts: validated
  await cluster.runRound();

  assert.equal(mock.channels.get(channel).balance, 2_500_000n, 'redeemed through the bridge');
  assert.equal(mock.balance('rBobPayoutAddress1111111111111111'), 1_485_000n, 'paid out through the bridge');
  assert.ok(bOut.some((m) => m.t === 'payout' && m.status === 'validated'));
  assert.ok(calls.includes('nomad.init'), 'nomad housekeeping ran');
  assert.ok(calls.filter((c) => c === 'xrpl.deinit').length >= 3, 'contexts are torn down every round');
  assert.equal(cluster.forked, false);

  // The lease fact came through the vote: the Nomad phase cached Evernode's moment clock, a vote
  // carried it into the agreed state, and the deadline is the moment boundary the hosts will act
  // on — 5 moments after the one the nodes were bought in (we are 3000 s into the current moment,
  // the stamp is placed 900 s later than the purchase, so still this moment) — for a 2-of-3
  // quorum. No last will: more than four hours of hosting left.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, EVERNODE_CACHE_FILE), 'utf8')).momentSec, MOMENT);
  let state = stateStore.load(cluster.nodes[0].stateDir);
  assert.deepEqual(state.treasury.clock, { momentSec: MOMENT, baseIdx: BASE_IDX });
  assert.equal(state.treasury.lease.quorum, 2);
  assert.equal(state.treasury.lease.signers, 3);
  assert.equal(state.treasury.lease.aligned, true);
  assert.equal(state.treasury.lease.deadlineMs, (BASE_IDX + 5 * MOMENT) * 1000);
  assert.equal(state.lastWill, null);

  // everpocket's record now says one moment of hosting: ten minutes left on the moment clock.
  // The last will fires on the next observation and Alice's unspent 1 XAH goes back to the
  // account her channel came from — she never named a payout address.
  writeClusterJson(cluster, 1);
  await cluster.runRound();
  state = stateStore.load(cluster.nodes[0].stateDir);
  assert.equal(state.treasury.lease.deadlineMs, (BASE_IDX + MOMENT) * 1000);
  assert.ok(state.lastWill, 'winding down');
  assert.ok(aOut.some((m) => m.t === 'last_will' && m.active && m.payoutTo === aliceX.address && m.payoutSource === 'channel'), JSON.stringify(aOut.filter((m) => m.t === 'last_will')));
  mock.close();
  await cluster.runRound();
  await cluster.runRound();
  assert.equal(mock.balance(aliceX.address), 20_000_000n - 5_000_000n + 1_000_000n, 'alice refunded by the last will');
  assert.ok(aOut.some((m) => m.t === 'payout' && m.status === 'validated' && m.lastWill === true));
  assert.equal(cluster.forked, false);

  // A round that died between submitting and recording. Rewrite every node's state as the
  // pre-submit save would have left it — four payouts in limbo:
  //   pX  Bob, 0.3 XAH, "planned", no hash; its Payment did reach the ledger (memo pX)
  //   pY  Alice, 0.05 XAH, "planned", no hash, planned long ago; nothing on the ledger
  //   pZ  Bob, 0.2 XAH, "submitted" with a hash everpocket never recorded; validated on the ledger
  //   pW  Alice, 0.04 XAH, "submitted" with a hash that exists nowhere, planned long ago
  // plus two decoys carrying pX's memo: a stranger's Payment *to* the account, and the account's
  // own Payment of the wrong amount. Bob is paid exactly once for each of his; Alice is refunded
  // both of hers — pY without blame (nothing was sent), pW with the usual backoff.
  state = stateStore.load(cluster.nodes[0].stateDir);
  mock.ledgerIndex = 500; // far enough along for "planned long ago" to mean something
  const ledgerNow = mock.ledgerIndex;
  const bobAddr = 'rBobPayoutAddress1111111111111111';
  const payment = (memoId, amount, extra = {}) => ({ TransactionType: 'Payment', Account: MASTER, Destination: bobAddr, Amount: amount, Fee: '12', Memos: intentMemo(memoId), SigningPubKey: '', NetworkID: 21338, ...extra });
  mock.fund('rStranger11111111111111111111111111', 1_000_000n);
  mock.submitMultisigned(payment('pX', '1', { Account: 'rStranger11111111111111111111111111', Destination: MASTER }), 'decoy-stranger');
  mock.submitMultisigned(payment('pX', '299999'), 'decoy-amount');
  const crashedX = mock.submitMultisigned(payment('pX', '300000'), 'crashed-round-pX');
  const crashedZ = mock.submitMultisigned(payment('pZ', '200000'), 'crashed-round-pZ');
  forgotten.add(crashedZ.hash);
  mock.close();
  state.peers[bob.publicKey].pendingPayout = 'pX';
  state.payouts.pX = { peer: bob.publicKey, amount: '300000', destination: bobAddr, tag: null, status: 'planned', txHash: null, lcl: cluster.lclSeqNo, plannedLedger: ledgerNow, lastWill: true };
  state.payouts.pZ = { peer: bob.publicKey, amount: '200000', destination: bobAddr, tag: null, status: 'submitted', txHash: crashedZ.hash, lcl: cluster.lclSeqNo, plannedLedger: ledgerNow, lastWill: true };
  state.peers[alice.publicKey].pendingPayout = 'pY';
  state.payouts.pY = { peer: alice.publicKey, amount: '50000', destination: aliceX.address, tag: null, status: 'planned', txHash: null, lcl: cluster.lclSeqNo, plannedLedger: ledgerNow - LEDGERS_UNTIL_LOST - 1, lastWill: true };
  state.payouts.pW = { peer: alice.publicKey, amount: '40000', destination: aliceX.address, tag: null, status: 'submitted', txHash: 'F'.repeat(64), lcl: cluster.lclSeqNo, plannedLedger: ledgerNow - LEDGERS_UNTIL_LOST - 1, lastWill: true };
  for (const n of cluster.nodes) stateStore.save(n.stateDir, state);
  const aliceBefore = mock.balance(aliceX.address);
  await cluster.runRound(); // reconciled + settled; pY and pW refunded, pW with a backoff
  mock.close();
  await cluster.runRound();
  state = stateStore.load(cluster.nodes[0].stateDir);
  assert.deepEqual(state.payouts, {}, `all resolved: ${JSON.stringify(state.payouts)}`);
  assert.equal(state.peers[bob.publicKey].pendingPayout, null);
  const bobPayouts = bOut.filter((m) => m.t === 'payout');
  assert.ok(bobPayouts.some((m) => m.status === 'submitted' && m.tx === crashedX.hash && m.lastWill), JSON.stringify(bobPayouts));
  assert.ok(bobPayouts.some((m) => m.status === 'validated' && m.tx === crashedX.hash));
  assert.ok(bobPayouts.some((m) => m.status === 'validated' && m.tx === crashedZ.hash), 'the ledger, not everpocket, settled pZ');
  // (the wrong-amount decoy was a real Payment on the mock ledger; it settled nothing)
  assert.equal(mock.balance(bobAddr), 1_485_000n + 299_999n + 300_000n + 200_000n, 'pX and pZ paid exactly once each');
  const alicePayouts = aOut.filter((m) => m.t === 'payout');
  assert.ok(alicePayouts.some((m) => m.status === 'failed' && m.reason === 'submission lost' && m.amt === '50000' && m.retryAfterRounds === 0), JSON.stringify(alicePayouts));
  assert.ok(alicePayouts.some((m) => m.status === 'failed' && m.reason === 'expired' && m.amt === '40000' && m.retryAfterRounds === 20), JSON.stringify(alicePayouts));
  assert.equal(mock.balance(aliceX.address), aliceBefore, 'nothing more went to alice yet');
  assert.equal(state.peers[alice.publicKey].balance, '90000', 'both refunded; the expired one put her address on a 20-round backoff, so the wind-down retries later');
  assert.equal(cluster.forked, false);
});

test('leaseDeadline: when the signer quorum loses its hosting — never later than the host acts, unknown rather than guessed', () => {
  const base = 1_700_000_000;
  const G = LEASE_TIMESTAMP_SLACK_SEC;
  const node = (signerAddress, lifeMoments, createdOnTimestamp) => ({ pubkey: `ed${signerAddress}`, signerAddress, createdOnTimestamp, lifeMoments });
  const list = (quorum, weights) => ({ SignerQuorum: quorum, SignerEntries: Object.entries(weights).map(([Account, SignerWeight]) => ({ SignerEntry: { Account, SignerWeight } })) });
  const at = (moments) => (base + moments * 3600) * 1000;
  const lease = (args) => leaseDeadline({ momentSec: 3600, nowMs: 0, ...args });

  // Stamped mid-moment (well after the slack): the lease is counted from this moment, and the
  // second-longest-lived signer (2 of 3) sets the deadline.
  const mid = (base + 2000) * 1000;
  const nodes = [node('rA', 2, mid), node('rB', 5, mid), node('rC', 9, mid), { pubkey: 'edD', createdOnTimestamp: mid, lifeMoments: 1 }];
  const f = lease({ nodes, signerList: list(2, { rA: 1, rB: 1, rC: 1 }), baseIdx: base });
  assert.equal(f.reason, null);
  assert.equal(f.lease.deadlineMs, at(5));
  assert.deepEqual([f.lease.quorum, f.lease.signers, f.lease.aligned, f.lease.momentMs], [2, 3, true, 3600000]);
  assert.deepEqual(f.lease.expiries, [at(9), at(5), at(2)]);
  // everpocket's own estimate (stamp + life) is later; the host acts at the boundary.
  assert.ok(f.lease.deadlineMs < mid + 5 * 3600 * 1000);
  // Stamped just after a boundary: the purchase may have been in the moment before, so it is
  // counted from there — one moment earlier than a naive alignment, never later than the host.
  const early = (base + 3600 + 60) * 1000;
  assert.equal(lease({ nodes: [node('rA', 2, early)], signerList: list(1, { rA: 1 }), baseIdx: base }).lease.deadlineMs, at(2));
  assert.equal(lease({ nodes: [node('rA', 2, (base + 3600 + G) * 1000)], signerList: list(1, { rA: 1 }), baseIdx: base }).lease.deadlineMs, at(3), 'past the slack: this moment');
  // Without the moment clock: everpocket's estimate, less one moment and the slack.
  const g = lease({ nodes, signerList: list(2, { rA: 1, rB: 1, rC: 1 }) });
  assert.equal(g.lease.deadlineMs, mid - G * 1000 + 4 * 3600 * 1000);
  assert.equal(g.lease.aligned, false);
  // Weights count: a weight-2 signer reaches a quorum of 2 alone.
  assert.equal(lease({ nodes, signerList: list(2, { rA: 1, rB: 1, rC: 2 }), baseIdx: base }).lease.deadlineMs, at(9));
  // No SignerList known: every signer node is needed, so the earliest expiry counts.
  const h = lease({ nodes, signerList: null, baseIdx: base });
  assert.deepEqual([h.lease.deadlineMs, h.lease.quorum], [at(2), 3]);
  // A signer node without lease data is left out (pessimistic: the deadline can only move
  // earlier) and noted; the answer is withheld only when the counted nodes cannot reach the
  // quorum at all — signers the record does not know, or none at all.
  const partial = lease({ nodes: [node('rA', 2, mid), node('rB', 5, mid), { pubkey: 'edC', signerAddress: 'rC' }], signerList: list(2, { rA: 1, rB: 1, rC: 1 }), baseIdx: base });
  assert.equal(partial.lease.deadlineMs, at(2), 'B and A count, C does not');
  assert.equal(partial.lease.signers, 2);
  assert.match(partial.reason, /edC has no lease data/);
  const short = lease({ nodes: [node('rA', 2, mid), { pubkey: 'edB', signerAddress: 'rB' }], signerList: list(2, { rA: 1, rB: 1 }), baseIdx: base });
  assert.equal(short.lease, null);
  assert.match(short.reason, /no lease data.*cannot reach the quorum/);
  assert.match(lease({ nodes, signerList: list(4, { rA: 1, rB: 1, rC: 1, rX: 1 }), baseIdx: base }).reason, /cannot reach the quorum/);
  assert.match(lease({ nodes: [{ pubkey: 'edD', lifeMoments: 3 }], signerList: null }).reason, /no signer nodes/);
  assert.equal(lease({ nodes: [], signerList: null }).lease, null);
  // A node that left the SignerList is not counted, and does not make the record incomplete.
  assert.equal(lease({ nodes: [...nodes, { pubkey: 'edZ', signerAddress: 'rZ' }], signerList: list(2, { rA: 1, rB: 1, rC: 1 }), baseIdx: base }).lease.deadlineMs, at(5));
});
