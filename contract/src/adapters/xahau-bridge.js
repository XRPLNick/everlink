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
// The observation also carries the "lease" fact: until when the cluster's own hosting is paid
// for, computed from everpocket's cluster.json (consensus state), the account's SignerList and
// Evernode's moment clock. The core's last will (see connector.js) is driven by it.
//
// Nothing here is deterministic on its own; that is why every observation goes through a
// vote before it is allowed to touch state, and why the core never calls this module.

const fs = require('fs');
const path = require('path');
const { majority } = require('./npl-vote');
const { intentIdFromMemos } = require('../core/connector');

const TIMEOUT_MS = 6000;
const DEFAULT_MOMENT_SEC = 3600;          // Evernode mainnet moment; the live value is cached from the registry
const EVERNODE_CACHE_FILE = 'everlink-evernode.json';
// everpocket stamps a node's createdOnTimestamp minutes after the lease was actually bought (when
// the instance first answered); evdevkit stamps the operator's clock after the acquire response.
// The lease fact assumes the purchase was no longer ago than this before the stamp.
const LEASE_TIMESTAMP_SLACK_SEC = 900;
// A payout planned by a round that never recorded its submission is looked for on the ledger; it
// is given up as never submitted once this many ledgers have closed since the ledger the planning
// round had last observed (everpocket sets LastLedgerSequence 30-40 ledgers past submission, and
// that observation may have been a few rounds old). Same window for a submitted transaction that
// everpocket did not record and the ledger does not have. Generous on purpose: a late refund
// costs nothing, an early one pays twice.
const LEDGERS_UNTIL_LOST = 200;
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
    if (Defaults.__everlinkOffline) return;
    const original = Defaults.useNetwork.bind(Defaults);
    Defaults.useNetwork = async (network) => { if (NETWORK_DEFINITIONS[network]) Defaults.set(NETWORK_DEFINITIONS[network]); else await original(network); };
    Defaults.__everlinkOffline = true;
  } catch (e) { /* tests inject a fake everpocket without evernode-js-client */ }
}
// everpocket ClusterMessageType values (models/cluster): messages from cluster nodes, not peers.
const CLUSTER_MESSAGE_TYPES = new Set(['maturity_ack', 'cluster_nodes']);

