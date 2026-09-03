# Deploying the Nomad Connector

Two kits, both driven by PowerShell scripts with `.cmd` launchers in the repository root
(they were written on Windows; every step is a plain `node` or dev-kit command and ports to a
shell script in minutes). Everything a run produces goes under `deploy/<kit>/out/`, which is
git-ignored, as are all key files.

## `deploy/local/` — a 3-node HotPocket cluster on your machine

`run-local-cluster.cmd` builds the contract (`npm run build:local`: ledger disabled, a 10 XAH
dev faucet per peer, 1-second rounds), deploys it to a 3-node `hpdevkit` cluster in Docker
Desktop and runs `demo-real.js`: Alice's plugin connects to node 1, Bob's to node 2, and Alice
pays Bob 1 XAH with the unmodified `ilp-protocol-stream`. Observed on a laptop: STREAM handshake
(ILDCP + rate probes) 9.0 s, the 1 XAH payment 5.8 s, fee 0.0025 XAH, identical state hashes
on all three nodes, clean close. `run-local-ledger.cmd` deploys the `build:local-ledger`
variant instead — the same contract observing the real Xahau ledger, without signer keys — as a
soak test for the bridge; `diag-local.js` reads each node's round diagnostics.

`hpdevkit` needs Docker. It is run straight through `node node_modules/hpdevkit/index.js`
(installed with `--ignore-scripts`, because its `evernode-js-client` dependency otherwise
tries a native build); `hpdevkit deploy` streams node logs forever unless `HP_DEFAULT_NODE=0`.

The manual equivalent, for a local cluster that signs on a real ledger:

```bash
cd contract
cp nomad.config.example.json nomad.config.json   # set connector.masterAddress, xahau.network
npm run build                                    # ncc bundle -> dist/
hpdevkit deploy dist -m -s <master-account-secret>
#   -m: every node gets its own signer key (kept outside consensus state as ../<master>.key)
#   and the SignerList is written to the master account.
```

## `deploy/testnet/` — an Evernode cluster (Xahau mainnet, testnet or devnet)

This is the kit that ran on mainnet on 3 September 2026: `run-mainnet-hosts.cmd`,
`run-mainnet-keys.cmd`, `run-mainnet.cmd`, `run-mainnet-demo.cmd`, `run-mainnet-trace.cmd`,
`run-mainnet-status.cmd`, `run-mainnet-withdraw.cmd` (and `run-testnet.cmd` / `run-devnet.cmd`
for the test networks, where the accounts come from faucets). The full walk-through, the
transcript of the mainnet run and the lessons from the seven deployments that failed before it
are in [deploy/testnet/README.md](testnet/README.md); the on-ledger evidence and the packet trace
are in [docs/proof.md](../docs/proof.md).

Underneath it is plain `evdevkit`:

```bash
export EV_NETWORK=mainnet                  # or testnet / devnet
export EV_TENANT_SECRET=<tenant account secret: it becomes the connector's multisig account>
export EV_USER_PRIVATE_KEY=<from evdevkit keygen>
export EV_HP_OVERRIDE_CFG_PATH=$PWD/contract/hp.cfg.override
node deploy/testnet/hosts.js 12            # reachable, reputable, cheap hosts, spread across operators -> hosts.<net>.txt
cd contract && npm run build:testnet && cd ..
evdevkit cluster-create 3 $PWD/contract/dist /usr/bin/node deploy/testnet/hosts.mainnet.txt -a index.js \
    --signer-count 3 --signer-quorum 0.6 -m 4
```

`--signer-count` generates one signer key per node and installs the SignerList on the tenant
account — the multisig layout `everpocket`'s `XrplContext` expects. `--signer-quorum` is a
fraction of the signers, rounded up (0.6 of 3 = 2-of-3; 0.8 of 3 = 3-of-3). The tenant
account **is** the connector's `masterAddress`; `patch-config.js` writes it into the bundled
`nomad.config.json` before upload.

After the cluster is up: fund the account with XAH (≥ `reserveDrops` + a working float) and
give it an EVR trust line and some EVR (hosts are paid in EVR); peers connect to any node's
user port with `ilp-plugin-hotpocket`, open a payment channel *to* the account and stream
claims. With `nomad` configured, the cluster extends its own leases and replaces dead nodes
from the account (everpocket `NomadContext`). Retiring the tenant's master key
(`SetRegularKey` + `asfDisableMaster`) once the SignerList is in place is what makes the
cluster the only signer; it is deliberately left to a person, because it is irreversible.

## What to watch

* `roundtime` is 3 s. Rounds that touch the ledger (every `xahau.factsEvery` rounds, or when a
  settlement is pending) take 0.6–1.3 s longer because each node queries Xahau and the cluster
  votes over NPL; ILP-only rounds take milliseconds.
* `minExpiryWindowMs` must comfortably exceed two rounds; the configs use 8 s.
* Host choice matters more than host price: probe instance ports before leasing, and spread
  nodes across operators *and* networks — two hosts under different domains can share one IP.
* everpocket is labelled work-in-progress by its authors. Its `transactions.json` bookkeeping
  is written from per-node ledger queries without a vote; the connector's own state accepts
  only voted facts, but a divergence in everpocket's files would still desync a node.
