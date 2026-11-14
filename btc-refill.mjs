#!/usr/bin/env node
/**
 * Treasury refill bot for Bitcoin.
 *
 * Tops up one target address from a treasury WIF key you control when the target
 * balance falls below a threshold. It spends only your own confirmed UTXOs; it
 * cannot create funds.
 *
 * Safety model, matching refill.mjs:
 *   - DRY RUN by default: nothing is signed or broadcast without --live.
 *   - --live requires explicit --max-per-refill and --total-budget caps.
 *   - Refuses on cap/budget breach, insufficient confirmed UTXOs, an address that
 *     is invalid for the selected network, a WIF for the wrong network, an
 *     uncompressed WIF, or a send to the treasury itself.
 *   - Every signature is verified locally against the input script before the
 *     transaction is broadcast.
 *   - Refuses when the audit log contradicts the spend anchor beside it, so a
 *     deleted or truncated log cannot hand the budget back.
 *   - The WIF is read from BTC_TREASURY_WIF and is never printed, logged or
 *     written to the audit file.
 *
 * Usage:
 *   node --env-file=.env btc-refill.mjs --to bc1q... --amount 0.0005 \
 *     --threshold 0.001 --max-per-refill 0.0006 --total-budget 0.0012
 *   add --live to broadcast. See --help.
 */

import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { decode as decodeWif } from 'wif';
import { createSlackNotifier, resolveSlackWebhooks } from './notify.mjs';
import { appendAuditLine, takeRunLock } from './run-lock.mjs';
import { checkAnchor } from './spend-anchor.mjs';

const ECPair = ECPairFactory(ecc);

const NETWORKS = {
  mainnet: { network: bitcoin.networks.bitcoin, wif: 0x80, api: 'https://mempool.space/api' },
  testnet: { network: bitcoin.networks.testnet, wif: 0xef, api: 'https://mempool.space/testnet/api' },
  regtest: { network: bitcoin.networks.regtest, wif: 0xef, api: null },
};

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const EXIT_REFUSED = 3;
const DUST = 546n; // conservative P2WPKH dust floor; leftovers below it go to miners

// Human names for the safety rules, used in refusal alerts and logs.
const RULE_LABELS = {
  cap: 'per-refill cap',
  budget: 'total spend budget',
  'treasury-low': 'confirmed treasury balance',
  'audit-mismatch': 'spend anchor vs audit log',
};

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function describe(err) {
  return err?.message ?? String(err);
}

// How much of a limit a request represents, as a whole percentage.
function percentOf(part, whole) {
  return whole === 0n ? 0n : (part * 100n) / whole;
}

function usage() {
  console.log(`Usage: node btc-refill.mjs --to ADDRESS --amount BTC [options]

Required:
  --to ADDRESS          target wallet to top up (an address you control)
  --amount BTC          value sent per refill, e.g. 0.0005

Options:
  --threshold BTC       refill only when the target holds less than this (default 0)
  --network NAME        mainnet | testnet | regtest (default mainnet)
  --max-per-refill BTC  hard cap for one refill (required with --live)
  --total-budget BTC    hard cap on total sent per network (required with --live)
  --fee-rate SATVB      sat/vB; otherwise fetched from the fee API
  --api URL             mempool.space-compatible endpoint (required for regtest)
  --min-treasury BTC    Slack alert when the treasury drops below this floor
  --alert-cooldown SEC  seconds between identical alerts (default 900)
  --audit PATH          audit log path (default ${AUDIT_DEFAULT}); a lock at
                        PATH.lock keeps a second run from overlapping this one,
                        and PATH.state.json anchors the spend total
  --watch SECONDS       poll every SECONDS instead of running once
  --live                actually sign and broadcast (otherwise dry run)
  -h, --help            show this help

Environment:
  BTC_TREASURY_WIF      compressed WIF of the funding wallet (required)
  BTC_MAX_REFILL        default for --max-per-refill
  BTC_TOTAL_BUDGET      default for --total-budget
  BTC_API               default for --api
  BTC_FEE_RATE          default for --fee-rate
  MIN_TREASURY_BTC      default for --min-treasury
  ALERT_COOLDOWN_SECONDS default for --alert-cooldown
  SLACK_WEBHOOK_URL     Slack incoming webhook; alerts are disabled without it
  SLACK_ALERT_WEBHOOK_URL   webhook for refusals (default: SLACK_WEBHOOK_URL)
  SLACK_WARNING_WEBHOOK_URL webhook for low-treasury alerts (default: SLACK_WEBHOOK_URL)
  SLACK_*_WEBHOOK_FILE  read that webhook URL from a file instead, e.g.
                        SLACK_WEBHOOK_FILE=/path/to/webhook

Exit codes: 0 ok/no action, 1 usage or config error, 2 runtime error,
            3 refused by a safety rule, 4 another run holds the lock.`);
}