class XahauBridge {
  constructor({ masterAddress, network = 'mainnet', rippleServer = null, evrIssuer, factsEvery = 5, nomadEvery = 10, nomad = null, logger = () => {}, evp = null, cacheDir = null, momentSec = DEFAULT_MOMENT_SEC }) {
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
    // Per-node, outside consensus state: where the Evernode moment clock read during the Nomad
    // phase is kept for the lease fact. Falls back to `momentSec` and no moment alignment.
    this.cacheDir = cacheDir;
    this.momentSec = momentSec;
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

  // Read-request helper ({"t":"diag","ledger":true}): can this node reach the ledger through
  // everpocket's XrplContext, and how long does it take? Never used in consensus rounds.
  async probeLedger() {
    // Plain evernode-js-client XrplApi (no everpocket XrplContext: that one writes
    // transactions.json into the state directory, which read requests cannot do).
    const t0 = Date.now(); const out = {};
    let api = null;
    try {
      const evernode = require('evernode-js-client');
      await evernode.Defaults.useNetwork(this.network);
      api = new evernode.XrplApi(this.rippleServer || undefined, { autoReconnect: false });
      await api.connect(); out.connectMs = Date.now() - t0;
      const acc = new evernode.XrplAccount(this.master, null, { xrplApi: api });
      const info = await acc.getInfo(); out.balance = info && info.Balance; out.infoMs = Date.now() - t0;
      out.ledgerIndex = api.ledgerIndex;
      const signers = await acc.getAccountObjects({ type: 'signer_list' }); out.signerList = signers.length ? `${signers[0].SignerEntries.length} signers, quorum ${signers[0].SignerQuorum}` : 'none';
      out.totalMs = Date.now() - t0;
    } catch (e) { out.error = String(e && e.message ? e.message : e); out.failedAfterMs = Date.now() - t0; }
    try { if (api) await api.disconnect(); } catch (e) { /* ignore */ }
    return out;
  }

  async observe(ctx, state, { stateDir = null } = {}) {
    if (ctx.lclSeqNo % this.factsEvery !== 0 && !this._hasLedgerWork(state)) return null;
    const r = this._contexts(ctx);
    const mark = (t) => this.log(`observe lcl ${ctx.lclSeqNo}: ${t}`);
    mark('xrpl init');
    const xrpl = await this._xrpl(ctx);
    const acc = xrpl.xrplAcc;
    mark('xrpl ready');

    // The cluster's own hosting (null when there is no cluster.json, e.g. a local run).
    let lease = null; let clock = null; let leaseNote = null;
    try {
      const l = await this._leaseFact(ctx, xrpl, state, stateDir);
      lease = l.lease; clock = l.clock; leaseNote = l.reason || null;
      if (leaseNote) mark(`lease fact: ${leaseNote}`);
    } catch (e) { leaseNote = 'unavailable'; mark(`lease fact unavailable: ${String(e && e.message ? e.message : e).slice(0, 160)}`); } // a constant note keeps the votes aligned

    // Payouts a previous round planned but never recorded as submitted (it died in between):
    // look for them on the ledger by their memo before the core decides anything about them.
    let reconciled = [];
    try { reconciled = await this._reconcile(ctx, xrpl, state); } catch (e) { mark(`reconciliation unavailable: ${String(e && e.message ? e.message : e).slice(0, 160)}`); }

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
    const ledgerNow = xrpl.xrplApi.ledgerIndex;
    for (const [h, rec] of known) {
      if (pending.has(h) || validated.find((t) => t.hash === h)) continue;
      // Known to us but not to everpocket's records: the round that submitted it died before
      // they were written. The ledger knows; ask it before calling anything failed.
      const info = await txOnLedger(xrpl, h);
      if (info) { (info.resultCode === 'tesSUCCESS' ? validatedTxs : failedTxs).push({ hash: h, resultCode: info.resultCode }); continue; }
      // Not there: expired (LastLedgerSequence passed) — once enough ledgers have gone by that
      // it cannot still be on its way.
      const since = rec.ledger > 0 ? ledgerNow - rec.ledger : (ctx.lclSeqNo - rec.lcl);
      if (since > LEDGERS_UNTIL_LOST) failedTxs.push({ hash: h, resultCode: 'expired' });
    }
    validatedTxs.sort((a, b) => (a.hash < b.hash ? -1 : 1));
    failedTxs.sort((a, b) => (a.hash < b.hash ? -1 : 1));
    const local = {
      ledgerIndex: xrpl.xrplApi.ledgerIndex, masterBalance: String(info.Balance), evrBalance,
      channels, channelsComplete: true, validatedTxs, failedTxs, lease, leaseNote, clock, reconciled,
    };

    // --- agree ---
    mark(`queried: ledger ${local.ledgerIndex}, balance ${local.masterBalance}, ${channels.length} channels, hosting ${lease ? `${Math.round((lease.deadlineMs - ctx.timestamp) / 60000)} min for ${lease.quorum} of ${lease.signers}` : 'unknown'}; voting`);
    const unlCount = r.hpContext.getContractUnl().length;
    const votes = await r.voteContext.vote(`everlink-facts-${ctx.lclSeqNo}`, [local], new this.evp.AllVoteElector(unlCount, TIMEOUT_MS));
    mark(`votes: ${votes.length}/${unlCount}`);
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
        // everpocket reports its decisions ("Extending the node …", "Pruning …") on the
        // console only; capture them for the diagnostics, together with the cluster's leases.
        const t0 = Date.now();
        const cap = captureConsole();
        try {
          await r.nomadContext.init();
          this._cacheEvernodeClock(r);
          this.log(`nomad lcl ${ctx.lclSeqNo}: ${this._leaseSummary(r)} (${Date.now() - t0} ms)`);
        } catch (e) {
          this.log(`nomad lcl ${ctx.lclSeqNo} failed after ${Date.now() - t0} ms: ${String(e && e.message ? e.message : e).slice(0, 300)}`);
          throw e;
        } finally {
          cap.restore();
          for (const line of cap.lines) this.log(`nomad says: ${line}`);
        }
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

// ---- The lease fact -------------------------------------------------------------------------
//
// cluster.json is everpocket's record of the cluster (in the consensus state directory, so the
// same on every node): per node the moment its lease started and how many moments were bought.
// The SignerList says whose signatures move money. The fact is the consensus time at which the
// signer quorum can no longer be formed from nodes whose hosting is paid — after that the account
// is frozen for good — and it is what the core's last will counts down to.
//
// Evernode's moment clock (moment length and the unix second moments are counted from) makes the
// fact exact; it is read from the registry during the Nomad phase, cached per node, and — once any
// vote carried it into the core's state — taken from there, so every node computes the same fact.
XahauBridge.prototype._leaseFact = async function leaseFact(ctx, xrpl, state, stateDir) {
  const file = path.join(stateDir || process.cwd(), 'cluster.json');
  if (!fs.existsSync(file)) return { lease: null, clock: null, reason: null };
  const cluster = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The list everpocket itself signs with, loaded at XrplContext.init(); the ledger otherwise.
  let signerList = null;
  if (xrpl.signerListInfo && Array.isArray(xrpl.signerListInfo.signerList)) {
    signerList = { SignerQuorum: xrpl.signerListInfo.signerQuorum, SignerEntries: xrpl.signerListInfo.signerList.map((s) => ({ SignerEntry: { Account: s.account, SignerWeight: s.weight } })) };
  } else {
    const lists = (await xrpl.xrplAcc.getAccountObjects({ type: 'signer_list' })) || [];
    signerList = lists.find((o) => !o.LedgerEntryType || o.LedgerEntryType === 'SignerList') || null;
  }
  // The clock this node read from the registry, else the one a vote already carried into the
  // agreed state, else the configured moment length without a base.
  const cached = this._evernodeClock();
  const agreed = state && state.treasury && state.treasury.clock;
  const clock = cached.baseIdx !== null ? cached : (agreed && agreed.momentSec > 0 ? { momentSec: agreed.momentSec, baseIdx: agreed.baseIdx } : cached);
  const r = leaseDeadline({ nodes: cluster.nodes || [], signerList, momentSec: clock.momentSec, baseIdx: clock.baseIdx, nowMs: ctx.timestamp });
  return { lease: r.lease, clock: clock.baseIdx !== null && clock.baseIdx !== undefined ? clock : null, reason: r.reason };
};

// Evernode's moment clock as the registry publishes it, read during the Nomad phase (the only
// time the registry client is connected) and kept per node outside consensus state.
XahauBridge.prototype._cacheEvernodeClock = function cacheEvernodeClock(r) {
  if (!this.cacheDir || !r.evernodeContext) return;
  try {
    const c = r.evernodeContext.getEvernodeConfig();
    if (!c || !c.momentSize) return;
    const baseIdx = c.momentBaseInfo && Number.isFinite(Number(c.momentBaseInfo.baseIdx)) ? Number(c.momentBaseInfo.baseIdx) : null;
    fs.writeFileSync(path.join(this.cacheDir, EVERNODE_CACHE_FILE), JSON.stringify({ momentSec: Number(c.momentSize), baseIdx, at: new Date().toISOString() }));
  } catch (e) { this.log(`evernode clock not cached: ${String(e && e.message ? e.message : e).slice(0, 120)}`); }
};
XahauBridge.prototype._evernodeClock = function evernodeClock() {
  if (this.cacheDir) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(this.cacheDir, EVERNODE_CACHE_FILE), 'utf8'));
      if (c && c.momentSec > 0) return { momentSec: c.momentSec, baseIdx: Number.isFinite(c.baseIdx) ? c.baseIdx : null };
    } catch (e) { /* not cached yet */ }
  }
  return { momentSec: this.momentSec, baseIdx: null };
};

