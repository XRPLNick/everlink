'use strict';

// Convenience: a simulated Nomad Connector cluster wired to a mock Xahau ledger.
// Returns everything a test or demo needs to act as peers of the connector.

const { SimCluster, SimClient, edKeys } = require('./hotpocket-sim');
const { MockXahau } = require('./mock-xahau');
const { MockBridge } = require('./mock-bridge');
const { runRound } = require('../contract/src/round');
const { makeConfig } = require('../contract/src/core/connector');

const MASTER = 'rNomadConnectorMultisigAccount1234'; // the cluster's multisig account (mock)

function createSimConnector({ nodeCount = 3, roundTimeMs = 40, config = {}, factsEvery = 1, leases = true, logger = null } = {}) {
  const cfg = makeConfig({ masterAddress: MASTER, ...config });
  const mock = new MockXahau();
  mock.fund(MASTER, 50_000_000n); // 50 XAH float: covers the reserve and a little liquidity
  mock.fundEvr(MASTER, 30);

  const bridge = new MockBridge(mock, { masterAddress: MASTER, factsEvery });
  const handler = (ctx) => runRound(ctx, { stateDir: ctx.sim.stateDir, config: cfg, bridge, logger });
  const cluster = new SimCluster({ nodeCount, roundTimeMs, handler });

  if (leases) {
    const now = Date.now();
    for (const n of cluster.nodes) mock.addLease(n.publicKey, { host: `rHost${n.index}`, expiresAt: now + 3 * 3600000, evrPerMoment: 2 });
  }

  const peerClient = (keys) => new SimClient(cluster, keys || edKeys());

  return { cluster, mock, bridge, config: cfg, master: MASTER, peerClient };
}

module.exports = { createSimConnector, MASTER };
