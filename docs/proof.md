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
  (see `deploy/testnet/README.md`). That is why the explorer showed 5.98 XAH spendable of 11.98 at the time.
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
(`peer.config`, RFC 31) and get `g.nomad.<their HotPocket public key>` (`g.nomad` was the
prefix this cluster was configured with, before the project was renamed Everlink; new
deployments default to `g.everlink`); Alice's STREAM client
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

## While the lease lasted

The first cluster's lease ran until 08:26 UTC on 3 September 2026. Until then anyone could connect to the
nodes themselves — `wss://evernode4.kimchigraphics.com:26231`, `wss://zeb-a-nodew-01.xahaud.xyz:26203`,
`wss://evernode12.laurenka.nl:26311` — with `hotpocket-js-client` and send `{"t":"info"}`
(`node deploy/testnet/status.js` does exactly that). At 05:29 UTC all three answered with the
same contract state: `rounds 592–596`, `stats {"claims":1,"fulfills":2,"prepares":14,"rejects":12}`,
UNL of the same three public keys, HotPocket ledger 660–665 and advancing.

## Self-funding: the cluster pays its own hosts

That the connector pays for its own hosting is a separate claim, and the first cluster never
had to make it: its four-hour lease was bought up
front, and when the lease ended the hosts burned the lease tokens (the `URITokenBurn`
transactions at 06:21–08:26 UTC on the account's list) and the cluster was gone.

A second cluster was deployed at 20:19–20:21 UTC the same day to test exactly that, on three
new hosts under three domains and three networks, with a **two-hour** lease and the contract's
Nomad settings (`lifeIncrMomentMinLimit` 4) making the first extension due at once. The kit's
own transactions — three `URITokenBuy` acquisitions, the `SignerListSet` installing the three
new signer keys (`rhFnyCHVEi8aMtaJeHKrEGKrtCAhW4J3a3`, `rEez18V1inAmFMNCQJJPgDR6zWhayzsZCf`,
`rLJ3Bf4ZvwuDbnrLZQVaYJ3rwsm1NfSSeB`) and three one-moment extensions — are the ones signed
by the tenant key, at 20:19–20:21. Then, within four minutes of the nodes starting, the
cluster extended its own leases:

| UTC | Ledger | Hash | Host | Amount |
|---|---|---|---|---|
| 20:24:10 | 25,544,448 | `83CDC6D44E5D925150DE279CDA516D112D5B43936A963B5E8246860457444BF1` | `rfW86DFVRKUCc53pKdWTyGFMTfeYNNERhs` (evernode.kimchigraphics.com) | 0.000017 EVR |
| 20:25:11 | 25,544,464 | `2A1769AE4D82FD5BD10EDD688ADA3062C92F19BAFBB8E0FCB204EDC8F2562460` | `rLJU57DimMryraUobdL3iiAMhMmHHfCmnf` (zeb-a-nodew-04.xahaud.xyz) | 0.000017 EVR |
| 20:26:20 | 25,544,481 | `CAE5EF17A8835CD049076FB75CC5F6871D8519683D2AD00F14BC768B905D9E8A` | `rfHECp4mtFnc6Y3jTsknjJocCisCVjtjf9` (xrp-arnie13.sbs.xrp-arnie1.com) | 0.000017 EVR |

Each is a `Payment` of EVR from the cluster account to the host, with Evernode's
`evnExtendLease` hook parameter (`65766E457874656E644C65617365`) and the node's lease-token
id, `SigningPubKey` empty and **three `Signers` entries — the three new signer accounts** —
and a fee of 600 drops, the multisigned price of a hook-triggering transaction. Seventeen
moments each, chosen at random by everpocket's Nomad loop, so the cluster bought itself about
nineteen hours of hosting for 0.000051 EVR. Nobody asked for it: the contract decided in its
housekeeping round (its diagnostics read `nomad lcl 120: 3 nodes [… life 19/19 1133 min
left …]`), the nodes co-signed it, and one of them submitted it.

For honesty: the first cluster, whose settings would have extended in its last hour, did not
— and its diagnostics did not yet record the Nomad phase, so the reason is unknown. The
second cluster's contract records every housekeeping decision, which is how the lines above
were read. What it did on its second day is below.

## The key is gone

With the second cluster keeping itself alive, the person who had funded the account gave up
control of it at 20:43:37 UTC:

| UTC | Ledger | Hash | What it is |
|---|---|---|---|
| 20:43:37 | 25,544,790 | `F008B4708261BC55A67505004B246181661D89B0CA9040BE765BE2DD23D3C6B0` | `AccountSet` with `SetFlag` 4 (`asfDisableMaster`), signed by the master key — the last thing it ever signed |

The account's flags now include `lsfDisableMaster` (0x00100000; the explorer's account page
shows the master key as disabled). From here on the only way to sign for
`r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC` is its signer list: quorum 2 of the three keys
`rhFnyCHVEi8aMtaJeHKrEGKrtCAhW4J3a3`, `rEez18V1inAmFMNCQJJPgDR6zWhayzsZCf`,
`rLJ3Bf4ZvwuDbnrLZQVaYJ3rwsm1NfSSeB`, each of which exists only inside one host's HotPocket
instance and only signs what the contract's consensus produced. The ~12 XAH and ~1 EVR in the
account are the connector's float now; nobody can sweep them.

