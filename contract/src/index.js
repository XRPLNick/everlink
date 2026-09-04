'use strict';

// The bundle carries prebuilt native add-ons from several packages and ncc renames them to
// avoid name clashes, so `ws` ends up loading the wrong .node file as `bufferutil` and every
// WebSocket frame longer than 48 bytes throws ("c.mask is not a function") and takes the
// process down. Tell ws to use its JavaScript implementations before anything is required.
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

// HotPocket entry point. HotPocket spawns `node index.js` once per consensus round (and
// once per read request) with the state directory as the working directory; everything
// this process needs to remember is in that directory.
//
// Configuration comes from `everlink.config.json` next to the contract binary (deployed with
// it, so it is part of the consensus state and identical on every node). See
// everlink.config.example.json for the fields.

const fs = require('fs');
const path = require('path');
const HotPocket = require('hotpocket-nodejs-contract');
const { runRound, diagMark } = require('./round');
const { makeConfig } = require('./core/connector');

const CONFIG_FILE = 'everlink.config.json';
const ROUND_WATCHDOG_MS = 120000;

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
  const xahauEnabled = !!(file.xahau && file.xahau.enabled !== false);
  // Without a ledger there is nothing to settle on: a null masterAddress makes the core skip
  // settlement planning entirely (packets still route; balances still track).
  const config = makeConfig({ ...(file.connector || {}), ...(xahauEnabled ? {} : { masterAddress: null }) });
  if (xahauEnabled && !config.masterAddress) throw new Error('connector.masterAddress (the cluster multisig account) is required when xahau is enabled');

  // Per-node diagnostics live next to the signer key, outside the consensus state directory.
  const diagFile = path.join(process.cwd(), '..', 'everlink-diag.json');
  const logger = (...a) => { console.log(new Date().toISOString(), ...a); diagMark(diagFile, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };

  let bridge = null;
  if (xahauEnabled) {
    const { XahauBridge } = require('./adapters/xahau-bridge');
    bridge = new XahauBridge({
      masterAddress: config.masterAddress,
      network: file.xahau.network || 'mainnet',
      rippleServer: file.xahau.rippleServer || null,
      evrIssuer: config.evrIssuer,
      factsEvery: file.xahau.factsEvery || 5,
      nomadEvery: file.xahau.nomadEvery || 10,
      nomad: file.nomad || null,
      momentSec: file.xahau.momentSec || 3600,
      cacheDir: path.dirname(diagFile), // per node, outside consensus state
      logger,
    });
  }

  const rss = () => `${Math.round(process.memoryUsage().rss / 1048576)} MB`;
  diagMark(diagFile, `process up (${process.version}, rss ${rss()}), bridge ${bridge ? 'on' : 'off'}, cwd ${process.cwd()}`);
  // Anything that ends this process abnormally must leave a trace.
  // (Node's default is to die on both; keep that, but write the trace first.)
  process.on('uncaughtException', (e) => { diagMark(diagFile, `UNCAUGHT ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`); process.exit(4); });
  process.on('unhandledRejection', (e) => { diagMark(diagFile, `UNHANDLED REJECTION ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`); process.exit(5); });
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => { diagMark(diagFile, `signal ${sig}`); process.exit(3); });
  process.on('exit', (code) => diagMark(diagFile, `process exit ${code} (rss ${rss()})`));
  const contract = async (ctx) => {
    diagMark(diagFile, `contract called: ${ctx.readonly ? 'readonly' : `consensus lcl ${ctx.lclSeqNo}`}, ${ctx.users.list().length} users, rss ${rss()}`);
    // Watchdog: a round that is still running after this long (a stalled ledger connection,
    // a vote nobody answers) must not block the node forever; give up on it.
    const watchdog = setTimeout(() => { console.error('everlink: round watchdog fired, exiting'); process.exit(2); }, ROUND_WATCHDOG_MS);
    watchdog.unref();
    try {
      await runRound(ctx, {
        stateDir: process.cwd(), config, bridge, diagFile, logger,
      });
    } finally { clearTimeout(watchdog); diagMark(diagFile, `contract returned (${ctx.readonly ? 'readonly' : 'consensus'}), rss ${rss()}`); }
  };

  const hpc = new HotPocket.Contract();
  // forceTerminate: everpocket keeps NPL listeners alive; make sure the process exits.
  const ok = await hpc.init(contract, HotPocket.clientProtocols.json, true);
  diagMark(diagFile, `hpc.init -> ${ok}`);
}

if (process.env.EVERLINK_PROBE === 'layers') {
  // Child process of a {"t":"diag","layers":true} read request: probe and print, never touch HotPocket.
  require('./round').probeLayersInline(process.env.EVERLINK_PROBE_SERVER || 'wss://xahau.network', process.env.EVERLINK_PROBE_MASTER || '')
    .then(() => process.exit(0), (e) => { console.log(`probe failed: ${e && e.message}`); process.exit(1); });
} else {
  main().catch((e) => { console.error('everlink fatal:', e); process.exit(1); });
}
