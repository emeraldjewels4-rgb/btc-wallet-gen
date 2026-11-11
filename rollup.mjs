/**
 * Shared pieces for the weekly and monthly treasury roll-ups.
 *
 * Both reports read the same audit log, count each transaction once even though
 * the refill tools write a submitted and a confirmed line, and format wei/sats
 * without floating point. Keeping that here stops the two reports from drifting.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const DAY_MS = 24 * 60 * 60 * 1000;

// Native-asset precision per unit; the audit records wei and sats.
export const DECIMALS = { ETH: 18, BTC: 8 };

export function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatUnits(value, decimals) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = (magnitude % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// Transactions whose timestamp falls in [fromMs, toMs), deduped per tx id.
// Half-open windows mean consecutive periods never double-count a refill.
export function readWindow(auditPath, fromMs, toMs) {
  if (!existsSync(auditPath)) return [];

  const byTx = new Map();
  for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      console.error(`warning: ignoring unreadable audit line in ${auditPath}`);
      continue;
    }
    if (entry.status !== 'submitted' && entry.status !== 'confirmed') continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < fromMs || ts >= toMs) continue;

    const isBitcoin = entry.chain === 'bitcoin';
    const txKey = isBitcoin
      ? `btc:${entry.network}:${entry.txid}`
      : `evm:${entry.chainId}:${entry.txHash}`;

    // Bitcoin records the fee on the submitted line; EVM only learns it from the
    // confirmed receipt, so take it from whichever line carries it.
    const rawFee = isBitcoin ? entry.feeSats : entry.feeWei;
    const fee = rawFee === undefined || rawFee === null ? null : BigInt(rawFee);

    const existing = byTx.get(txKey);
    if (existing) {
      if (existing.fee === null && fee !== null) existing.fee = fee;
      continue;
    }

    byTx.set(txKey, {
      bucketKey: isBitcoin ? `btc:${entry.network}` : `evm:${entry.chainId}`,
      label: isBitcoin
        ? `bitcoin ${entry.network}`
        : `${String(entry.chain ?? `chain ${entry.chainId}`).toLowerCase()} (${entry.chainId})`,
      unit: isBitcoin ? 'BTC' : 'ETH',
      amount: BigInt(isBitcoin ? entry.amountSats : entry.amountWei),
      fee,
      txRef: isBitcoin ? entry.txid : entry.txHash,
    });
  }
  return [...byTx.values()];
}

// bucketKey -> { label, unit, count, total, feeTotal, feeUnknown, largest }
export function summarize(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry.bucketKey) ?? {
      label: entry.label,
      unit: entry.unit,
      count: 0,
      total: 0n,
      feeTotal: 0n,
      feeUnknown: 0,
      largest: { amount: 0n, txRef: null },
    };
    bucket.count += 1;
    bucket.total += entry.amount;
    if (entry.fee === null) bucket.feeUnknown += 1;
    else bucket.feeTotal += entry.fee;
    if (entry.amount > bucket.largest.amount) {
      bucket.largest = { amount: entry.amount, txRef: entry.txRef };
    }
    buckets.set(entry.bucketKey, bucket);
  }
  return buckets;
}

// Fee spend beside the refill total; transactions logged before fee capture
// have no fee, so the caller is told how many are unknown instead of guessing.
export function feeText(bucket) {
  const known = bucket.count - bucket.feeUnknown;
  if (known <= 0) return 'fees not recorded';
  const total = `${formatUnits(bucket.feeTotal, DECIMALS[bucket.unit])} ${bucket.unit}`;
  return bucket.feeUnknown > 0 ? `fees ${total} (${bucket.feeUnknown} unknown)` : `fees ${total}`;
}

// Short transaction reference for report lines, e.g. 0x12345678…abcdef.
export function shortRef(ref) {
  if (!ref) return '';
  return ref.startsWith('0x')
    ? `${ref.slice(0, 10)}…${ref.slice(-6)}`
    : `${ref.slice(0, 8)}…${ref.slice(-6)}`;
}

export function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
