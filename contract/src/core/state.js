'use strict';

// Persisted contract state. HotPocket runs the contract as a fresh process every round
// with the working directory set to the consensus state folder; anything we want to
// keep must be written there. Keys are sorted on write so the file bytes — and hence
// the state hash the cluster votes on — do not depend on object insertion order.

const fs = require('fs');
const path = require('path');
const { initialState, STATE_VERSION } = require('./connector');

const FILE = 'connector-state.json';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function load(stateDir) {
  const file = path.join(stateDir, FILE);
  if (!fs.existsSync(file)) return initialState();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.version !== STATE_VERSION) throw new Error(`unsupported state version ${s.version}`);
  return s;
}

function save(stateDir, state) {
  const file = path.join(stateDir, FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stableStringify(state));
  fs.renameSync(tmp, file);
}

module.exports = { load, save, stableStringify, FILE };