`deploy/testnet/retire-master.js` did it, and it refuses to unless the signer list on the
ledger is exactly the running cluster's and at least a quorum of its nodes answers — with the
key gone, a dead cluster would mean a dead account.

## Day two: how the second cluster died

The nineteen hours ran out on 4 September. Nobody was watching, which was the point, and the
account's transaction list tells what happened:

| UTC | Ledger | Hash | What it is |
|---|---|---|---|
| 13:22:00 | 25,561,397 | `DDE117FB44B2AE46D422CC64ABDC3D252F7FAC095E1594900636067E5BC65709` | `Payment` of 0.000022 EVR to `rfW86DFVRKUCc53pKdWTyGFMTfeYNNERhs` (evernode.kimchigraphics.com), `evnExtendLease` for that node's token, **three signers** — 22 more moments for node 1, with no one asking |
| 15:20 | | `5B0FC2DD27BA0548C7761A9022471EA38F3B336566C3DD699DBFC38A51B4B327` | `URITokenBurn` by `rLJU57DimMryraUobdL3iiAMhMmHHfCmnf` (zeb-a-nodew-04.xahaud.xyz): node 2's lease ended, the host reclaimed the instance |
| 15:20 | | `A55939FBF98747B9A4B335C040C16CD0F10A94F428409C3D614E8177BBEDBB32` | `URITokenBurn` by `rfHECp4mtFnc6Y3jTsknjJocCisCVjtjf9` (xrp-arnie13.sbs.xrp-arnie1.com): node 3's lease ended likewise |

So the cluster renewed one node unattended, on schedule, and never renewed the other two.
At 15:20 UTC, when their nineteen moments ran out, their hosts destroyed them — and with them
two of the three signer keys. The status check at 15:30 reached node 1 alone: its last
consensus round was 11265 at 15:20:40, its facts vote that round got one answer out of three,
and its ledger has not advanced since. One node of three can neither close ledgers nor sign
(quorum 2), so `r4bFvWNoA8WNhxiN4Ki6yZvvZreH3Y8NwC` is frozen for good with 11.98 XAH and 1 EVR
in it. Nobody's money: the account had no peers, no channels and no balances, only the float
that was sunk the day the key was retired. Node 1's own renewed lease runs out on 5 September.

Why the other two were not renewed is **not on record**, and that is a defect of this
project's own making: the node keeps only its last sixty diagnostic lines, which by 15:30
covered one minute, and the ledger shows one renewal and then silence. Two mechanisms fit the
facts, neither proven. everpocket's Nomad loop renews one node per housekeeping round, in
cluster order, and retries a failing one until it succeeds, so a renewal that kept failing
for node 2 — its tenant client refuses to prepare a payment to a host the Evernode registry
lists as inactive ("Host is not active."), and a host can be inactive on the registry while
its instances run on — would have held node 3 behind it until both were gone. And the
contract cut its housekeeping phase off after thirty seconds, while a renewal is a multisign
election of up to four ten-second votes plus the tenant client's own ledger queries, so a slow
one may have been abandoned every time it was tried.

