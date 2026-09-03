# Verify the mainnet run yourself

Everything the cluster did on 3 September 2026 is on Xahau mainnet, signed by the three
signer keys that exist only inside the three HotPocket instances. Nothing below needs our
logs; every line can be checked on a public explorer. Times are UTC ledger close times.

## The cluster's account

`r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC`

- <https://xahauexplorer.com/account/r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC>
- "Account control · multisig": multi-sign enabled, threshold **2**, three signers of weight 1:
  `rDBMkZ5kB6i1VGF9tqgfb4UPZNNSH2RfV`, `rn6nEpGCb8xgaWeM6EbDEBqxV6VnzPuDmL`,
  `rN5vZKscbVZ5hnYRcReMCPocqH9TmFpbKZ`. The three signer accounts are not funded and hold
  nothing; they are only the identities of the keys HotPocket generated on each host.
- Owner objects (25): the EVR trust line, the signer list and 23 Evernode lease URITokens —
  the three leases of this cluster plus the leases of the seven attempts that failed before it
  (see `deploy/testnet/README.md`). That is why the explorer shows 5.98 XAH spendable of 11.98.
- The account was funded by hand with 10 XAH and 1 EVR; the balance went 9.981223 → 11.984544 XAH
  over the run (+3 redeemed, −0.996499 paid to Bob, −0.00018 in fees for three multisigned
  transactions at 60 drops each), and the nodes' own ledger facts agree (`status.log`:
  `facts ledger 25529548 balance 11984544 EVR 0.999905 channels 0`).

## Transactions of the account, oldest first

| UTC | Ledger | Type | Hash | What it is |
|---|---|---|---|---|
| 04:25–04:26 | — | URITokenBuy ×3 | `D38D1A6023CCEE12CCEC1D02914938B8771D82980C3363BFC2D3549A225A8749`, `71CD505B04B45F1768623B042C99A9F2EE4F33A3D93EA63EFC3269D0D6D39B37`, `714444A6B39B6C105C76678F1472D58A1FA4E74D0F2B7F48F97E4BCC067AF6BB` | Leases bought from hosts `rBF7RNNxJKfxJN5pwa4cWPxQoPRr7cSxkj` (evernode4.kimchigraphics.com), `ra9mwK9wqN7dW3L3K6pizMfCLnQCanJK5t` (evernode12.laurenka.nl), `rM1897uwo8oXYzpuJBVrFvJc56fstebBda` (zeb-a-nodew-01.xahaud.xyz), 0.000001 EVR each; memo `EvnAcquireLease` |
| 04:26 | — | SignerListSet | `91BB358BA7FB558051039577FD7F1B3C43AF1B7662A8CB64F1C274BA55012904` | Installs the three host-held signer keys, quorum 2 of 3 |
| 04:26 | — | Payment ×3 (EVR) | `6B28F620E3F5AEFCA6E10DACFA2B0B42D60C6AE2CAC9AC30050BE8FF0872D44A`, `C55D46BF8F845C3B61BD4B68A9CDEA6CD1294ABF42AC874AB9396FE2B1C9B9C9`, `C14F4D330B7EDAD0E36A6E777710B2DD012B20984401780AAC81966F85BE03F2` | 0.000003 EVR to each host: lease extended from 1 to 4 moments (hours) |
| 04:38:01 | 25,528,727 | PaymentChannelCreate | `A209442816A26236119F59D18FA3C7981DB2823556FA535C8F762655E54494CD` | Alice (`rLwxGWqbvXKo8n8VfgqHDZ1ijKBNUn63rD`) opens a 5 XAH channel to the cluster account, SettleDelay 3600 |
| 04:38:21 | 25,528,733 | PaymentChannelClaim | `E2F5D4FCC24E700010F999FE847DBEEB7F9B018A44A31F92CFD0A0042B22FFFC` | The cluster redeems Alice's signed claim: Balance 3,000,000 drops; **3 signers**, fee 60 drops |
| 04:39:40 | 25,528,756 | Payment | `2BFB084E2ECA77F01F2E9E8C821D84C3303B6EB1D0AB4966076300784498836D` | 0.996499 XAH to Bob (`rpjRMytx1WoHraemK1zGXfxkokY1JaPcit`): the 1 XAH Alice streamed, net of the connector's 0.25 % spread; **3 signers** |
| 04:41:01 | 25,528,780 | PaymentChannelClaim | `B7A1FCC29F1B8D2B00B0A1F2308DB95FB6127234C79FECD043BFC9BD0F8D7E8A` | Flags 131072 (tfClose): the cluster closes the channel after Alice asked; her unspent 2 XAH return to her; **3 signers** |

Open any of them as `https://xahauexplorer.com/tx/<hash>`. The explorer lists the signers on
each cluster transaction; "Raw data" shows `SigningPubKey: ""` (no master-key signature) and
the three `Signers` entries with the signer accounts from the signer list.