function parseBtcArg(name, raw, { allowZero = false } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim();
  const match = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) fail(`${name} must be a decimal bitcoin amount like 0.0005 (got "${raw}")`);
  const sats = BigInt(match[1]) * 100000000n + BigInt((match[2] ?? '').padEnd(8, '0'));
  if (!allowZero && sats === 0n) fail(`${name} must be greater than zero`);
  return sats;
}

function satsToBtc(sats) {
  const whole = sats / 100000000n;
  const frac = (sats % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function parseArgs(argv) {
  const opts = {
    to: null,
    amountRaw: null,
    thresholdRaw: null,
    networkName: 'mainnet',
    maxPerRefillRaw: process.env.BTC_MAX_REFILL ?? null,
    totalBudgetRaw: process.env.BTC_TOTAL_BUDGET ?? null,
    feeRateRaw: process.env.BTC_FEE_RATE ?? null,
    api: process.env.BTC_API ?? null,
    minTreasuryRaw: process.env.MIN_TREASURY_BTC ?? null,
    alertCooldownRaw: process.env.ALERT_COOLDOWN_SECONDS ?? null,
    audit: AUDIT_DEFAULT,
    watch: 0,
    live: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--to') {
      opts.to = next();
    } else if (arg === '--amount') {
      opts.amountRaw = next();
    } else if (arg === '--threshold') {
      opts.thresholdRaw = next();
    } else if (arg === '--network') {
      opts.networkName = next();
    } else if (arg === '--max-per-refill') {
      opts.maxPerRefillRaw = next();
    } else if (arg === '--total-budget') {
      opts.totalBudgetRaw = next();
    } else if (arg === '--fee-rate') {
      opts.feeRateRaw = next();
    } else if (arg === '--api') {
      opts.api = next();
    } else if (arg === '--audit') {
      opts.audit = next();
    } else if (arg === '--min-treasury') {
      opts.minTreasuryRaw = next();
    } else if (arg === '--alert-cooldown') {
      opts.alertCooldownRaw = next();
    } else if (arg === '--watch') {
      const raw = next();
      const seconds = Number(raw);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400) {
        fail(`--watch expects whole seconds between 5 and 86400, got "${raw}"`);
      }
      opts.watch = seconds;
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

// Total value already sent on this network, counted once per txid.
function readSpent(auditPath, networkName) {
  if (!existsSync(auditPath)) return 0n;
  const byTx = new Map();
  for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.chain !== 'bitcoin' || entry.network !== networkName) continue;
      if (entry.status !== 'submitted' && entry.status !== 'confirmed') continue;
      byTx.set(entry.txid, BigInt(entry.amountSats));
    } catch {
      console.error(`warning: ignoring unreadable audit line in ${auditPath}`);
    }
  }
  let total = 0n;
  for (const amount of byTx.values()) total += amount;
  return total;
}

async function request(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} -> HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

async function getJson(url) {
  return (await request(url)).json();
}

function estimateVsize(inputCount, outputCount) {
  // P2WPKH: ~68 vB per input, 31 vB per output, ~11 vB overhead.
  return 11 + 68 * inputCount + 31 * outputCount;
}

function selectInputs(utxos, amount, feeRate, outputCount) {
  const sorted = [...utxos].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  let sum = 0n;
  for (let i = 0; i < sorted.length; i += 1) {
    sum += BigInt(sorted[i].value);
    const fee = BigInt(estimateVsize(i + 1, outputCount)) * feeRate;
    if (sum >= amount + fee) return { inputs: sorted.slice(0, i + 1), sum, fee };
  }
  return null;
}