Both are gone from the code that came after (the contract now renews each node itself, most
urgent first, one per round, backing off per node, in the submission phase that nothing cuts
short, and keeps its housekeeping history), but that code never ran on this cluster, which
had no upgrade path by design. What this day proves is narrower than the day before: a
cluster renewed one of its leases with nobody watching, and a cluster that fails to renew the
others dies exactly as the design says it will, account and all.

## Day two, evening: a new cluster renews its own leases in its second minute

The code written after the death — the last will and the contract's own renewals — went out
the same evening on a new tenant account, `rKJFVrTc3wcnZfVvDDJcB1qo28VJjvNZgA`, funded by
hand with 10 XAH and 1 EVR. The first attempt (17:30 UTC, three best-ranked hosts) never
formed a mesh — evdevkit's bootstrap handoff from the primary to the other two nodes did not
happen, cost 0.000006 EVR, cause unknown, details in the
[deploy README](../deploy/testnet/README.md#tenth-deployment-1730-utc-4-september-the-mesh-never-formed).
The second (17:50 UTC), on the three hosts of the 3 September cluster, came up at once and did
what cluster 9 could not. Two-moment leases, so every node was due for renewal the moment the
contract read its first lease fact:

| UTC | Ledger | Hash | What it is |
|---|---|---|---|
| ~17:54:04 | — | — | first attempt, node 1: everpocket's `No enough signatures: Total weight: 1, Quorum: 2` after 20 s — the other signers were not in the mesh yet; recorded in the node's diagnostics, retried after the per-node backoff of 20 rounds |
| 17:54:52 | 25,565,969 | `3B0709064FF392D38B3B70A14B1F7B220675316DA6BBC48B2CFBB73F563C02E2` | `Payment` of 0.000024 EVR to `rfW86DFVRKUCc53pKdWTyGFMTfeYNNERhs` (evernode.kimchigraphics.com), `evnExtendLease` for node 1's token `8376DEC2…`, two signers — 24 more moments |
| 17:55:11 | 25,565,974 | `537CE61D0E89307DE21247DEC547D04DF36E4B68FEE7504D76F7EFE418C94AFF` | the same for node 2, `rfHECp4mtFnc6Y3jTsknjJocCisCVjtjf9` (xrp-arnie13.sbs.xrp-arnie1.com), three signers |
| 17:55:21 | 25,565,976 | `10F6C92ACCD530994F12DFFF9CC36656CE21F0D6763D84A165D014840C057344` | the same for node 3, `rLJU57DimMryraUobdL3iiAMhMmHHfCmnf` (zeb-a-nodew-04.xahaud.xyz), three signers |

Three renewals in three consecutive rounds, most urgent first, one per round, 600 drops of fee
each — the shape the [money page](money.md#keeping-the-hosts-paid) describes, on the ledger.
The status check at 17:58 read every node as paid until 19:31 UTC on 5 September, with the
round of its last renewal. The master key of this account is not retired: until the cluster
has renewed all its nodes twice with nobody watching (the next renewals fall due about 17:31
UTC on 5 September), a person can still sweep it.

## What this does and does not prove

It proves that a HotPocket contract running on three Evernode hosts observed the ledger,
verified an off-ledger payment-channel claim, routed an ILP/STREAM payment, produced valid
multisigned Xahau transactions under 2-of-3 consensus, paid for its own hosting from its own
account — four times, the last of them with no one watching — and that no person could sign
for that account after 20:43 UTC on 3 September: no operator process anywhere, no human
signing anything after the cluster was created, and no key left that could.

What it does not prove is that the hosts cannot collude: two of the three could, in
principle, sign outside consensus. That is the custodial risk the design note's §5 and §9
describe, and why the float is pocket money. And it does not yet prove that a cluster keeps
itself alive: the first one did not, and took its account with it; its successor renewed all
three of its leases in its second minute, with the retry that the death taught, and has a day
to show that it does so again with nobody watching.
