'use strict';

// The production bridge cannot reach Xahau from a unit test, so everpocket is replaced by a
// fake with the same surface (VoteContext over the simulator's NPL, XrplContext backed by
// the mock ledger). This proves the bridge's observe/submit/afterRound wiring and that the
// core stays consensus-safe when driven through it on a 3-node simulated cluster.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SimCluster, SimClient, edKeys } = require('../sim/hotpocket-sim');
const { MockXahau } = require('../sim/mock-xahau');
const { XahauBridge } = require('../contract/src/adapters/xahau-bridge');
const { runRound } = require('../contract/src/round');
const { makeConfig } = require('../contract/src/core/connector');
const H = require('./helpers');

const MASTER = 'rEverlinkMasterAccountFake1111111111';

function fakeEverpocket(mock, calls) {
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
      this.xrplApi = { get ledgerIndex() { return mock.ledgerIndex; } };
      this.xrplAcc = {
        getInfo: async () => ({ Balance: mock.balance(address).toString() }),
        getAccountObjects: async ({ type }) => (type !== 'payment_channel' ? [] : mock.accountChannels(address).map((c) => ({
          LedgerEntryType: 'PayChannel', index: c.id, Account: c.account, Destination: c.destination, PublicKey: c.publicKey,
          Amount: c.amount, Balance: c.balance, SettleDelay: c.settleDelay, Expiration: c.expiration ? Math.floor((c.expiration - 946684800000) / 1000) : undefined,
        }))),
        getTrustLines: async () => [{ currency: 'EVR', balance: String(mock.evr(address)) }],
      };
      this.submitted = [];
    }
    async init() { calls.push('xrpl.init'); }
    async deinit() { calls.push('xrpl.deinit'); }
    getValidatedTransactions() { return mock.validated.map((v) => ({ hash: v.hash, resultCode: v.resultCode })); }
    getPendingTransactions() { return mock.pendingValidation.map((v) => ({ hash: v.hash })); }
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
  class EvernodeContext { constructor(x) { this.xrplContext = x; } async deinit() { calls.push('evernode.deinit'); } }
  class ClusterContext { constructor(e) { this.evernodeContext = e; } async init() {} async deinit() { calls.push('cluster.deinit'); } async feedUserMessage(user, raw) { calls.push(`cluster.msg:${JSON.parse(raw.toString()).type}`); await user.send(JSON.stringify({ type: 'maturity_ack', status: 'ok' })); } }
  class NomadContext { constructor(c, o) { this.clusterContext = c; this.options = o; } async init() { calls.push('nomad.init'); } async deinit() { calls.push('nomad.deinit'); } }
  return { VoteContext, AllVoteElector, HotPocketContext, XrplContext, EvernodeContext, ClusterContext, NomadContext };
}

test('XahauBridge drives the core through fake everpocket on a 3-node cluster', async (t) => {
  const mock = new MockXahau();
  mock.fund(MASTER, 60_000_000n); mock.fundEvr(MASTER, 25);
  const calls = [];
  const config = makeConfig({ masterAddress: MASTER, feeBps: 100, minExpiryWindowMs: 300, redeemThresholdDrops: '1000000', payoutThresholdDrops: '1000000' });
  const bridge = new XahauBridge({
    masterAddress: MASTER, network: 'testnet', evrIssuer: config.evrIssuer, factsEvery: 1, nomadEvery: 1,
    nomad: { targetNodeCount: 3, lifeIncrMomentMinLimit: 2 }, evp: fakeEverpocket(mock, calls),
  });
  const cluster = new SimCluster({ nodeCount: 3, roundTimeMs: 25, handler: (ctx) => runRound(ctx, { stateDir: ctx.sim.stateDir, config, bridge }) });
  t.after(() => cluster.stop());
  cluster.on('error', (e) => { throw e; });

  const alice = new SimClient(cluster, edKeys()); const bob = new SimClient(cluster, edKeys());
  await alice.connect(); await bob.connect();
  const aOut = []; const bOut = [];
  alice.on('contract_output', ({ outputs }) => outputs.forEach((o) => aOut.push(JSON.parse(o))));
  bob.on('contract_output', ({ outputs }) => bOut.push(JSON.parse(outputs[0])));

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
});