function planTransaction(utxos, amount, feeRate) {
  const withChange = selectInputs(utxos, amount, feeRate, 2);
  if (withChange) {
    const change = withChange.sum - amount - withChange.fee;
    if (change >= DUST) return { ...withChange, change };
    // Change would be dust: drop it and let the leftover go to miners.
    return { inputs: withChange.inputs, sum: withChange.sum, fee: withChange.sum - amount, change: 0n };
  }
  const noChange = selectInputs(utxos, amount, feeRate, 1);
  if (noChange) return { inputs: noChange.inputs, sum: noChange.sum, fee: noChange.sum - amount, change: 0n };
  return null;
}

// BIP-143: a P2WPKH input commits to the P2PKH scriptCode of its key and to the
// spent value, not to the version-0 witness program stored in the UTXO. The
// self-check below must hash the same scriptCode the signer used.

// Verify every input signature locally before anything leaves the machine.
function verifySignatures(tx, planned, treasury, network) {
  for (let i = 0; i < planned.inputs.length; i += 1) {
    const witness = tx.ins[i].witness;
    if (!witness || witness.length !== 2) return `input ${i}: expected a P2WPKH witness, got ${witness?.length ?? 0} items`;
    const [signatureWithType, pubkey] = witness;

    let decoded;
    try {
      decoded = bitcoin.script.signature.decode(signatureWithType);
    } catch {
      return `input ${i}: malformed signature`;
    }

    const value = BigInt(planned.inputs[i].value);
    const hash = tx.hashForWitnessV0(i, treasury.scriptCode, value, decoded.hashType);
    let valid = false;
    try {
      // script.signature.decode returns the 64-byte compact form tiny-secp256k1 wants.
      valid = ecc.verify(hash, pubkey, Buffer.from(decoded.signature));
    } catch (err) {
      return `input ${i}: signature check failed (${describe(err)})`;
    }
    if (!valid) return `input ${i}: invalid signature`;
    const expectedScript = Buffer.from(bitcoin.payments.p2wpkh({ pubkey, network }).output);
    if (!expectedScript.equals(treasury.script)) {
      return `input ${i}: witness pubkey does not belong to the treasury`;
    }
  }
  return null;
}

function buildSignedTransaction(planned, treasury, to, amount, network) {
  const psbt = new bitcoin.Psbt({ network });
  for (const utxo of planned.inputs) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: treasury.script, value: BigInt(utxo.value) },
    });
  }
  psbt.addOutput({ address: to, value: amount });
  if (planned.change > 0n) psbt.addOutput({ address: treasury.address, value: planned.change });
  psbt.signAllInputs(treasury.keyPair);
  psbt.finalizeAllInputs();
  return psbt.extractTransaction();
}

function parseCooldown(raw) {
  if (raw === null || raw === undefined || raw === '') return 900;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
    fail(`--alert-cooldown expects whole seconds between 0 and 86400, got "${raw}"`);
  }
  return seconds;
}

// Log a safety-rule refusal and mirror it to Slack (never with key material).
// `figures` spells out the numbers behind the rule that fired - the limit, what
// was already spent, what this refill asked for, and the overage - so the alert
// says which rule was hit and by how much, not just that something was refused.
async function refuse(ctx, key, reason, figures = null) {
  const label = RULE_LABELS[key] ?? key;
  log(`REFUSING: ${reason} [rule ${key} (${label})${figures ? `: ${figures}` : ''}]`);
  if (ctx.notifier.enabled) {
    const lines = [
      `:rotating_light: *refill refused (high)* - bitcoin ${ctx.networkName}`,
      reason,
    ];
    if (figures) lines.push(figures);
    lines.push(
      `target ${ctx.to} | treasury ${ctx.treasury.address}`,
      `mode ${ctx.dryRun ? 'DRY RUN' : 'LIVE'} | severity high | rule ${key} (${label})`,
    );
    await ctx.notifier.alert(`refused:${ctx.networkName}:${key}`, lines.join('\n'));
  }
  return 'refused';
}

