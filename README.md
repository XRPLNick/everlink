# Everlink

An Interledger connector that nobody runs.

The connector is a [HotPocket](https://docs.evernode.org/) smart contract hosted on
[Evernode](https://evernode.org/): every node of the cluster executes the same deterministic
code, the cluster collectively owns a Xahau multisig account (one signer key per node, and a
quorum of them — 2 of 3 on the mainnet run — has to sign every transaction), peers pay for what
they use through ILP fees, and the contract pays for its own hosting by extending its Evernode
leases in EVR from that account.

**Status: ran on Evernode mainnet.** On 3 September 2026 the contract ran on three Evernode
mainnet hosts (two networks — the two Dutch hosts share an IP address, so at most two independent
operators; leases 0.000001 EVR/moment each) and settled a real payment on Xahau mainnet: Alice opened a 5 XAH channel to the cluster account, streamed a 3 XAH claim,
paid Bob 1 XAH with the unmodified `ilp-protocol-stream` (24 s at 3-second rounds), and the
cluster redeemed her channel and paid Bob 0.996499 XAH with transactions signed by its three
signer keys under consensus (2-of-3), then closed the channel on her request and returned her
unspent 2 XAH. A second cluster, deployed the same evening on three new hosts with two-hour
leases, then extended its own leases without anyone asking — three EVR payments to its hosts
co-signed by its three nodes — buying itself nineteen more hours of hosting for 0.000051 EVR. With that proven, the
account's master key was disabled (`AccountSet asfDisableMaster`, ledger 25,544,790): the
cluster's 2-of-3 signer list became the only thing that could move funds in it — nobody ran
the connector, and nobody controlled its account. The next day it renewed one lease on its
own and failed to renew the other two; at 15:20 UTC on 4 September their hosts reclaimed
those nodes, and with one node of three left the cluster could neither close ledgers nor sign.
Its account is frozen for good — nobody's money, no peers had balances — and the renewal loop
has been rebuilt so that one host cannot hold up the others ([docs/proof.md](docs/proof.md#day-two-how-the-second-cluster-died)).
That evening the rebuilt contract went out on a fresh account, on the same three hosts, and
renewed all three of its leases in its second minute — the first attempt failed because the
other signers had not joined the mesh yet, the per-node backoff retried it — three EVR payments
in three consecutive rounds ([docs/proof.md](docs/proof.md#day-two-evening-a-new-cluster-renews-its-own-leases-in-its-second-minute)).
Its master key stays in a person's hands until it has renewed unattended twice. The deterministic core, the peer plugin, the multi-node simulator and the STREAM
end-to-end are tested (`npm test`, 27 tests); the local `hpdevkit` run is in `deploy/local/`,
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

**Documentation** for developers connecting a peer — getting started, the peer protocol, the
plugin API, the money model, configuration, troubleshooting — is in [docs/](docs/README.md).

## What it does

```
        Alice (ilp-plugin-hotpocket)                          Bob (ilp-plugin-hotpocket)
             │  {"t":"ilp", id, ILP Prepare}                        ▲
             ▼                                                      │ forwarded Prepare
   ┌──────────────────────── HotPocket user channel ─────────────────────────┐
   │          Everlink — one contract, N nodes, one consensus round          │
   │  facts (voted) ─► process inputs ─► sweep expiries ─► plan settlement   │
   │  balances │ pending packets │ channels & claims │ payouts │ treasury    │
   └────────────────────────────┬────────────────────────────────────────────┘
                                │ multisigned PaymentChannelClaim / Payment / OfferCreate
                                ▼          + lease renewals in EVR, one node per round
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
  Xahau DEX from free equity; the contract renews each node's Evernode lease itself — the most
  urgent node first, one per round, a host that refuses the payment backing off on its own so
  it never holds up the others — and everpocket's `NomadContext` replaces dead nodes from the
  same account.
* **Nothing lent.** A peer can only send what it has prepaid (plus a 0.01 XAH probe credit so
  receivers can run STREAM's rate probes). A peer's exposure to the connector is bounded by
  the payout threshold; the connector's custodial exposure is its float plus unredeemed claims.
* **A last will.** Every ledger observation carries the time at which the signer quorum's
  Evernode leases run out. If that comes within half an hour and the cluster has not managed to
  extend them, it stops taking money, redeems every claim and pays every peer out — to its
  payout address, or back to the account that funded its channel — while its nodes can still
  sign. Not exercised on mainnet; proven in the simulator ([docs/money.md](docs/money.md#if-the-cluster-dies-the-last-will)).

## Layout

```
contract/            the HotPocket contract (bundled with ncc for deployment)
  src/core/          deterministic core: connector.js (rounds), ilp.js, claims.js, codec.js, state.js
  src/round.js       one consensus round: inputs -> facts -> core -> intents -> outputs -> persist
  src/adapters/      xahau-bridge.js (everpocket: votes, multisig, lease renewals, Nomad prune/grow), npl-vote.js
  src/index.js       HotPocket entry point (hotpocket-nodejs-contract)
  everlink.config.example.json, hp.cfg.override
plugin/              ilp-plugin-hotpocket: the ilp-plugin interface over the HotPocket user channel
sim/                 in-process HotPocket simulator + mock Xahau (channels, multisig, DEX, leases)
test/                unit, simulator, STREAM end-to-end and production-bridge tests
deploy/              local (hpdevkit) and Evernode (evdevkit) kits; deploy/windows/ has the double-click launchers
docs/                documentation (start at docs/README.md), design document, proof.md and the evidence
```

## Peer protocol (JSON over the HotPocket user channel)

| peer → connector | meaning |
|---|---|
| `{"t":"ilp","id":…,"p":<base64 packet>}` | a Prepare to route, or a Fulfill/Reject answering a forwarded Prepare |
| `{"t":"claim","ch":…,"amt":…,"sig":…}` | signed payment-channel claim (cumulative drops) |
| `{"t":"settle_to","addr":"r…","tag":n}` | where to pay this peer out |
| `{"t":"withdraw"}` | pay out now (≥ `minPayoutDrops`) |
| read requests `info` / `balance` / `channels` | answered from state, no mutation |

Outputs: `ilp`, `claim_ack`, `payout {submitted|validated|failed}`, `last_will`, `ack`, `err`.

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
* A cluster that dies fast takes the account with it. With the master key retired, nothing but
  the nodes' signer keys can move funds. The last will covers the slow death — leases that cannot
  be renewed — by paying everyone out while a quorum can still sign; it cannot cover all nodes
  lost inside one half hour, or a bug that stalls consensus, and it cannot pay a peer that never
  gave it an address or a channel. There is no hand-over to a successor cluster, and no upgrade
  path: the mainnet cluster that died on 4 September ran the code from before the last will and
  the rebuilt renewal loop existed.
* Staying alive is not yet proven. Two mainnet clusters renewed leases on their own and both
  died at a later renewal; the second one's failure is diagnosed only by inference, because
  its diagnostics kept a minute of history. The rebuilt loop (one node per round, most urgent
  first, per-node backoff, full history) has renewed a mainnet cluster's three leases once, at
  start-up, with a person watching; its first unattended renewals are due on 5 September.
* Deployment is not reliable: the tenth mainnet deployment — the ninth's procedure on the
  hour's best-ranked hosts — never formed a mesh, for reasons the tooling cannot see, while the
  eleventh, on the ninth's hosts, came up at once ([deploy/testnet/README.md](deploy/testnet/README.md#tenth-deployment-1730-utc-4-september-the-mesh-never-formed)).
* Peers' HotPocket identities are their account at the connector: lose the key, lose the credit.

## License

MIT — see [LICENSE](LICENSE).