// When a node's hosting ends. Evernode counts a lease in whole moments from the one the instance
// was bought in, and the host lets it go when the current moment reaches createdMoment +
// lifeMoments — up to a whole moment before everpocket's own estimate (createdOnTimestamp +
// lifeMoments × moment), which is what its Nomad loop extends against. The stamp itself is late
// by an unknown few minutes, so the purchase is placed LEASE_TIMESTAMP_SLACK_SEC earlier than the
// stamp says: with the moment clock known, the exact boundary that follows from that; without it,
// everpocket's estimate less one moment and the slack. Neither says "later" than the host will,
// as long as the stamp is not more than the slack behind the purchase.
function nodeExpiryMs(node, momentSec, baseIdx, slackSec = LEASE_TIMESTAMP_SLACK_SEC) {
  const boughtSec = Math.floor(node.createdOnTimestamp / 1000) - slackSec;
  if (baseIdx !== null && baseIdx !== undefined) {
    const createdMoment = Math.floor((boughtSec - baseIdx) / momentSec);
    return (baseIdx + (createdMoment + node.lifeMoments) * momentSec) * 1000;
  }
  return (boughtSec + (node.lifeMoments - 1) * momentSec) * 1000;
}

// Pure: the deadline of the signer quorum, or null with a reason when it cannot be told. Signer
// nodes are the cluster nodes that carry a signer address; their weight comes from the SignerList
// (weight 1 each, all of them needed, when no list is known). Sorted by expiry, latest first, the
// deadline is the expiry of the node at which the accumulated weight reaches the quorum. A signer
// node whose lease data is missing is not counted — pessimistic: fewer nodes counted can only
// bring the deadline forward — and noted; only a quorum the counted nodes cannot reach at all
// leaves the answer "unknown", never a guess: the core then keeps the last known value.
function leaseDeadline({ nodes, signerList, momentSec, baseIdx = null, nowMs }) {
  const weights = new Map();
  let quorum = 0;
  if (signerList && Array.isArray(signerList.SignerEntries)) {
    for (const e of signerList.SignerEntries) { const s = e.SignerEntry || e; weights.set(s.Account, Number(s.SignerWeight || 1)); }
    quorum = Number(signerList.SignerQuorum) || 0;
  }
  const counted = []; const notes = [];
  for (const n of (nodes || []).filter((x) => x && x.signerAddress)) {
    const weight = weights.size ? (weights.get(n.signerAddress) || 0) : 1;
    if (!weight) continue; // on cluster.json but not on the list: not a signer any more
    if (!(Number(n.createdOnTimestamp) > 0) || !(Number(n.lifeMoments) > 0)) { notes.push(`signer node ${String(n.pubkey).slice(0, 10)} has no lease data and is not counted`); continue; }
    counted.push({ expiresAt: nodeExpiryMs({ createdOnTimestamp: Number(n.createdOnTimestamp), lifeMoments: Number(n.lifeMoments) }, momentSec, baseIdx), weight });
  }
  const reason = notes.length ? notes.join('; ') : null;
  if (!counted.length) return { lease: null, reason: reason || 'no signer nodes in cluster.json' };
  if (!quorum) quorum = counted.reduce((s, c) => s + c.weight, 0);
  counted.sort((a, b) => b.expiresAt - a.expiresAt);
  let acc = 0; let deadlineMs = null;
  for (const c of counted) { acc += c.weight; if (acc >= quorum) { deadlineMs = c.expiresAt; break; } }
  if (deadlineMs === null) return { lease: null, reason: `${reason ? reason + '; ' : ''}the ${counted.length} signer nodes counted cannot reach the quorum of ${quorum}` };
  return { lease: { deadlineMs, quorum, signers: counted.length, momentMs: momentSec * 1000, aligned: baseIdx !== null && baseIdx !== undefined, expiries: counted.map((c) => c.expiresAt), asOf: nowMs }, reason };
}