async function tick(ctx) {
  const { api, to, amount, threshold, maxPerRefill, totalBudget, feeRate, dryRun, auditPath, networkName, treasury, network, minTreasury, notifier } = ctx;

  // Same ledger guard as the EVM tool: an audit log that shrank, or one that is
  // gone entirely, must not hand the budget back.
  const spent = readSpent(auditPath, networkName);
  const verdict = checkAnchor({
    auditPath,
    chainKey: networkName,
    spent,
    label: networkName,
    unit: 'BTC',
    format: satsToBtc,
  });
  if (verdict.status !== 'ok') return refuse(ctx, 'audit-mismatch', verdict.reason, verdict.figures);

  const targetUtxos = await getJson(`${api}/address/${to}/utxo`);
  const targetBalance = targetUtxos
    .filter((utxo) => utxo.status?.confirmed)
    .reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);

  log(`${networkName}: target ${to} holds ${satsToBtc(targetBalance)} BTC, threshold ${satsToBtc(threshold)} BTC`);
  if (targetBalance >= threshold) {
    log('above threshold, nothing to do');
    return 'idle';
  }

  if (maxPerRefill !== null && amount > maxPerRefill) {
    return refuse(
      ctx,
      'cap',
      `refill ${satsToBtc(amount)} BTC exceeds the per-refill cap ${satsToBtc(maxPerRefill)} BTC`,
      `limit ${satsToBtc(maxPerRefill)} BTC | requested ${satsToBtc(amount)} BTC | ` +
        `over by ${satsToBtc(amount - maxPerRefill)} BTC ` +
        `(${percentOf(amount, maxPerRefill)}% of the cap)`,
    );
  }

  if (totalBudget !== null && spent + amount > totalBudget) {
    const remaining = spent < totalBudget ? totalBudget - spent : 0n;
    return refuse(
      ctx,
      'budget',
      `budget on ${networkName} is spent - sent ${satsToBtc(spent)} BTC of ` +
        `${satsToBtc(totalBudget)} BTC, this refill needs ${satsToBtc(amount)} BTC`,
      `limit ${satsToBtc(totalBudget)} BTC | spent ${satsToBtc(spent)} BTC | ` +
        `remaining ${satsToBtc(remaining)} BTC | requested ${satsToBtc(amount)} BTC | ` +
        `over by ${satsToBtc(spent + amount - totalBudget)} BTC`,
    );
  }

  const treasuryUtxos = (await getJson(`${api}/address/${treasury.address}/utxo`)).filter(
    (utxo) => utxo.status?.confirmed,
  );
  const available = treasuryUtxos.reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);

  if (minTreasury !== null && available < minTreasury) {
    await notifier.alert(
      `low:${networkName}`,
      [
        `:warning: *treasury low (medium)* - bitcoin ${networkName}`,
        `treasury ${treasury.address} holds ${satsToBtc(available)} BTC in confirmed UTXOs, below the ${satsToBtc(minTreasury)} BTC floor`,
        `target ${to}`,
        `mode ${dryRun ? 'DRY RUN' : 'LIVE'} | severity medium`,
      ].join('\n'),
    );
  }

  const planned = planTransaction(treasuryUtxos, amount, feeRate);

  if (!planned) {
    // Cost the shortfall as if every confirmed UTXO were spent, so the fee estimate
    // is an upper bound and the reported gap is never understated.
    const estimatedFee = BigInt(estimateVsize(treasuryUtxos.length, 2)) * feeRate;
    const needed = amount + estimatedFee;
    const shortfall = needed > available ? needed - available : 0n;
    return refuse(
      ctx,
      'treasury-low',
      `treasury ${treasury.address} has ${satsToBtc(available)} BTC in confirmed UTXOs, ` +
        `which cannot cover ${satsToBtc(amount)} BTC plus fees`,
      `needs about ${satsToBtc(needed)} BTC (${satsToBtc(amount)} + fee ${estimatedFee} sats ` +
        `at ${feeRate} sat/vB) | treasury holds ${satsToBtc(available)} BTC | ` +
        `short by about ${satsToBtc(shortfall)} BTC`,
    );
  }

  const planLines = [
    `  send      ${satsToBtc(amount)} BTC -> ${to} on ${networkName}`,
    `  inputs    ${planned.inputs.length} UTXO(s), ${satsToBtc(planned.sum)} BTC in`,
    `  fee       ${planned.fee} sats (${feeRate} sat/vB, ~${estimateVsize(planned.inputs.length, planned.change > 0n ? 2 : 1)} vB)`,
    `  change    ${planned.change > 0n ? `${satsToBtc(planned.change)} BTC back to treasury` : 'none (below dust, left to miners)'}`,
    `  caps      per-refill ${maxPerRefill === null ? 'none' : `${satsToBtc(maxPerRefill)} BTC`}, ` +
      `budget ${totalBudget === null ? 'none' : `${satsToBtc(totalBudget)} BTC (spent ${satsToBtc(spent ?? 0n)} BTC)`}`,
  ];

  if (dryRun) {
    log('DRY RUN - nothing signed or broadcast. Plan:');
    for (const line of planLines) console.log(line);
    log('dry run complete - add --live to broadcast');
    return 'dry-run';
  }

  const tx = buildSignedTransaction(planned, treasury, to, amount, network);

  const signatureProblem = verifySignatures(tx, planned, treasury, network);
  if (signatureProblem) {
    // A failed self-check is a bug, not a policy refusal: stop with exit code 2.
    throw new Error(`local signature verification failed - ${signatureProblem}`);
  }

  for (const line of planLines) console.log(line);
  const hex = tx.toHex();
  const txid = tx.getId();
  const res = await request(`${api}/tx`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: hex,
  });
  const accepted = (await res.text()).trim();
  if (accepted !== txid) throw new Error(`broadcast endpoint returned "${accepted}" instead of ${txid}`);

  appendAudit(auditPath, {
    ts: new Date().toISOString(),
    chain: 'bitcoin',
    network: networkName,
    from: treasury.address,
    to,
    amountSats: amount.toString(),
    feeSats: planned.fee.toString(),
    feeRate: feeRate.toString(),
    inputs: planned.inputs.length,
    txid,
    status: 'submitted',
  });

  const explorer = networkName === 'mainnet' ? 'https://mempool.space/tx' : `https://mempool.space/${networkName}/tx`;
  const explorerLink = networkName === 'regtest' ? '' : ` (${explorer}/${txid})`;
  log(`broadcast ${txid}${explorerLink}`);

  if (notifier.enabled) {
    await notifier.alert(
      `sent:bitcoin:${networkName}:${txid}`,
      [
        `:white_check_mark: *refill sent* - bitcoin ${networkName}`,
        `${satsToBtc(amount)} BTC -> ${to}`,
        `tx ${txid}${explorerLink}`,
      ].join('\n'),
    );
  }

  return 'sent';
}

