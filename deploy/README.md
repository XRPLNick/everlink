# Deploying the Nomad Connector

## 0. What has actually been run

`deploy/local/` is the kit that ran on a Windows 10 machine with Docker Desktop 29 and Node 24:
`run-nomad.cmd` → `run.ps1` deploys `contract/dist` (built with `npm run build:local`, ledger
disabled, 10 XAH dev faucet per peer, 1 s rounds) to a 3-node `hpdevkit` cluster and then runs
`demo-real.js`, which connects Alice to node 1 and Bob to node 2 and pays 1 XAH with
`ilp-protocol-stream`. Observed: STREAM handshake (ILDCP + rate probes) 9.0 s, the 1 XAH
payment 5.8 s, fee 0.0025 XAH, identical ledger/state hashes on all nodes, clean close.
Two host-side quirks the kit works around: `npm` on that machine was broken ("Class extends
value undefined"), so hpdevkit is installed with `--ignore-scripts` from the Linux side of
the Cowork bridge and run as `node node_modules/hpdevkit/index.js`; and `hpdevkit deploy`
streams node logs forever unless `HP_DEFAULT_NODE=0`.

Two ways to run the contract as a real HotPocket cluster. Both need Docker on the machine
that runs the dev kits (the cloud workspace this prototype was built in has no Docker daemon,
which is why the repository ships with an in-process simulator instead).

## 1. Local 3-node cluster with hpdevkit (no Evernode, no real Xahau)

```bash
npm i -g hpdevkit                     # needs Docker
cd contract
cp nomad.config.example.json nomad.config.json
#   set connector.masterAddress to a Xahau testnet account you control
#   set xahau.network to "testnet" (or xahau.enabled=false to run without any ledger)
npm run build                         # ncc bundle -> dist/index.js + hp.cfg.override + nomad.config.json
hpdevkit deploy dist -m -s <master-account-secret>
#   -m sets up multisigning: every node gets its own signer key (stored outside consensus
#   state as ../<master>.key) and the SignerList is written to the master account.
hpdevkit logs 1                       # follow node 1
hpdevkit stop
```

With `xahau.enabled=false` the contract routes ILP packets and keeps balances, but nothing is
settled on a ledger (claims are rejected as "channel not observed"). That mode is handy to
exercise the packet path with `ilp-plugin-hotpocket` against `wss://localhost:8081`.

## 2. Evernode cluster with evdevkit (Xahau mainnet or testnet)

```bash
npm i -g evdevkit
export EV_NETWORK=testnet             # or mainnet
export EV_TENANT_SECRET=<tenant account secret, funded with EVR>
export EV_USER_PRIVATE_KEY=$(evdevkit keygen | grep -i private | awk '{print $NF}')
export EV_HP_OVERRIDE_CFG_PATH=$PWD/contract/hp.cfg.override

evdevkit list -l 20 > hosts.txt        # pick hosts; the file is the preferred-hosts list
cd contract && npm run build && cd ..
evdevkit cluster-create 5 $PWD/contract/dist /usr/bin/node hosts.txt -a index.js \
    --signer-count 5 --signer-quorum 0.8 -l rand --min-life 4 --max-life 12
```

`cluster-create --signer-count` generates a signer per node and configures the tenant
account's SignerList, exactly the multisig layout `everpocket`'s `XrplContext` expects. The
tenant account **is** the connector's `masterAddress`: put it in `nomad.config.json` before
building.

After the cluster is up:

1. Fund the master account with XAH (≥ `reserveDrops` + working float) and set an EVR trust
   line + some EVR (hosts are paid in EVR; the treasury tops up from the Xahau DEX later).
2. Peers connect to any node's user port with `ilp-plugin-hotpocket`, open a payment
   channel **to** the master account, and stream claims.
3. With `nomad` configured in `nomad.config.json`, the cluster extends its own leases and
   replaces failed nodes from the master account (everpocket `NomadContext`). Remove the
   tenant's master key from the account (`SetRegularKey` + disable master, or simply never
   keep the seed) once the SignerList is in place — otherwise a person still "controls" it.

## What to watch

* `roundtime` in `hp.cfg.override` is 3 s. Rounds that touch the ledger (every
  `xahau.factsEvery` rounds, or whenever a settlement is pending) take longer because each
  node queries Xahau and the cluster votes over NPL; ILP-only rounds are fast.
* `minExpiryWindowMs` must comfortably exceed two rounds; the example config uses 8 s.
* everpocket is labelled work-in-progress by its authors. Its `transactions.json` bookkeeping
  is written from per-node ledger queries without a vote; the connector's own state only
  accepts voted facts, but a divergence in everpocket's files would still desync a node.