Alice's and Bob's accounts tell the same story from the other side: Alice
`rLwxGWqbvXKo8n8VfgqHDZ1ijKBNUn63rD` went 2.999988 → 4.999976 XAH when the channel closed
(her own close request is on her account, seconds before the cluster's close); Bob
`rpjRMytx1WoHraemK1zGXfxkokY1JaPcit` went 2 → 2.996499 XAH.

## The hosts

The three hosts are ordinary registered Evernode hosts, chosen for reputation, open ports and
distinct registrable domains. Their registry entries (reputation 252, lease 0.000001 EVR/moment,
version 0.12.1, countries NL / FR / NL) are visible on the community Evernode dashboard at
<https://xahau.xrplwin.com/evernode> (search the host address).

One honest footnote: `evernode4.kimchigraphics.com` and `evernode12.laurenka.nl` both resolve
to `188.142.46.148` (the nodes' own connectivity probes in `deploy/testnet/out/status.log`
show it), so they are at least co-located and may well be one operator with two domains.
`zeb-a-nodew-01.xahaud.xyz` is `54.37.252.135`, OVH Gravelines, France. With a 2-of-3
signer list, whoever controls those two Dutch machines could in principle sign for the account
outside the contract's consensus. The host picker now spreads by resolved /24 network as well
as by domain (`deploy/testnet/hosts.js`) so the next cluster lands on three networks.

## The ILP/STREAM part: a packet trace

The settlement is on the ledger; the payment itself is not, by design — that is what ILP is
for. So the proof for that layer is the packets. `deploy/testnet/trace-stream.js` ran a second
payment through the live cluster at 05:48–05:51 UTC and recorded every ILP packet the two
peers' plugins saw, decoded with the standard `ilp-packet` library (RFC 27), with the STREAM
frames inside decrypted using the receiver's shared secret (RFC 29) and every fulfillment
hashed against its condition. Nothing in the connector or the peers was modified for it: the
tracer wraps the plugin's `sendData` and data handler and the unmodified `ilp-protocol-stream`
does the rest.

- [`stream-trace.txt`](proof/stream-trace.txt) — the readable trace, 25 Prepares.
- [`stream-trace.json`](proof/stream-trace.json) — the same with the raw packets (base64), so
  anyone can re-decode them with `ilp-packet` and re-check the SHA-256s.

What it shows, in order: both peers ask the connector for their ILP address with ILDCP
(`peer.config`, RFC 31) and get `g.nomad.<their HotPocket public key>`; Alice's STREAM client
sends its rate probes (1, 1 000, 1 000 000, 10⁹ and 10¹² drops, all with unfulfillable
conditions — the 10⁹ one is refused by the connector as `T04 insufficient prepaid balance`, the
10¹² one as `F08 packet exceeds maximum amount`, the rest reach Bob and come back `F99` with
STREAM's `ConnectionAssetDetails(XAH, 6)` and limits inside); then the money: packet #11,
**1 000 000 drops** from Alice with a `StreamMoney(streamId=1, shares=1000000)` frame, forwarded
to Bob as packet #12 for **997 500 drops** (the 0.25 % spread), fulfilled by Bob with
`00487508…e5d9`, whose SHA-256 is the condition `90b8c6a1…b3ba` Alice put on it; the fulfill
travels back and Alice's `outgoing_money` fires 24 s after she sent the Prepare (two consensus
rounds per hop, plus waiting for the round that observes the ledger). Then Bob's own probes
towards Alice, the `StreamClose` and `ConnectionClose` frames, and the summary line:
fulfilled money leaving senders 1 000 000 drops, reaching receivers 997 500 drops, the
2 500 drops in between being the connector's fee.

That payment settled too, in the same way as the first: channel
`6BC4CFE542C6A6B979CD4E3FAEF4402CC415FAB31A28DBCF9C0B1CF43F9395DD` (Alice, 2 XAH), redeem
`EAC14759657316EDBC983C8788A45898AC82D586A905ED51AA1287D619100CFA` (1 XAH, 3 signers), payout
`9B4C702C07EC3B36ED97E2240033A2701C2D53357D38F2937075C98C3CD46607` (0.996499 XAH to Bob, 3
signers, submitted the moment the fulfill came back), close
`BDB4E2EC7F54AC6071AD8EE9BDDE50BB9EE6D0AE51C1AD20C1DF2D576FCBCDA4` (Alice's unspent 1 XAH
returned). The connector's own counters, readable from any node, went from `claims 1, fulfills 2,
prepares 14, rejects 12` to the new totals at the same time.

## While the lease lasts

The lease runs until about 08:26 UTC on 3 September 2026. Until then anyone can connect to the
nodes themselves — `wss://evernode4.kimchigraphics.com:26231`, `wss://zeb-a-nodew-01.xahaud.xyz:26203`,
`wss://evernode12.laurenka.nl:26311` — with `hotpocket-js-client` and send `{"t":"info"}`
(`node deploy/testnet/status.js` does exactly that). At 05:29 UTC all three answered with the
same contract state: `rounds 592–596`, `stats {"claims":1,"fulfills":2,"prepares":14,"rejects":12}`,
UNL of the same three public keys, HotPocket ledger 660–665 and advancing.

## What this does and does not prove

It proves that a HotPocket contract running on three Evernode hosts on two networks observed
the ledger, verified an off-ledger payment-channel claim, routed an ILP/STREAM payment, and
produced valid multisigned Xahau transactions under 2-of-3 consensus, with no operator
process anywhere and no human signing anything after the cluster was created.

It does not (yet) prove that nobody *could* intervene: the account's master key is still
enabled and held by the person who funded it. Disabling it (`AccountSet` with
`asfDisableMaster`) would make the signer list the only control, at the price of locking the
account for good once the lease runs out unless the contract pays everything out first.
The lease itself was 4 hours; the contract did not have to renew it during the run.