// Written under a mutex and fsynced by run-lock.mjs, so two processes cannot
// interleave halves of an entry.
function appendAudit(auditPath, entry) {
  appendAuditLine(auditPath, entry, { log });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.to) fail('--to is required');
  if (!opts.amountRaw) fail('--amount is required');
  const amount = parseBtcArg('--amount', opts.amountRaw);
  const threshold = parseBtcArg('--threshold', opts.thresholdRaw, { allowZero: true }) ?? 0n;
  const maxPerRefill = parseBtcArg('--max-per-refill', opts.maxPerRefillRaw);
  const totalBudget = parseBtcArg('--total-budget', opts.totalBudgetRaw);
  const minTreasury = parseBtcArg('--min-treasury', opts.minTreasuryRaw);

  const networkName = String(opts.networkName).toLowerCase();
  const net = NETWORKS[networkName];
  if (!net) fail(`unsupported network "${opts.networkName}" (use mainnet, testnet or regtest)`);

  let api = opts.api ?? net.api;
  if (!api) fail('regtest needs an explicit --api (mempool.space-compatible endpoint)');
  try {
    const parsed = new URL(api);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    api = api.replace(/\/+$/, '');
  } catch {
    fail('--api must be an http(s) URL');
  }

  let feeRate;
  if (opts.feeRateRaw === null) {
    try {
      const fees = await getJson(`${api}/v1/fees/recommended`);
      const chosen = fees.halfHourFee ?? fees.fastestFee ?? fees.hourFee;
      if (!Number.isInteger(chosen) || chosen < 1) throw new Error('fee API returned no usable rate');
      feeRate = BigInt(chosen);
      log(`fee rate ${feeRate} sat/vB (half-hour target, from ${new URL(api).host})`);
    } catch (err) {
      fail(`could not fetch a fee rate: ${describe(err)} - pass --fee-rate to set one`, 2);
    }
  } else {
    const parsed = Number(opts.feeRateRaw);
    if (!Number.isInteger(parsed) || parsed < 1) fail(`--fee-rate expects a whole number of sat/vB, got "${opts.feeRateRaw}"`);
    feeRate = BigInt(parsed);
  }

  const rawWif = (process.env.BTC_TREASURY_WIF ?? '').trim();
  if (!rawWif) {
    fail('BTC_TREASURY_WIF is not set - put it in a git-ignored .env and run: node --env-file=.env btc-refill.mjs ...');
  }

  let decoded;
  try {
    decoded = decodeWif(rawWif);
  } catch {
    fail('BTC_TREASURY_WIF is not a valid WIF key');
  }
  if (decoded.version !== net.wif) {
    fail(`BTC_TREASURY_WIF belongs to a different network (WIF version ${decoded.version}, ${networkName} expects ${net.wif})`);
  }
  if (!decoded.compressed) fail('BTC_TREASURY_WIF is uncompressed; use the compressed WIF for a P2WPKH treasury');

  const keyPair = ECPair.fromPrivateKey(Buffer.from(decoded.privateKey), { network: net.network });
  const payment = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net.network });
  const treasury = {
    keyPair,
    address: payment.address,
    script: payment.output,
    scriptCode: bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: net.network }).output,
  };

  let to;
  try {
    to = bitcoin.address.fromOutputScript(bitcoin.address.toOutputScript(opts.to, net.network), net.network);
  } catch {
    fail(`--to is not a valid ${networkName} address (got "${opts.to}")`);
  }
  if (to === treasury.address) fail('--to cannot be the treasury address itself');
  if (opts.live && (maxPerRefill === null || totalBudget === null)) {
    fail('--live needs explicit caps: pass --max-per-refill and --total-budget (or set BTC_MAX_REFILL and BTC_TOTAL_BUDGET)');
  }
  if (maxPerRefill !== null && amount > maxPerRefill) {
    fail(`--amount ${satsToBtc(amount)} BTC is already above --max-per-refill ${satsToBtc(maxPerRefill)} BTC`);
  }
  if (totalBudget !== null && amount > totalBudget) {
    fail(`--amount ${satsToBtc(amount)} BTC is already above --total-budget ${satsToBtc(totalBudget)} BTC`);
  }

  // One run per audit log at a time, shared with the EVM tools: a scheduled run
  // and a manual run would otherwise race for the same UTXO set. Released on exit.
  takeRunLock(opts.audit, { tool: 'btc-refill.mjs', log });

  const notifier = createSlackNotifier({
    ...resolveSlackWebhooks(),
    cooldownMs: parseCooldown(opts.alertCooldownRaw) * 1000,
    log,
  });

  log(`treasury ${treasury.address}, network ${networkName}, api ${new URL(api).host}, mode ${opts.live ? 'LIVE' : 'DRY RUN'}`);
  log(notifier.describe());

  const ctx = {
    api,
    to,
    amount,
    threshold,
    maxPerRefill,
    totalBudget,
    feeRate,
    dryRun: !opts.live,
    auditPath: opts.audit,
    networkName,
    treasury,
    network: net.network,
    minTreasury,
    notifier,
  };

  if (opts.watch > 0) {
    log(`watching every ${opts.watch}s - press Ctrl+C to stop`);
    for (;;) {
      try {
        await tick(ctx);
      } catch (err) {
        log(`error: ${describe(err)}`);
      }
      await sleep(opts.watch * 1000);
    }
  }

  let result;
  try {
    result = await tick(ctx);
  } catch (err) {
    fail(describe(err), 2);
  }
  process.exitCode = result === 'refused' ? EXIT_REFUSED : 0;
}

main().catch((err) => fail(describe(err), 2));
