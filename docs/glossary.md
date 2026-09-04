# Glossary

**Claim (payment-channel claim)** — A signature by a Xahau payment channel's owner authorising the
channel's destination to draw a cumulative amount. Off-ledger until redeemed. Everlink peers fund
their balance by sending claims to the connector; the connector redeems them with
`PaymentChannelClaim` transactions.

**Cluster** — The set of HotPocket nodes running one contract instance in consensus. For Everlink,
three Evernode hosts on the mainnet run; every node runs the same code on the same inputs and
co-signs the same transactions.

**Condition / fulfillment** — ILP's hashlock: a Prepare carries a 32-byte condition; the packet is
paid only if the receiver returns the 32-byte preimage whose SHA-256 equals it. The connector
checks this on every Fulfill.

**Consensus round** — HotPocket's unit of time: the nodes agree on the set of user inputs, run
the contract on them, and agree on the outputs and the resulting state hash. 3 s on the deployed
configuration. A packet crossing the connector costs two rounds per direction.

**Drops** — The smallest unit of XAH: 1 XAH = 1 000 000 drops. All amounts in the protocol are
drops, as decimal strings.

**Evernode** — The hosting network on Xahau: hosts lease HotPocket instances for EVR per moment.
Everlink's cluster is such a set of leased instances, chosen for reputation, reachability and
operator diversity.

**everpocket** — Evernode's contract library for Xahau-aware clusters: voting over NPL
(`VoteContext`), multisign-and-submit (`XrplContext`), and self-managing cluster models
(`ClusterContext`, `NomadContext`). Everlink's bridge is built on it.

**EVR** — Evernode's token, in which hosts are paid. The connector's treasury keeps a reserve
of it and buys more on the Xahau DEX from fees when it runs low.

**Facts** — What the connector's core is allowed to know about the outside world: account balance,
channels, EVR balance, transaction results. Each node observes them, the cluster votes, and only
the agreed values enter the deterministic core.

**HotPocket** — Evernode's consensus engine for smart contracts written in ordinary languages
(here Node.js). Contracts run per round on agreed inputs; users connect over WebSocket
("user channel") and are identified by ed25519 keys.

**HotPocket user / user key** — A client of a HotPocket contract, identified by its ed25519 public
key. An Everlink peer *is* a HotPocket user; its key is its identity, ILP address suffix and the
owner of its balance.

**ILDCP** — Interledger Dynamic Configuration Protocol (RFC 31): a packet to `peer.config` that
asks a connector for one's ILP address, asset code and scale. Answered from configuration.

**ILP / Interledger Protocol** — The packetised value-transfer protocol (RFC 27): Prepare (with
amount, destination, condition, expiry, data) answered by Fulfill (with the preimage) or Reject
(with a code). Everlink is an ILP connector: it forwards Prepares between its peers and relays
the answers.

**ILP address** — Hierarchical name of an ILP node, e.g. `g.everlink.<public key>`. The connector's
prefix plus the peer's HotPocket public key; anything after a further dot is passed through.

**Intent** — A transaction the connector's core wants signed (a redemption, a payout, a close, an
EVR top-up). The bridge has the cluster multisign and submit it; the result comes back as a fact.

**Last will** — What the connector does when the cluster's own hosting is about to lapse and
could not be extended: stop taking Prepares and claims, redeem every channel, pay every peer's
balance to its payout address or back to the account that funded its channel — while the nodes
can still sign. Driven by the lease fact; see [money.md](money.md#if-the-cluster-dies-the-last-will).

**Lease fact** — Part of every ledger observation: the consensus time at which the signer
quorum's Evernode leases are no longer paid for, computed from everpocket's cluster record, the
account's SignerList and Evernode's moment clock, and voted on like every other fact. Shown as
`lease` in the `info` read request.

**Master account / cluster account** — The Xahau account the cluster controls through its
SignerList: destination of peers' channels, source of payouts and lease payments. `masterAddress`
in the configuration and in the `info` read request.

**Moment** — Evernode's billing period for leases, 3600 seconds (an hour) on mainnet. Leases
are counted in whole moments from the one the instance was created in; the moment clock's base
and length come from the Evernode registry.

**Nomad** — everpocket's self-managing cluster model: the contract itself extends leases,
replaces failed nodes and adds new signers from the master account. The `nomad` configuration
section is its settings.

**NPL (node party line)** — HotPocket's node-to-node message channel within a round, used by the
cluster to vote on facts and to collect signatures for multisigned transactions.

**Payment channel** — A Xahau ledger object locking XAH from an owner to a destination; the
destination redeems signed claims against it. Everlink's inbound funding mechanism.

**Payout** — A multisigned `Payment` from the master account to a peer's registered address,
made when the peer's balance reaches the payout threshold or on `withdraw`.

**Peer** — Anyone connected to the connector with a HotPocket key: payer, receiver or both.

**Probe credit** — 0.01 XAH the connector extends to every peer beyond its balance so receivers
that never funded anything can answer STREAM's rate probes.

**Read request** — A HotPocket query answered by one node from agreed state without a consensus
round (`info`, `balance`, `channels`, `diag`).

**Redemption** — The connector turning a claim into ledger balance with a multisigned
`PaymentChannelClaim`.

**Signer list / quorum** — Xahau's native multisig: the master account lists the nodes' signer
keys with weights and a quorum; a transaction is valid when enough signers sign it (2 of 3 on
the mainnet cluster). evdevkit generates one signer key per node at cluster creation.

**STREAM** — The Interledger transport protocol (RFC 29) used by `ilp-protocol-stream`: connection
set-up, rate probing, splitting a payment into packets, encrypted frames inside the ILP packet
data. Works unmodified over Everlink.

**Tenant** — Evernode's term for the account that leases instances. In the Evernode kit the
tenant account *is* the cluster's master account.

**Xahau** — The ledger Everlink settles on: an XRPL-family network with payment channels,
native multisig and hooks; network id 21337 on mainnet.
