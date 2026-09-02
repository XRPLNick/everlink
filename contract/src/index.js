'use strict';

// HotPocket entry point. HotPocket spawns `node index.js` once per consensus round (and
// once per read request) with the state directory as the working directory; everything
// this process needs to remember is in that directory.
//
// Configuration comes from `nomad.config.json` next to the contract binary (deployed with
// it, so it is part of the consensus state and identical on every node). See
// nomad.config.example.json for the fields.

const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-nodejs-contract');
const { runRound } = require('./round');
const { makeConfig } = require('./core/connector');

const CONFIG_FILE = 'nomad.config.json';

function loadConfig() {
  // Look next to the binary first (deployed alongside index.js), then in the state dir.
  const candidates = [path.join(__dirname, CONFIG_FILE), path.join(process.cwd(), '..', CONFIG_FILE), path.join(process.cwd(), CONFIG_FILE)];
  for (const f of candidates) {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  throw new Error(`${CONFIG_FILE} not found (looked in ${candidates.join(', ')})`);
}

async function main() {
  const file = loadConfig();
  const config = makeConfig(file.connector || {});
  if (!config.masterAddress) throw new Error('connector.masterAddress (the cluster multisig account) is required');

  let bridge = null;
  if (file.xahau && file.xahau.enabled !== false) {
    const { XahauBridge } = require('./adapters/xahau-bridge');
    bridge = new XahauBridge({
      masterAddress: config.masterAddress,
      network: file.xahau.network || 'mainnet',
      rippleServer: file.xahau.rippleServer || null,
      evrIssuer: config.evrIssuer,
      factsEvery: file.xahau.factsEvery || 5,
      nomad: file.nomad || null,
      logger: (...a) => console.log(new Date().toISOString(), ...a),
    });
  }

  const contract = async (ctx) => {
    await runRound(ctx, {
      stateDir: process.cwd(), config, bridge,
      logger: (...a) => console.log(new Date().toISOString(), ...a),
    });
  };

  const hpc = new HotPocket.Contract();
  // forceTerminate: everpocket keeps NPL listeners alive; make sure the process exits.
  await hpc.init(contract, HotPocket.clientProtocols.json, true);
}

main().catch((e) => { console.error('nomad-connector fatal:', e); process.exit(1); });