// ---- Reconciliation ---------------------------------------------------------------------------
//
// The core debits a payout when it plans it and records the transaction hash when the submission
// returns. A process that dies in between leaves the payout "planned" with no hash — and the
// Payment may or may not be on the ledger. Every intent carries its id in a memo, so the answer
// is on the ledger: found → here is its hash and result; not found after its ledger window →
// it was never submitted and the core refunds it.
XahauBridge.prototype._reconcile = async function reconcile(ctx, xrpl, state) {
  const stale = Object.entries(state.payouts || {}).filter(([, p]) => p.status === 'planned' && !p.txHash && p.lcl < ctx.lclSeqNo);
  if (!stale.length) return [];
  const ledgerNow = xrpl.xrplApi.ledgerIndex;
  const oldest = Math.min(...stale.map(([, p]) => Number(p.plannedLedger) || 0));
  const from = oldest > 0 ? oldest - 2 : Math.max(1, ledgerNow - 200);
  const txs = (await xrpl.xrplAcc.getAccountTrx(from, -1, true)) || [];
  // Only the connector's own Payment with exactly the planned destination, amount and tag can
  // settle a planned payout: account_tx lists incoming transactions too, and a memo is just text
  // anyone can write. The earliest validated match wins; a success beats a failure.
  const byIntent = new Map();
  for (const t of txs) {
    const tx = t.tx || t.tx_json || t;
    if (!tx || t.validated === false) continue;
    const id = intentIdFromMemos(tx.Memos);
    if (!id) continue;
    const p = state.payouts[id];
    const amount = tx.Amount !== undefined ? tx.Amount : tx.DeliverMax; // rippled API v2 reports DeliverMax
    if (!p || tx.Account !== this.master || tx.TransactionType !== 'Payment' || tx.Destination !== p.destination || String(amount) !== String(p.amount)) continue;
    const tag = tx.DestinationTag === undefined ? null : tx.DestinationTag;
    if ((p.tag === null || p.tag === undefined ? null : p.tag) !== tag) continue;
    const hit = { hash: tx.hash || t.hash, resultCode: (t.meta && t.meta.TransactionResult) || (tx.meta && tx.meta.TransactionResult) || null, ledger: Number(t.ledger_index || tx.ledger_index) || 0 };
    const prev = byIntent.get(id);
    const better = !prev || (hit.resultCode === 'tesSUCCESS' && prev.resultCode !== 'tesSUCCESS') || (hit.resultCode === prev.resultCode && hit.ledger < prev.ledger);
    if (better) byIntent.set(id, hit);
  }
  const out = [];
  for (const [id, p] of stale) {
    const hit = byIntent.get(id);
    if (hit && hit.hash) out.push({ id, hash: hit.hash, resultCode: hit.resultCode });
    else if (ledgerNow - (Number(p.plannedLedger) || 0) > LEDGERS_UNTIL_LOST) out.push({ id, lost: true });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
};

// One line per node: life bought, life targeted, minutes until the lease ends; plus the
// operations everpocket still has queued (extends, acquires, removals).
XahauBridge.prototype._leaseSummary = function leaseSummary(r) {
  try {
    const momentSize = r.evernodeContext.getEvernodeConfig().momentSize;
    const nodes = r.clusterContext.getClusterNodes();
    const now = r.hpContext.timestamp;
    const parts = nodes.map((n) => {
      const expiry = (n.createdOnTimestamp || 0) + n.lifeMoments * momentSize * 1000;
      const left = n.createdOnTimestamp ? Math.round((expiry - now) / 60000) : null;
      return `${String(n.pubkey).slice(0, 10)} life ${n.lifeMoments}/${n.targetLifeMoments}${n.maxLifeMoments ? `/${n.maxLifeMoments}` : ''} ${left === null ? 'no timestamp' : `${left} min left`}${n.isUnl ? '' : ' (not in UNL)'}`;
    });
    const ops = r.clusterContext.operationData && r.clusterContext.operationData.operations ? r.clusterContext.operationData.operations.map((o) => o.type).join(',') : '?';
    const pending = r.clusterContext.getPendingNodes ? r.clusterContext.getPendingNodes().length : 0;
    return `${nodes.length} nodes [${parts.join('; ')}], queued ops [${ops}], pending acquires ${pending}, moment ${momentSize}s`;
  } catch (e) { return `summary unavailable: ${String(e && e.message ? e.message : e).slice(0, 120)}`; }
};

// Temporarily tee console output (everpocket's logger) into a list, stripped of ANSI colour.
function captureConsole(max = 40) {
  const util = require('util');
  const lines = [];
  const names = ['log', 'info', 'warn', 'error'];
  const originals = {};
  for (const n of names) {
    originals[n] = console[n];
    console[n] = (...a) => {
      try { if (lines.length < max) lines.push(util.format(...a).replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{8} \d\d:\d\d:\d\d: /, '').slice(0, 240)); } catch (e) { /* ignore */ }
      originals[n](...a);
    };
  }
  return { lines, restore() { for (const n of names) console[n] = originals[n]; } };
}

