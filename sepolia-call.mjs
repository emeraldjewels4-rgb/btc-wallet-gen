#!/usr/bin/env node
/**
 * Sepolia-only calldata sender.
 *
 * Sends one transaction carrying an arbitrary 0x payload to a target address on
 * Sepolia (chain 11155111). It exists so contract calls and calldata handling can
 * be rehearsed with throwaway funds; it refuses every other chain.
 *
 * Safety model:
 *   - DRY RUN by default: nothing is signed or broadcast without --live.
 *   - --live requires explicit --max-per-refill and --total-budget caps.
 *   - --max-per-refill caps value + worst-case gas for this transaction.
 *   - --total-budget caps value + fees already recorded on Sepolia in the
 *     calldata audit log, plus this transaction's worst-case cost.
 *   - refuses a non-Sepolia RPC, calldata over MAX_DATA_BYTES, a call whose gas
 *     cannot be estimated without --gas-limit, the zero address, and the
 *     treasury's own address.
 *   - the key comes from TREASURY_PRIVATE_KEY and is never printed, logged, or
 *     written to the audit file.
 *   - the payload is audited as keccak256 hash + byte length, never stored raw.
 *
 * Usage:
 *   node --env-file=.env sepolia-call.mjs --to 0xTARGET --data 0xdeadbeef \
 *     --value 0.001 --max-per-refill 0.01 --total-budget 0.05
 *   add --live to send. See --help.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createSlackNotifier, resolveSlackWebhooks } from './notify.mjs';
import { appendAuditLine, takeRunLock } from './run-lock.mjs';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const CHAIN = sepolia;
const CHAIN_ID = sepolia.id; // 11155111
const CHAIN_NAME = 'Sepolia';
const AUDIT_DEFAULT = 'sepolia-call-audit.jsonl';
const MAX_DATA_BYTES = 8192;
const EXIT_REFUSED = 3;

const RULE_LABELS = {
  chain: 'Sepolia-only chain check',
  cap: 'per-refill cap',
  budget: 'total spend budget',
  gas: 'gas estimation',
  'treasury-low': 'treasury balance',
};

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function describe(err) {
  return err?.shortMessage ?? err?.message ?? String(err);
}

function usage() {
  console.log(`Usage: node sepolia-call.mjs --to 0xTARGET --data 0xHEX [options]

Sends one calldata transaction on Sepolia (chain ${CHAIN_ID}) only.

Required:
  --to 0xADDRESS        target contract or account
  --data 0xHEX          calldata, whole bytes, 1..${MAX_DATA_BYTES} bytes
  --data-file PATH      read the calldata from a file instead (same limits);
                        pass this rather than --data for large payloads, which
                        some hosts refuse to put on a command line

Options:
  --value ETH           native value to send with the call (default 0)
  --max-per-refill ETH  cap on value + worst-case gas (required with --live)
  --total-budget ETH    cap on value + fees already spent on Sepolia (required with --live)
  --gas-limit N         use this gas limit instead of estimating
  --rpc URL             Sepolia RPC endpoint (default: the chain's public RPC)
  --audit PATH          audit log (default ${AUDIT_DEFAULT}); a lock at PATH.lock
                        keeps a second run from overlapping this one
  --alert-cooldown SEC  seconds between identical alerts (default 900)
  --live                sign and broadcast (otherwise dry run)
  -h, --help            show this help

Environment:
  TREASURY_PRIVATE_KEY  key of the sending wallet (required)
  MAX_REFILL_ETH        default for --max-per-refill
  TOTAL_BUDGET_ETH      default for --total-budget
  RPC_URL               default for --rpc
  ALERT_COOLDOWN_SECONDS default for --alert-cooldown
  SLACK_WEBHOOK_URL     Slack incoming webhook; alerts are disabled without it
  SLACK_ALERT_WEBHOOK_URL / SLACK_WARNING_WEBHOOK_URL  optional channels
  SLACK_*_WEBHOOK_FILE  read that webhook URL from a file instead

Exit codes: 0 ok/no action, 1 usage or config error, 2 runtime error,
            3 refused by a safety rule, 4 another run holds the lock.`);
}

function parseEtherArg(name, raw, { allowZero = false } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  let wei;
  try {
    wei = parseEther(String(raw).trim());
  } catch {
    fail(`${name} must be a decimal ether amount like 0.005 (got "${raw}")`);
  }
  if (!allowZero && wei === 0n) fail(`${name} must be greater than zero`);
  return wei;
}

function parseCooldown(raw) {
  if (raw === null || raw === undefined || raw === '') return 900;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
    fail(`--alert-cooldown expects whole seconds between 0 and 86400, got "${raw}"`);
  }
  return seconds;
}

function parseArgs(argv) {
  const opts = {
    to: null,
    data: null,
    dataFile: null,
    valueRaw: process.env.CALL_VALUE_ETH ?? null,
    maxPerRefillRaw: process.env.MAX_REFILL_ETH ?? null,
    totalBudgetRaw: process.env.TOTAL_BUDGET_ETH ?? null,
    gasLimitRaw: null,
    rpc: process.env.RPC_URL ?? null,
    audit: AUDIT_DEFAULT,
    alertCooldownRaw: process.env.ALERT_COOLDOWN_SECONDS ?? null,
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
    } else if (arg === '--data') {
      opts.data = next();
    } else if (arg === '--data-file') {
      opts.dataFile = next();
    } else if (arg === '--value') {
      opts.valueRaw = next();
    } else if (arg === '--max-per-refill') {
      opts.maxPerRefillRaw = next();
    } else if (arg === '--total-budget') {
      opts.totalBudgetRaw = next();
    } else if (arg === '--gas-limit') {
      opts.gasLimitRaw = next();
    } else if (arg === '--rpc') {
      opts.rpc = next();
    } else if (arg === '--audit') {
      opts.audit = next();
    } else if (arg === '--alert-cooldown') {
      opts.alertCooldownRaw = next();
    } else if (arg === '--chain') {
      fail(`--chain is not supported: this tool sends on ${CHAIN_NAME} (${CHAIN_ID}) only`);
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

// Value plus fees already spent on Sepolia, from the calldata audit log.
// A transaction appears as submitted then confirmed, so count each tx once and
// take the fee from whichever line carries it. Submitted-but-unconfirmed still
// counts: assume it landed.
function readSpent(auditPath) {
  if (!existsSync(auditPath)) return 0n;
  const byTx = new Map();
  for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.chainId !== CHAIN_ID) continue;
      if (entry.status !== 'submitted' && entry.status !== 'confirmed') continue;
      const value = BigInt(entry.valueWei ?? '0');
      const fee = entry.feeWei === undefined || entry.feeWei === null ? 0n : BigInt(entry.feeWei);
      const previous = byTx.get(entry.txHash);
      byTx.set(entry.txHash, {
        value,
        fee: fee > (previous?.fee ?? 0n) ? fee : (previous?.fee ?? 0n),
      });
    } catch {
      console.error(`warning: ignoring unreadable audit line in ${auditPath}`);
    }
  }
  let total = 0n;
  for (const record of byTx.values()) total += record.value + record.fee;
  return total;
}

// Never contains secrets: no key, no RPC URL, and only a hash of the payload.
// Written under a mutex and fsynced by run-lock.mjs, so two processes cannot
// interleave halves of an entry.
function appendAudit(auditPath, entry) {
  appendAuditLine(auditPath, entry, { log });
}

async function refuse(ctx, key, reason, figures = null) {
  const label = RULE_LABELS[key] ?? key;
  log(`REFUSING: ${reason} [rule ${key} (${label})${figures ? `: ${figures}` : ''}]`);
  if (ctx.notifier.enabled) {
    const lines = [
      `:rotating_light: *sepolia calldata refused (high)* - ${CHAIN_NAME} (${CHAIN_ID})`,
      reason,
    ];
    if (figures) lines.push(figures);
    lines.push(
      `target ${ctx.to} | treasury ${ctx.account.address}`,
      `data ${ctx.dataBytes} bytes, keccak ${ctx.dataHash}`,
      `mode ${ctx.dryRun ? 'DRY RUN' : 'LIVE'} | severity high | rule ${key} (${label})`,
    );
    await ctx.notifier.alert(`refused:${CHAIN_ID}:${key}`, lines.join('\n'));
  }
  return 'refused';
}

async function tick(ctx) {
  const {
    publicClient,
    walletClient,
    account,
    to,
    data,
    dataHash,
    dataBytes,
    value,
    maxPerRefill,
    totalBudget,
    gasLimit,
    dryRun,
    auditPath,
    notifier,
    rpcLabel,
  } = ctx;

  let nodeChainId;
  try {
    nodeChainId = await publicClient.getChainId();
  } catch (err) {
    fail(`cannot reach the RPC ${rpcLabel}: ${describe(err)}`, 2);
  }
  if (nodeChainId !== CHAIN_ID) {
    return refuse(
      ctx,
      'chain',
      `RPC reports chain ${nodeChainId}, but this tool only sends on ${CHAIN_NAME} (${CHAIN_ID})`,
      `node chain ${nodeChainId} | required ${CHAIN_ID}`,
    );
  }

  let fees;
  try {
    fees = await publicClient.estimateFeesPerGas();
  } catch {
    const gasPrice = await publicClient.getGasPrice();
    fees = { gasPrice };
    log(`note: no EIP-1559 fee data; using legacy gas price ${gasPrice} wei`);
  }
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;

  let gas = gasLimit;
  if (gas === null) {
    try {
      gas = await publicClient.estimateGas({ account, to, value, data });
    } catch (err) {
      return refuse(
        ctx,
        'gas',
        `cannot estimate gas for this call: ${describe(err)}`,
        'pass --gas-limit N to override with a reviewed limit',
      );
    }
  }

  const gasCost = gas * maxFeePerGas;
  const maxCost = value + gasCost;
  const spent = readSpent(auditPath);

  if (maxPerRefill !== null && maxCost > maxPerRefill) {
    return refuse(
      ctx,
      'cap',
      `transaction needs up to ${formatEther(maxCost)} ETH (value + worst-case gas), above the per-refill cap ${formatEther(maxPerRefill)} ETH`,
      `limit ${formatEther(maxPerRefill)} ETH | value ${formatEther(value)} ETH + ` +
        `gas ${formatEther(gasCost)} ETH | over by ${formatEther(maxCost - maxPerRefill)} ETH`,
    );
  }

  if (totalBudget !== null && spent + maxCost > totalBudget) {
    const remaining = spent < totalBudget ? totalBudget - spent : 0n;
    return refuse(
      ctx,
      'budget',
      `budget on ${CHAIN_NAME} is spent - recorded ${formatEther(spent)} ETH of ` +
        `${formatEther(totalBudget)} ETH, this call needs up to ${formatEther(maxCost)} ETH`,
      `limit ${formatEther(totalBudget)} ETH | spent ${formatEther(spent)} ETH | ` +
        `remaining ${formatEther(remaining)} ETH | requested ${formatEther(maxCost)} ETH | ` +
        `over by ${formatEther(spent + maxCost - totalBudget)} ETH`,
    );
  }

  const treasuryBalance = await publicClient.getBalance({ address: account.address });
  if (treasuryBalance < maxCost) {
    return refuse(
      ctx,
      'treasury-low',
      `treasury ${account.address} holds ${formatEther(treasuryBalance)} ETH but the call needs up to ${formatEther(maxCost)} ETH including worst-case gas`,
      `needs up to ${formatEther(maxCost)} ETH (value ${formatEther(value)} + ` +
        `gas ${formatEther(gasCost)}) | treasury holds ${formatEther(treasuryBalance)} ETH | ` +
        `short by ${formatEther(maxCost - treasuryBalance)} ETH`,
    );
  }

  if (dryRun) {
    log('DRY RUN - nothing signed or broadcast. Plan:');
    console.log(`  call      ${to} on ${CHAIN_NAME} (chain ${CHAIN_ID})`);
    console.log(`  value     ${formatEther(value)} ETH`);
    console.log(`  data      ${dataBytes} bytes, keccak ${dataHash}`);
    console.log(
      `  gas       ${gas} units, up to ${formatEther(gasCost)} ETH at ${maxFeePerGas} wei/gas`,
    );
    console.log(
      `  max cost  ${formatEther(maxCost)} ETH from treasury ${account.address} ` +
        `(holds ${formatEther(treasuryBalance)} ETH)`,
    );
    console.log(
      `  caps      per-refill ${maxPerRefill === null ? 'none' : `${formatEther(maxPerRefill)} ETH`}, ` +
        `budget ${totalBudget === null ? 'none' : `${formatEther(totalBudget)} ETH (spent ${formatEther(spent)} ETH)`}`,
    );
    log('dry run: the plan is within caps - add --live to send');
    return 'dry-run';
  }

  const request = { to, value, data, gas };
  if (fees.maxFeePerGas !== undefined) {
    request.maxFeePerGas = fees.maxFeePerGas;
    if (fees.maxPriorityFeePerGas !== undefined) {
      request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    }
  } else {
    request.gasPrice = fees.gasPrice;
  }

  const hash = await walletClient.sendTransaction(request);
  appendAudit(auditPath, {
    ts: new Date().toISOString(),
    chainId: CHAIN_ID,
    chain: CHAIN_NAME,
    from: account.address,
    to,
    valueWei: value.toString(),
    dataHash,
    dataBytes,
    txHash: hash,
    status: 'submitted',
  });
  log(`submitted ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const status = receipt.status === 'success' ? 'confirmed' : 'failed';
  const feeWei =
    receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined
      ? receipt.gasUsed * receipt.effectiveGasPrice
      : null;
  appendAudit(auditPath, {
    ts: new Date().toISOString(),
    chainId: CHAIN_ID,
    chain: CHAIN_NAME,
    from: account.address,
    to,
    valueWei: value.toString(),
    dataHash,
    dataBytes,
    ...(feeWei === null ? {} : { feeWei: feeWei.toString() }),
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    status,
  });

  const explorer = CHAIN.blockExplorers?.default?.url;
  log(`${status} in block ${receipt.blockNumber}${explorer ? ` (${explorer}/tx/${hash})` : ''}`);

  if (status === 'confirmed' && notifier.enabled) {
    await notifier.alert(
      `sent:${CHAIN_ID}:${hash}`,
      [
        `:test_tube: *sepolia calldata sent* - ${CHAIN_NAME} (${CHAIN_ID})`,
        `${formatEther(value)} ETH + ${dataBytes} bytes -> ${to}`,
        `data keccak ${dataHash}`,
        `tx ${hash}${explorer ? ` (${explorer}/tx/${hash})` : ''}`,
        'mode LIVE',
      ].join('\n'),
    );
  }

  return 'sent';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.to) fail('--to is required');
  if (!isAddress(opts.to)) fail(`--to must be a 0x EVM address (got "${opts.to}")`);
  const to = getAddress(opts.to);

  if (opts.data && opts.dataFile) fail('pass either --data or --data-file, not both');
  if (!opts.data && !opts.dataFile) fail('--data is required (0x-prefixed calldata)');
  let data;
  if (opts.dataFile) {
    if (!existsSync(opts.dataFile)) fail(`--data-file ${opts.dataFile} does not exist`);
    data = readFileSync(opts.dataFile, 'utf8').trim();
    if (!data) fail(`--data-file ${opts.dataFile} is empty`);
  } else {
    data = opts.data.trim();
  }
  if (!/^0x[0-9a-fA-F]+$/.test(data)) fail('calldata must be 0x-prefixed hex with at least one byte');
  if (data.length % 2 !== 0) fail('calldata must contain whole bytes (an even number of hex digits)');
  const dataBytes = (data.length - 2) / 2;
  if (dataBytes > MAX_DATA_BYTES) {
    fail(`calldata is ${dataBytes} bytes; the limit is ${MAX_DATA_BYTES} bytes`);
  }

  const value = parseEtherArg('--value', opts.valueRaw, { allowZero: true }) ?? 0n;
  const maxPerRefill = parseEtherArg('--max-per-refill', opts.maxPerRefillRaw);
  const totalBudget = parseEtherArg('--total-budget', opts.totalBudgetRaw);

  let gasLimit = null;
  if (opts.gasLimitRaw !== null) {
    const parsed = Number(opts.gasLimitRaw);
    if (!Number.isInteger(parsed) || parsed < 21000 || parsed > 30000000) {
      fail(`--gas-limit expects a whole number between 21000 and 30000000, got "${opts.gasLimitRaw}"`);
    }
    gasLimit = BigInt(parsed);
  }

  const rawKey = (process.env.TREASURY_PRIVATE_KEY ?? '').trim();
  if (!rawKey) {
    fail(
      'TREASURY_PRIVATE_KEY is not set - put it in a git-ignored .env and run: node --env-file=.env sepolia-call.mjs ...',
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
    fail('TREASURY_PRIVATE_KEY must be 0x followed by 64 hex characters');
  }
  let account;
  try {
    account = privateKeyToAccount(rawKey);
  } catch {
    fail('TREASURY_PRIVATE_KEY is not a valid secp256k1 private key');
  }

  if (to === zeroAddress) fail('--to cannot be the zero address');
  if (to === account.address) fail('--to cannot be the treasury address itself');
  if (opts.live && (maxPerRefill === null || totalBudget === null)) {
    fail(
      '--live needs explicit caps: pass --max-per-refill and --total-budget (or set MAX_REFILL_ETH and TOTAL_BUDGET_ETH)',
    );
  }

  // One run per audit log at a time, shared with the other signing tools.
  // Released on exit.
  takeRunLock(opts.audit, { tool: 'sepolia-call.mjs', log });

  const notifier = createSlackNotifier({
    ...resolveSlackWebhooks(),
    cooldownMs: parseCooldown(opts.alertCooldownRaw) * 1000,
    log,
  });

  const transport = http(opts.rpc ?? undefined);
  const publicClient = createPublicClient({ chain: CHAIN, transport });
  const walletClient = createWalletClient({ chain: CHAIN, account, transport });
  const rpcLabel = opts.rpc ? new URL(opts.rpc).host : 'chain default RPC';

  log(
    `treasury ${account.address}, chain ${CHAIN_NAME} (${CHAIN_ID}) via ${rpcLabel}, ` +
      `mode ${opts.live ? 'LIVE' : 'DRY RUN'}`,
  );
  log(notifier.describe());

  const ctx = {
    publicClient,
    walletClient,
    account,
    to,
    data,
    dataHash: keccak256(data),
    dataBytes,
    value,
    maxPerRefill,
    totalBudget,
    gasLimit,
    dryRun: !opts.live,
    auditPath: opts.audit,
    notifier,
    rpcLabel,
  };

  const result = await tick(ctx);
  if (result === 'refused') process.exitCode = EXIT_REFUSED;
}

main().catch((err) => fail(describe(err), 2));
