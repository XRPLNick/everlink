# Nomad Connector

An Interledger connector that nobody runs.

The connector is a [HotPocket](https://docs.evernode.org/) smart contract hosted on
[Evernode](https://evernode.org/): every node of the cluster executes the same deterministic
code, the cluster collectively owns a Xahau multisig account (one signer key per node, 80 %
quorum — the standard everpocket layout), peers pay for what they use through ILP fees, and
the contract pays for its own hosting by extending its Evernode leases in EVR from that
account. It is the 2019 forum idea — *"connectors run as decentralised contracts … where no
one party runs the contract, all parties who use it pay for it as they use it, and it in turn
pays for its own resource usage"* — built on the platform that now exists for it.

**Status: ran on Evernode mainnet.** On 3 September 2026 the contract ran on three Evernode
mainnet hosts (three domains in two countries; the two Dutch hosts turned out to share one IP
address, so count it as two independent operators — leases 0.000001 EVR/moment each) and settled a real payment on
Xahau mainnet: Alice opened a 5 XAH channel to the cluster account, streamed a 3 XAH claim,
paid Bob 1 XAH with the unmodified `ilp-protocol-stream` (24 s at 3-second rounds), and the
cluster redeemed her channel and paid Bob 0.996499 XAH with transactions signed by its three
signer keys under consensus (2-of-3), then closed the channel on her request and returned her
unspent 2 XAH. The deterministic core, the peer plugin, the multi-node simulator and the STREAM
end-to-end are tested (`npm test`, 20 tests); the local `hpdevkit` run is in `deploy/local/`,
the Evernode kit and the mainnet transcript in [deploy/testnet/README.md](deploy/testnet/README.md).
Every mainnet transaction, with hashes and signers, is laid out for independent checking in
[docs/proof.md](docs/proof.md), together with a packet-level trace of a payment through the
cluster: every ILP Prepare/Fulfill/Reject, the STREAM frames inside them decrypted, every
fulfillment hashed against its condition ([docs/proof/stream-trace.txt](docs/proof/stream-trace.txt)).

```
npm install --ignore-scripts      # blake3 (a hotpocket-js-client dep) tries to download a native build otherwise
npm test                           # core, simulator, plugin + STREAM end-to-end, production bridge, round diagnostics
npm run demo                       # narrated run: pay, settle, pay the hosts
```

## What it does

```
        Alice (ilp-plugin-hotpocket)                          Bob (ilp-plugin-hotpocket)
             │  {"t":"ilp", id, ILP Prepare}                        ▲
             ▼                                                      │ forwarded Prepare
   ┌──────────────────────── HotPocket user channel ─────────────────────────┐
   │        Nomad Connector — one contract, N nodes, one consensus round     │
   │  facts (voted) ─► process inputs ─► sweep expiries ─► plan settlement   │
   │  balances │ pending packets │ channels & claims │ payouts │ treasury    │
   └────────────────────────────┬────────────────────────────────────────────┘
                                │ multisigned PaymentChannelClaim / Payment / OfferCreate
                                ▼          + lease extensions in EVR (everpocket Nomad)
                     Xahau: cluster's multisig account
```

* **Routing.** Peers are HotPocket users; their ILP address is `<prefix>.<user public key>`.
  Prepares are forwarded to the addressed peer minus a basis-point fee, replies flow back
  under the same id, expiries are enforced against the consensus timestamp. ILDCP is served so
  unmodified `ilp-protocol-stream` works on both ends.
* **Funding in.** A peer opens a Xahau payment channel *to* the connector's account and streams
  signed claims. Claims are verified in-contract (pure crypto), credited immediately, and
  redeemed on-ledger in batches or the moment the owner starts closing the channel.
* **Paying out.** Once a peer is owed more than a threshold (or asks), the cluster multisigns
  a Payment to the peer's Xahau address — only from funds already on the ledger, never from
  unredeemed claims.
* **Self-funding.** Fees accrue in XAH. The treasury keeps an EVR reserve, buying EVR on the
  Xahau DEX from free equity; everpocket's `NomadContext` extends the nodes' leases and
  replaces dead nodes from the same account.
* **Nothing lent.** A peer can only send what it has prepaid (plus a 0.01 XAH probe credit so
  receivers can run STREAM's rate probes). A peer's exposure to the connector is bounded by
  the payout threshold; the connector's custodial exposure is its float plus unredeemed claims.

## Layout

```
contract/            the HotPocket contract (bundled with ncc for deployment)
  src/core/          deterministic core: connector.js (rounds), ilp.js, claims.js, codec.js, state.js
  src/round.js       one consensus round: inputs -> facts -> core -> intents -> outputs -> persist
  src/adapters/      xahau-bridge.js (everpocket: votes, multisig, Nomad), npl-vote.js
  src/index.js       HotPocket entry point (hotpocket-nodejs-contract)
  nomad.config.example.json, hp.cfg.override
plugin/              ilp-plugin-hotpocket: the ilp-plugin interface over the HotPocket user channel
sim/                 in-process HotPocket simulator + mock Xahau (channels, multisig, DEX, leases)
test/                unit, simulator, STREAM end-to-end and production-bridge tests
deploy/              hpdevkit / evdevkit instructions
docs/                design document, docs/proof.md and the evidence (explorer screenshots, packet trace)
```

## Peer protocol (JSON over the HotPocket user channel)

| peer → connector | meaning |
|---|---|
| `{"t":"ilp","id":…,"p":<base64 packet>}` | a Prepare to route, or a Fulfill/Reject answering a forwarded Prepare |
| `{"t":"claim","ch":…,"amt":…,"sig":…}` | signed payment-channel claim (cumulative drops) |
| `{"t":"settle_to","addr":"r…","tag":n}` | where to pay this peer out |
| `{"t":"withdraw"}` | pay out now (≥ `minPayoutDrops`) |
| read requests `info` / `balance` / `channels` | answered from state, no mutation |

Outputs: `ilp`, `claim_ack`, `payout {submitted|validated|failed}`, `ack`, `err`.

## Design choices worth knowing

* **Determinism first.** `processRound()` is a pure function of `(state, config, round input)`.
  Anything non-deterministic — ledger queries, transaction results — enters only as *facts*
  the cluster has voted on over NPL. The simulator hashes every node's state after every round
  and fails on the first divergence; the tests include a deliberate fork.
* **Two rounds per hop.** A packet crosses the contract in two consensus rounds (Prepare in /
  out, Fulfill in / out). Throughput comes from batching many packets per round, not from
  per-packet speed; `minExpiryWindowMs` must exceed two rounds.
* **Hub, not mesh.** Contracts cannot deterministically dial out, so every peer connects in.
  Routes are the connector's own peers only (no route announcements = no hijacking).
* **Control.** No admin key exists in the protocol: no upgrade message, no privileged peer, no
  parameter change at runtime. Hosts can only co-sign what consensus produced. That maps onto
  the "non-controlling developer or provider" test in the Blockchain Regulatory Certainty Act
  (S.3611 / CLARITY §604) — a design goal, not legal advice.

## Known gaps

* No liquidity providers: the float is whatever the account starts with plus fees.
* Single asset (XAH). Multi-asset routing needs per-asset ledgers and a rate source.
* One channel per peer direction is assumed; channel key rotation is not handled.
* everpocket's own bookkeeping (`transactions.json`) is written from unvoted ledger queries.
* The tenant's master key still controls the cluster account alongside the SignerList; retiring
  it (`SetRegularKey` + `asfDisableMaster`) is a deliberate manual step.
* Peers' HotPocket identities are their account at the connector: lose the key, lose the credit.

## License

MIT — see [LICENSE](LICENSE).
