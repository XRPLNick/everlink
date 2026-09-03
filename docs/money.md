# Money: funding, fees, settlement and risk

Everything below is enforced by the contract's deterministic core (`contract/src/core/connector.js`),
identically on every node. Amounts are in drops (1 XAH = 1 000 000 drops).

## Your balance at the connector

Each peer has a `balance` (spendable) and a `held` amount (locked behind in-flight Prepares).
Both live under your HotPocket public key. The connector **lends nothing**: a Prepare is
accepted only if its amount is at most `balance + probe credit`, where the probe credit is a
fixed 0.01 XAH extended to every peer so that STREAM receivers who never funded anything can
still answer the payer's rate-probe packets. Everything else has to be prepaid.

## Funding in: payment channels and claims

1. Open a Xahau payment channel from your account **to** the connector's account
   (`masterAddress` in the `info` read request), with a `PublicKey` you control and a
   `SettleDelay` of at least `minSettleDelaySec`.
2. The cluster observes the ledger every `factsEvery` rounds and votes on what it saw; once the
   channel is in the agreed facts, claims on it are accepted.
3. Send a signed claim: the cumulative number of drops you authorise the connector to draw.
   The contract verifies the signature against the channel's public key with pure
   cryptography — no node has to ask the ledger, so all nodes reach the same verdict — and
   credits the difference to the previous claim **immediately**.
4. The channel is **bound** to the first identity that presents a valid claim on it; other
   identities cannot claim on it afterwards, so nobody can spend a channel you funded.

Rules enforced on claims: strictly increasing amounts; never above the channel's funding;
channel not expired; settle delay at least `minSettleDelaySec` (a channel that could be
closed faster than the connector redeems it would let a claim be pulled out from under it);
valid signature.

If you push funds on-ledger yourself (a `PaymentChannelClaim` from the channel's owner), the
connector notices at its next observation, fast-forwards its claim watermark and credits the
bound peer once — the same money is never counted twice.

## Redemption: turning claims into ledger balance

Claims are IOUs until the cluster redeems them. It does so with a multisigned
`PaymentChannelClaim` when the unredeemed part of a channel reaches `redeemThresholdDrops`
(1 XAH on the deployed configuration; 10 XAH by default), or **immediately** when the channel's
owner asks to close it — an unredeemed claim on a closed channel would be a loss. In the
mainnet run the redemption landed one second after the claim was credited, because the
channel's first claim already cleared the threshold. A redemption that never confirms is
retried after 200 rounds.

Redemption is invisible to you except for the ledger: it does not change your balance.

## Paying: what a packet costs

For a Prepare of `A` drops, the fee is `ceil(A × feeBps / 10 000) + feeFlat`, computed per
packet and rounded up. The destination receives `A − fee`; the fee accrues to the connector's
treasury. Deployed values: `feeBps` 25 (0.25 %), `feeFlat` 0 — so a 1 XAH payment delivered
0.9975 XAH. Defaults in the code: 10 bps, 0.

While the packet is in flight, `A` is moved from your `balance` into `held`. It returns to
`balance` on a Reject, on expiry (`R00`), or when the destination disconnects (`T01`); on a
valid Fulfill the hold is released and the destination is credited. Nothing is charged for
rejected or expired packets.

## Paying out

You name a Xahau address (and optional tag) with `settle_to`. The cluster then plans a
multisigned `Payment` to it:

- automatically, when your balance reaches `payoutThresholdDrops` (0.5 XAH deployed; 5 XAH
  default), or
- on request (`withdraw`), when your balance is at least `minPayoutDrops` (0.1 XAH deployed;
  1 XAH default).

Payouts are paid **only from funds already on the ledger**: the account's balance minus its
reserve (`reserveDrops`, 5 XAH deployed) minus payouts already planned. If that is short —
typically because a redemption is still in flight — your payout is deferred a few rounds, not
lost. The amount is debited from your balance when the payout is planned, so it cannot be
spent twice; if the transaction fails, or is rejected on submission, the amount is refunded and
you get a `payout … failed` message. You see `submitted` (with the transaction hash) when the
cluster's nodes have co-signed and submitted it, and `validated` when the ledger confirms it.

The mainnet run's payout: 0.996499 XAH to Bob, 3 signers, fee 60 drops, ledger 25,528,756 —
see [proof.md](proof.md).

## Closing a channel

Ask Xahau to close (`PaymentChannelClaim` with `tfClose` from your side). The connector, as the
channel's destination, sees the pending expiration at its next observation and closes the
channel at once with its own `tfClose` — redeeming any outstanding claim first — so your
unclaimed remainder comes back without waiting out the settle delay. Credit you claimed but
did not spend stays on your balance; `withdraw` it when it is at least `minPayoutDrops`.

## What can go wrong, and for whom

**Your exposure to the connector** is the balance it holds for you: at most what accrues
between payouts (the payout threshold plus one round of receipts), or whatever you leave
there on purpose. Claims you have signed but the connector has not redeemed are *its* risk,
not yours — the money is still in your channel until it redeems.

**The connector's exposure** is custodial: its ledger float plus claims it has credited but
not yet redeemed. Those funds are controlled by the cluster's signer quorum, so a colluding
quorum of hosts (2 of 3 on the mainnet cluster) could take them. Mitigations are economic —
small float, early redemption, a reserve, payout thresholds — and are why the mainnet run was
made with pocket money.

**Loss of your key** loses your balance: there is no recovery path, because there is no
administrator to appeal to. Persist the HotPocket private key with the same care as a wallet
seed.

**A cluster outage longer than a channel's settle delay** could let a channel close with claims
unredeemed. The connector refuses channels with short settle delays and redeems the moment a
close starts, but cannot redeem while it is down.

## Where the fees go

Fees accrue in XAH in the connector's account and are the only income of the cluster. When the
account's EVR balance falls under `evrReserve`, and there is free equity (ledger balance minus
reserve minus everything owed to peers), the treasury places an immediate-or-cancel offer on
the Xahau DEX to buy EVR with up to `evrTopUpXahDrops` of XAH, asking at least `evrTopUpMinEvr`
for it; if the book cannot fill it, it waits twenty rounds and tries again. everpocket's Nomad
loop then spends that EVR on extending the nodes' Evernode leases. On the mainnet run the
leases cost 0.000012 EVR for four hours, so no DEX purchase was needed.
