'use strict';

// All value in the connector is integer "drops" (1 XAH = 1_000_000 drops), carried as
// BigInt inside a round and as decimal strings in persisted state. Never use Number
// for money: ILP amounts are uint64 and JS Numbers lose precision above 2^53.

const MAX_UINT64 = (1n << 64n) - 1n;

function toBig(v, name = 'amount') {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name}: not a safe non-negative integer`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v)) {
    const b = BigInt(v);
    if (b > MAX_UINT64) throw new Error(`${name}: exceeds uint64`);
    return b;
  }
  throw new Error(`${name}: invalid amount ${JSON.stringify(v)}`);
}

function str(b) {
  return toBig(b).toString(10);
}

// Signed variants for peer balances, which may dip slightly below zero (probe credit).
function toSigned(v, name = 'balance') {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^-?[0-9]{1,20}$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`${name}: invalid signed amount ${JSON.stringify(v)}`);
}
function sstr(b) {
  return toSigned(b).toString(10);
}

function max(a, b) { return a > b ? a : b; }
function min(a, b) { return a < b ? a : b; }

// ceil(amount * bps / 10000)
function bpsOf(amount, bps) {
  const a = toBig(amount);
  const n = a * BigInt(bps);
  return (n + 9999n) / 10000n;
}

module.exports = { toBig, str, toSigned, sstr, max, min, bpsOf, MAX_UINT64 };
