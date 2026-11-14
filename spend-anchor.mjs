#!/usr/bin/env node
/**
 * The spend anchor, shared by every tool that spends from a local audit log.
 *
 * The audit log is the ledger, but a missing log reads as zero spent: delete
 * that one file and the whole budget comes back. The anchor sits beside the log
 * (`<audit>.state.json`) and records the highest total ever seen per chain, so
 * the log may grow but cannot shrink unnoticed.
 *
 * The file is `{ "chains": { "1": "9000000000000000" } }`: decimal totals in the
 * smallest unit of that ledger - wei for EVM, sats for Bitcoin. It holds no
 * address, key or URL, so it is safe to inspect and share.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// Returns chain key -> total. Throws with a readable reason when the file is not
// usable, so a corrupt anchor and a missing log are refused the same way.
function readAnchor(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || parsed.chains === null || typeof parsed.chains !== 'object') {
    throw new Error('it is not a spend anchor');
  }
  return Object.fromEntries(Object.entries(parsed.chains).map(([chainKey, total]) => [chainKey, BigInt(total)]));
}

// Written small and atomically, so a half-written anchor can never be mistaken
// for a smaller spend total.
function writeAnchor(path, chains) {
  const tmp = `${path}.tmp`;
  const body = {
    chains: Object.fromEntries(Object.entries(chains).map(([chainKey, total]) => [chainKey, total.toString()])),
  };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
}

function describe(err) {
  return err?.message ?? String(err);
}

// Compare the log's total against the anchor, moving the anchor up when the log
// grew.
//
// Returns `{ status: 'ok' }` when the two agree, otherwise a refusal for the
// caller to report through its own machinery: `mismatch` when the log accounts
// for less than the anchor remembers, `unreadable` when the anchor cannot be
// used at all. A failed write is thrown, because the anchor is what keeps the
// next run safe.
export function checkAnchor({ auditPath, chainKey, spent, label, unit, format }) {
  const path = `${auditPath}.state.json`;

  let chains;
  try {
    chains = readAnchor(path);
  } catch (err) {
    return {
      status: 'unreadable',
      reason:
        `the budget anchor ${path} cannot be used (${describe(err)}) - ` +
        `restore it, or delete it to re-anchor from ${auditPath}`,
      figures: `anchor ${path} | log ${auditPath}`,
    };
  }

  const anchored = chains[String(chainKey)] ?? null;
  if (anchored !== null && anchored > spent) {
    return {
      status: 'mismatch',
      reason:
        `the budget anchor ${path} records ${format(anchored)} ${unit} spent on ${label}, ` +
        `but ${auditPath} accounts for only ${format(spent)} ${unit} - a deleted, truncated ` +
        'or replaced log does not hand the budget back',
      figures:
        `anchor ${format(anchored)} ${unit} | log ${format(spent)} ${unit} | ` +
        `missing ${format(anchored - spent)} ${unit}`,
    };
  }

  if (anchored === null || anchored < spent) {
    chains[String(chainKey)] = spent;
    try {
      writeAnchor(path, chains);
    } catch (err) {
      throw new Error(`could not write the budget anchor ${path}: ${describe(err)}`);
    }
  }

  return { status: 'ok' };
}
