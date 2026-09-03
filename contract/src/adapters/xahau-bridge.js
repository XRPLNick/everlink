'use strict';

// Production bridge: the cluster's agreed view of Xahau and its multisigned actions,
// built on everpocket-nodejs-contract (VoteContext / XrplContext / EvernodeContext /
// ClusterContext / NomadContext) exactly as Evernode's own examples wire them.
//
// Per round (only when there is ledger work to do, see `factsEvery`):
//   observe()  each node queries Xahau itself, the cluster votes on what it saw over NPL,
//              and the majority view becomes this round's facts for the deterministic core.
//   submit()   every intent is multisigned by the signer nodes and submitted; everpocket
//              already runs its own NPL elections so all nodes learn the same result.
//   afterRound() the Nomad context keeps the cluster alive: prune dead nodes, grow back to
//              the target size, extend expiring leases — paid from the same multisig account.
//
// Nothing here is deterministic on its own; that is why every observation goes through a
// vote before it is allowed to touch state, and why the core never calls this module.

const { majority } = require('./npl-vote');

const TIMEOUT_MS = 6000;
const NETWORK_IDS = { mainnet: 21337, testnet: 21338 };
// evernode-js-client fetches these from GitHub (https.get without a timeout) every time a
// context is initialised; a host without outbound HTTPS would hang the round. Same content as
// EvernodeXRPL/evernode-resources definitions/definitions.json.
const NETWORK_DEFINITIONS = {
  mainnet: { governorAddress: 'rBvKgF3jSZWdJcwSsmoJspoXLLDVLDp6jg', rippledServer: 'wss://xahau.network', stateIndexId: 'evernodeprod', networkID: 21337 },
  testnet: { governorAddress: 'rUZXZuqhjRP2ouHTmBncp2pmntt2WmNo9c', rippledServer: 'wss://hooks-testnet-v3.xrpl-labs.com', stateIndexId: 'evernodeindex', networkID: 21338 },
  devnet: { governorAddress: 'rwBigRmbdi4CwtdS9yV9f7YqaZbzVbnvrt', rippledServer: 'wss://hooks-testnet-v3.xrpl-labs.com', stateIndexId: 'evernodev3devindex', networkID: 21338 },
};
function useOfflineDefinitions() {
  try {
    const { Defaults } = require('evernode-js-client');
    if (Defaults.__nomadOffline) return;
    const original = Defaults.useNetwork.bind(Defaults);
    Defaults.useNetwork = async (network) => { if (NETWORK_DEFINITIONS[network]) Defaults.set(NETWORK_DEFINITIONS[network]); else await original(network); };
    Defaults.__nomadOffline = true;
  } catch (e) { /* tests inject a fake everpocket without evernode-js-client */ }
}
// everpocket ClusterMessageType values (models/cluster): messages from cluster nodes, not peers.
const CLUSTER_MESSAGE_TYPES = new Set(['maturity_ack', 'cluster_nodes']);

class XahauBridge {
  constructor({ masterAddress, network = 'mainnet', rippleServer = null, evrIssuer, factsEvery = 5, nomadEvery = 10, nomad = null, logger = () => {}, evp = null }) {
    if (!masterAddress) throw new Error('masterAddress required');
    // `evp` can be injected (tests); by default the real everpocket library is used.
    this.evp = evp || require('everpocket-nodejs-contract');
    if (!evp) useOfflineDefinitions();
    this.nomadEvery = nomadEvery;
    this.master = masterAddress;
    this.network = network;
    this.rippleServer = rippleServer;
    this.evrIssuer = evrIssuer;
    this.factsEvery = factsEvery;
    this.nomadOptions = nomad;
    this.log = logger;
    this._rounds = new WeakMap(); // ctx -> per-execution everpocket contexts
  }

  // everpocket contexts live for one contract execution; build them lazily per round.
  _contexts(ctx) {
    if (this._rounds.has(ctx)) return this._rounds.get(ctx);
    const evp = this.evp;
    const voteContext = new evp.VoteContext(ctx);
    const hpContext = new evp.HotPocketContext(ctx, { voteContext });
    if (!ctx.readonly) ctx.unl.onMessage((node, msg) => voteContext.feedUnlMessage(node, msg));
    const xrplOptions = { network: this.network };
    if (this.rippleServer) xrplOptions.rippleServer = this.rippleServer;
    const xrplContext = new evp.XrplContext(hpContext, this.master, null, xrplOptions);
    let evernodeContext = null; let clusterContext = null; let nomadContext = null;
    if (this.nomadOptions) {
      evernodeContext = new evp.EvernodeContext(xrplContext);
      clusterContext = new evp.ClusterContext(evernodeContext);
      nomadContext = new evp.NomadContext(clusterContext, this.nomadOptions);
    }
    const round = { ctx, voteContext, hpContext, xrplContext, evernodeContext, clusterContext, nomadContext, xrplReady: false };
    this._rounds.set(ctx, round);
    return round;
  }

  async _xrpl(ctx) {
    const r = this._contexts(ctx);
    if (!r.xrplReady) { await r.xrplContext.init(); r.xrplReady = true; }
    return r.xrplContext;
  }

  _hasLedgerWork(state) {
    return Object.keys(state.payouts).length > 0
      || Object.values(state.channels).some((c) => c.redeemPending)
      || !!state.treasury.offerPending;
  }

  // Cluster-membership messages (new nodes announcing maturity) share the user channel
  // with peers; hand them to everpocket and keep them away from the connector core.
  async consumeInput(ctx, user, raw) {
    const r = this._contexts(ctx);
    if (!r.clusterContext) return false;
    let obj;
    try { obj = JSON.parse(raw.toString()); } catch (e) { return false; }
    if (!obj || !CLUSTER_MESSAGE_TYPES.has(obj.type)) return false;
    await r.clusterContext.init();
    await r.clusterContext.feedUserMessage(user, raw);
    return true;
  }

