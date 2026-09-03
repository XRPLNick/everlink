#!/usr/bin/env node
'use strict';
// Resumes an evdevkit cluster-create that stopped after the nodes were acquired (for example
// when a host's extend-lease acknowledgement timed out). evdevkit keeps the partial cluster in
// <tmp>/evdevkit-cluster/partial-cluster-<md5 of its own argv>.json and can continue with
// --recover, but the flag changes argv, hence the file name it looks for. This wrapper copies
// the newest partial file to the name the recovery run will compute, then runs evdevkit with
// -m 1 (no further extensions: the leases were already extended on-ledger) so it goes straight
// to the signer list and the contract upload.
//   node deploy/testnet/recover-cluster.js <size> <dist> <hostsFile> <quorum> <evrLimit>
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const [size, dist, hostsFile, quorum, evrLimit] = process.argv.slice(2);
const evdk = path.resolve(__dirname, '..', '..', 'node_modules', 'evdevkit', 'index.js');
const tmpDir = path.join(os.tmpdir(), 'evdevkit-cluster');
const partials = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('partial-cluster-')).map((f) => ({ f, t: fs.statSync(path.join(tmpDir, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
if (!partials.length) { console.log('no partial cluster file to recover from'); process.exit(2); }
const src = path.join(tmpDir, partials[0].f);
const nodes = JSON.parse(fs.readFileSync(src, 'utf8'));
console.log(`partial cluster: ${src} (${nodes.length} nodes: ${nodes.map((n) => `${n.host}@${n.domain}:${n.user_port}`).join(', ')})`);
if (nodes.length < Number(size)) console.log(`note: only ${nodes.length} of ${size} nodes were acquired; the rest will be acquired now`);

const args = ['cluster-create', String(size), dist, '/usr/bin/node', hostsFile, '-a', 'index.js', '--signer-count', String(size), '--signer-quorum', String(quorum), '-m', '1', '-e', String(evrLimit), '--recover', '--no-color'];
// evdevkit: md5(process.argv.join()) with argv = [node, script, ...args]
const ref = crypto.createHash('md5').update([process.execPath, evdk, ...args].join()).digest('hex');
const dst = path.join(tmpDir, `partial-cluster-${ref}.json`);
if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
console.log(`recovery cache: ${dst}`);
const r = spawnSync(process.execPath, [evdk, ...args], { stdio: 'inherit', env: process.env });
if (r.status === 0 && fs.existsSync(path.join(dist, 'cluster.json'))) {
  // Done: drop the partial files so a later fresh deploy does not "recover" these nodes again.
  for (const f of [src, dst]) { try { fs.rmSync(f); } catch (e) { /* ignore */ } }
}
process.exit(r.status === null ? 1 : r.status);