// Every transaction hash the core is waiting on, with the ledger (and round) its intent was planned in.
function knownHashes(state) {
  const m = new Map();
  const add = (hash, rec) => { if (hash) m.set(hash, { ledger: Number(rec.ledger || rec.plannedLedger) || 0, lcl: Number(rec.lcl) || 0 }); };
  for (const p of Object.values(state.payouts)) add(p.txHash, p);
  for (const c of Object.values(state.channels)) {
    if (c.redeemPending) add(c.redeemPending.hash, c.redeemPending);
    if (c.closePending) add(c.closePending.hash, c.closePending);
  }
  if (state.treasury.offerPending) add(state.treasury.offerPending.hash, state.treasury.offerPending);
  return m;
}

// The ledger's own word on a transaction: { resultCode } once validated, null when it has none
// (or the query failed — then the caller waits rather than concludes).
async function txOnLedger(xrpl, hash) {
  try {
    const info = await xrpl.xrplApi.getTxnInfo(hash, {});
    if (!info || !info.validated) return null;
    const code = (info.meta && info.meta.TransactionResult) || (info.meta_data && info.meta_data.TransactionResult) || null;
    return code ? { resultCode: code } : null;
  } catch (e) { return null; }
}

const RIPPLE_EPOCH_MS = 946684800000;
function rippleToMs(rippleSeconds) { return RIPPLE_EPOCH_MS + rippleSeconds * 1000; }

module.exports = { XahauBridge, leaseDeadline, nodeExpiryMs, EVERNODE_CACHE_FILE, LEASE_TIMESTAMP_SLACK_SEC, LEDGERS_UNTIL_LOST };
