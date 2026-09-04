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

A payout that fails is not retried every round — the ledger charges its fee even for a
rejected Payment, so an address that cannot receive (an account that does not exist, say) would
otherwise drain the connector three seconds at a time. The retry waits 20 rounds after the first
failure and doubles each time, up to 2 000 rounds (about 100 minutes); `retryAfterRounds` in the
`failed` message says how long. A `settle_to` naming a different address or tag resets the wait,
and so does a payout that succeeds.

Every transaction the cluster submits names the intent behind it in a memo (`everlink/intent`,
e.g. `p12`). The state is saved before the transactions of a round go out, so if a node's process
dies while they are in flight — a hung ledger connection, HotPocket's execution limit — the next
round finds the payouts still "planned" with no hash and asks the ledger whether they went out:
a Payment from the connector's account to exactly the planned destination and amount, carrying
that memo, is recorded as the payout's transaction; nothing of the kind after 200 ledgers means it
was never submitted, and the balance is refunded (`payout … failed`, reason `submission lost`, no
backoff — the address did nothing wrong). A transaction whose hash the cluster recorded but the
ledger library did not is likewise looked up on the ledger before it is ever called `expired`.
At most four transactions are submitted per round, closing channels first; anything further waits
a round, in the same order on every node.

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

**The cluster dying** is covered by its last will, below — provided it dies slowly enough to
notice. Every node lost inside a single half hour, or a bug that stalls consensus, would leave
the account frozen with whatever it held, because nothing but the nodes' signer keys can move it.

## If the cluster dies: the last will

Nobody holds a key to the connector's account: after the master key was disabled, only the
cluster's signer quorum (2 of the 3 nodes on the mainnet run) can sign for it. The nodes are
leased Evernode instances, paid for a number of *moments* (hours) at a time from that same
account, and the cluster extends its own leases as they run down. Should it stop being able to
— no EVR left and no XAH to buy some, no host answering, no ledger connection — the leases end,
the nodes are destroyed, and the account is frozen for good with everyone's balances in it.

So the contract carries a last will, executed by the cluster itself while it can still sign:

1. Every observation of the ledger carries a **lease fact**: the consensus time at which the
   signer quorum's hosting is no longer paid for, computed on every node from everpocket's
   cluster record (part of the consensus state), the account's SignerList, and Evernode's
   moment clock — and voted on like every other fact. It is deliberately pessimistic. A lease
   bought in moment *m* for *n* moments is taken to end when moment *m + n* begins, which is
   when a host may act and up to an hour before everpocket's own estimate; and because the
   record's timestamp is written minutes after the purchase (when the instance first answered),
   the purchase is placed a quarter of an hour before it, which can move a node's expiry another
   moment earlier. The one assumption: that gap is never more than fifteen minutes. Until a vote
   has carried the moment clock, a cruder bound is used (everpocket's estimate less a moment and
   the slack); a record with a signer node whose lease data is missing gives no fact at all,
   and the last known one stands.
2. The cluster renews each node's lease itself once the fact shows `leaseExtendAheadMoments`
   (two) of hosting left for it — see [Keeping the hosts paid](#keeping-the-hosts-paid). If the
   fact still shows **`lastWillSec` or less** (30 minutes by default) for the signer quorum —
   meaning the renewals have been failing for an hour and a half — the connector **winds
   down**, except in a cluster's first `lastWillGraceRounds` (100 rounds, five minutes), when
   short leases are normal and the first renewals are still to come:
   - new Prepares are rejected with `F02 connector is winding down …`, new claims with
     `claim_ack … reason: connector is winding down` (ILDCP still answers, `settle_to` still works);
   - every channel with claims not yet redeemed is redeemed, whatever the amount;
   - every peer's balance is paid out, whatever the amount above `lastWillMinDrops` (0.001 XAH:
     smaller balances would cost more in fees than they deliver), as funds arrive on the ledger,
     keeping back only the ledger's own reserve for the account (`lastWillReserveDrops`, 3 XAH)
     rather than the operating reserve — to the address the peer registered with `settle_to`,
     or, if it never did, **back to the account that owned the channel it first funded itself
     from** (remembered when the channel was bound, so a closed channel still counts). Payouts
     made this way carry `lastWill: true`. A peer with neither keeps its balance in the account
     until it sends a `settle_to`, which is honoured in the same round. Four transactions per
     round, so a busy connector takes a few rounds to pay everyone; the order is by peer key and
     the same on every node.
   - every connected peer gets a `last_will` output saying so, with the deadline, its balance and
     where the money is going; `info` shows `winding: true` and the lease fact to anyone who asks.
     A peer that wants its money somewhere other than the channel it funded from should have
     said so beforehand: the notice and the first payouts go out in the same round.
3. Should the hosting be paid for again after all — a top-up, a host coming back — normal
   operation resumes once a full moment more than `lastWillSec` is paid for (peers hear
   `last_will … active: false`); nothing already paid out is asked back, and peers simply fund
   again.

What the last will does not do: it leaves the connector's own float (its fees and the ledger
reserve) in the account, since no one owns it; it cannot help a peer whose money it never knew
where to send; it cannot pay out more than is on the ledger (a shortfall is deferred, and dies
with the cluster if nothing arrives); and it cannot run if the cluster dies faster than its clock
can see. Set a payout address early — it is where your money goes when the connector cannot ask
you.

## Where the fees go

Fees accrue in XAH in the connector's account and are the only income of the cluster. When the
account's EVR balance falls under `evrReserve`, and there is free equity (ledger balance minus
reserve minus everything owed to peers), the treasury places an immediate-or-cancel offer on
the Xahau DEX to buy EVR with up to `evrTopUpXahDrops` of XAH, asking at least `evrTopUpMinEvr`
for it; if the book cannot fill it, it waits twenty rounds and tries again. That EVR is what
the lease renewals below are paid with. On the mainnet runs the leases cost millionths of an
EVR per hour, so no DEX purchase was ever needed.

## Keeping the hosts paid

Every node of the cluster is a leased Evernode instance, paid for in moments (hours) from the
connector's account, and a lease that is not renewed ends with the instance. The lease fact
(above) lists every node with the time its hosting is paid until, on the same pessimistic clock
the last will uses. From that the core plans renewals like any other settlement:

- a node is due once it has `leaseExtendAheadMoments` (two) of hosting left; the one closest
  to running out goes first, and **one node is renewed per round** — each renewal is a
  multisigned EVR payment to the host, carried out in the submission phase like a payout,
  never cut short by the housekeeping phase's time limit;
- each renewal buys `leaseExtendMoments` (24) more moments;
- a host that will not take the payment — inactive on the Evernode registry, out of reach,
  its hook rejecting — is that node's problem alone: the node waits out a backoff of its own
  (20 rounds, doubling per failure, at most 200 — ten minutes) while the others are renewed
  on their turn, and a success resets it. `info` shows the bookkeeping as `leases`, and the
  node's `diag` events (`{"t":"diag","events":500,"filter":"lease"}`) show every attempt;
- nodes everpocket is still bringing up (their initial life) and nodes at their maximum life
  are left to everpocket, which also keeps pruning dead nodes and buying replacements.

This replaces everpocket's own renewal loop, which renews one node per housekeeping round in
cluster order and retries a failing one until it succeeds — so one host that would not take
the payment held every node behind it in the queue until their leases ran out. That is how the
second mainnet cluster died (see [proof.md](proof.md#day-two-how-the-second-cluster-died)).
