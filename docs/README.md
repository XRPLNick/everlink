# Everlink documentation

Everlink is an Interledger connector that runs as a HotPocket smart contract on Evernode. Peers
talk to it over the HotPocket user channel with a small JSON protocol; funding comes in through
Xahau payment channels, payouts go out as multisigned Xahau payments, and the cluster pays for
its own hosting. These pages are written for developers who want to connect a peer and move
money through it. Operators deploying a cluster start at [deploy/README.md](../deploy/README.md);
the reasoning behind the design is in the [design note](design.html).

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | From zero to a paid STREAM payment: identity, connecting, funding with a channel claim, paying, receiving, getting paid out. Complete example. |
| [Peer protocol](peer-protocol.md) | The JSON messages over the HotPocket user channel, their fields and limits, read requests, and every ILP rejection code the connector emits. |
| [Plugin API](plugin-api.md) | `ilp-plugin-hotpocket` reference: constructor, methods, events, helpers. |
| [Money: funding, fees, settlement](money.md) | How balances, holds, claims, redemptions and payouts work; what a peer risks and what the connector risks; the last will that pays everyone out if the cluster's hosting lapses. |
| [Configuration](configuration.md) | Every key in `everlink.config.json`, its default and its effect — the numbers a peer sees in the `info` read request. |
| [Troubleshooting](troubleshooting.md) | The errors and rejections you will meet, what they mean and what to do. |
| [Glossary](glossary.md) | HotPocket, Evernode, ILP and Xahau terms used throughout. |
| [Verify the mainnet run](proof.md) | The on-ledger evidence of the 3 September 2026 run and a decoded packet trace. |

## The model in one paragraph

A peer is a HotPocket user: an ed25519 key pair. Connect to any node of the cluster with that
key, and the connector knows you as `<prefix>.<your public key>` — that is your ILP address,
and the balance the connector keeps for you is tied to that key. To fund the balance, open a
Xahau payment channel *to* the connector's account and send it a signed claim; the connector
verifies the signature in-contract and credits you at once. To pay, send ILP Prepares
(normally by pointing `ilp-protocol-stream` at the plugin); to receive, register a data handler
(normally a STREAM server). Fulfilled packets move value between balances minus a
basis-point fee. To get money out, name a Xahau address and either wait for the payout threshold
or ask; the cluster co-signs a Payment to you. Every step is a normal ILP or Xahau action, and
nothing you do depends on trusting any single host.

## Versions

The protocol and API described here are those of the repository at the time of writing (the
code that ran on Xahau mainnet on 3 September 2026). Wire format changes will be noted in
[peer-protocol.md](peer-protocol.md).