  async observe(ctx, state) {
    if (ctx.lclSeqNo % this.factsEvery !== 0 && !this._hasLedgerWork(state)) return null;
    const r = this._contexts(ctx);
    const xrpl = await this._xrpl(ctx);
    const acc = xrpl.xrplAcc;

    // --- local observation (differs per node in timing, hence the vote below) ---
    const info = await acc.getInfo();
    const objects = await acc.getAccountObjects({ type: 'payment_channel' });
    const channels = objects
      .filter((o) => o.LedgerEntryType === 'PayChannel' && o.Destination === this.master)
      .map((o) => ({
        id: o.index, account: o.Account, publicKey: o.PublicKey, amount: o.Amount, balance: o.Balance || '0',
        settleDelay: o.SettleDelay, expiration: o.Expiration ? rippleToMs(o.Expiration) : null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    let evrBalance = '0';
    if (this.evrIssuer) {
      const lines = await acc.getTrustLines('EVR', this.evrIssuer);
      if (lines.length) evrBalance = String(lines[0].balance);
    }
    const known = knownHashes(state);
    const validated = xrpl.getValidatedTransactions().filter((t) => known.has(t.hash));
    const pending = new Set(xrpl.getPendingTransactions().map((t) => t.hash));
    const validatedTxs = validated.filter((t) => t.resultCode === 'tesSUCCESS').map((t) => ({ hash: t.hash, resultCode: t.resultCode }));
    const failedTxs = validated.filter((t) => t.resultCode !== 'tesSUCCESS').map((t) => ({ hash: t.hash, resultCode: t.resultCode }));
    for (const h of known) {
      // Known to us, no longer pending, never validated: it expired (LastLedgerSequence passed).
      if (!pending.has(h) && !validated.find((t) => t.hash === h)) failedTxs.push({ hash: h, resultCode: 'expired' });
    }
    const local = {
      ledgerIndex: xrpl.xrplApi.ledgerIndex, masterBalance: String(info.Balance), evrBalance,
      channels, channelsComplete: true, validatedTxs, failedTxs,
    };

    // --- agree ---
    const unlCount = r.hpContext.getContractUnl().length;
    const votes = await r.voteContext.vote(`nomad-facts-${ctx.lclSeqNo}`, [local], new this.evp.AllVoteElector(unlCount, TIMEOUT_MS));
    const agreed = majority(votes.map((v) => ({ sender: v.sender.publicKey, data: v.data })));
    if (!agreed) throw new Error('no facts agreed this round');
    return agreed;
  }

  // Xahau transactions carry the network id; multisigned ones have an empty SigningPubKey.
  // everpocket's own prepare* helpers add both, the core's intents do not.
  _txEnvelope(tx) {
    let networkID = NETWORK_IDS[this.network];
    try { networkID = require('evernode-js-client').Defaults.values.networkID || networkID; } catch (e) { /* tests inject a fake everpocket */ }
    const out = { ...tx, SigningPubKey: '' };
    if (networkID && out.NetworkID === undefined) out.NetworkID = networkID;
    return out;
  }

  async submit(ctx, intents) {
    const xrpl = await this._xrpl(ctx);
    const results = [];
    for (const intent of intents) {
      try {
        // everpocket: decides Sequence/LastLedgerSequence by vote, collects signer
        // signatures over NPL, one node submits, the result is voted back to everyone.
        const res = await xrpl.multiSignAndSubmitTransaction(this._txEnvelope(intent.tx));
        const ok = res && (res.resultCode === 'tesSUCCESS' || res.resultCode === 'tefALREADY' || res.resultCode === 'tefPAST_SEQ');
        results.push({ id: intent.id, ok: !!ok, hash: res && res.hash, resultCode: res && res.resultCode });
      } catch (e) {
        results.push({ id: intent.id, ok: false, error: String(e && e.message ? e.message : e) });
      }
    }
    return results;
  }

  async afterRound(ctx) {
    const r = this._contexts(ctx);
    try {
      if (r.nomadContext && !ctx.readonly && ctx.lclSeqNo % this.nomadEvery === 0) {
        // prune / grow / extend — the cluster pays its own hosts from the multisig account.
        // Housekeeping, not per-packet work: every `nomadEvery` rounds is plenty.
        await r.nomadContext.init();
      }
    } finally {
      if (r.xrplReady) await r.xrplContext.deinit().catch(() => {});
      if (r.evernodeContext) await r.evernodeContext.deinit().catch(() => {});
      if (r.clusterContext) await r.clusterContext.deinit().catch(() => {});
      if (r.nomadContext) await r.nomadContext.deinit().catch(() => {});
      this._rounds.delete(ctx);
    }
  }
}

function knownHashes(state) {
  const s = new Set();
  for (const p of Object.values(state.payouts)) if (p.txHash) s.add(p.txHash);
  for (const c of Object.values(state.channels)) {
    if (c.redeemPending && c.redeemPending.hash) s.add(c.redeemPending.hash);
    if (c.closePending && c.closePending.hash) s.add(c.closePending.hash);
  }
  if (state.treasury.offerPending && state.treasury.offerPending.hash) s.add(state.treasury.offerPending.hash);
  return s;
}

const RIPPLE_EPOCH_MS = 946684800000;
function rippleToMs(rippleSeconds) { return RIPPLE_EPOCH_MS + rippleSeconds * 1000; }

module.exports = { XahauBridge };
