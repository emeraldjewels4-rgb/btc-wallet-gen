#!/usr/bin/env node
/**
 * Treasury refill bot for EVM chains.
 *
 * Tops up one target address from a treasury wallet you control when the target
 * balance falls below a threshold. It moves only your own funds between your own
 * addresses; it cannot create funds.
 *
 * Safety model:
 *   - DRY RUN by default: nothing is signed or broadcast without --live.
 *   - --live requires explicit --max-per-refill and --total-budget caps.
 *   - Refuses when the amount breaks a cap, the chain budget is spent, the
 *     treasury cannot cover amount + worst-case gas, or the target is the
 *     treasury itself / the zero address.
 *   - The treasury key is read from TREASURY_PRIVATE_KEY and is never printed,
 *     logged, or written to the audit file.
 *
 * Usage:
 *   node --env-file=.env refill.mjs --to 0xTARGET --threshold 0.001 --amount 0.005 \
 *     --max-per-refill 0.01 --total-budget 0.05
 *   add --live to actually send, --chain 11155111 to rehearse on Sepolia,
 *   --watch 300 to poll. See --help.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSlackNotifier, resolveSlackWebhooks } from './notify.mjs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, mainnet, optimism, polygon, sepolia } from 'viem/chains';

// Anvil, Hardhat and Ganache all use id 31337 for local dev chains; used for rehearsals.
const localDev = defineChain({
  id: 31337,
  name: 'Local dev chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

const CHAINS = new Map([
  [mainnet.id, mainnet],
  [localDev.id, localDev],
  [optimism.id, optimism],
  [polygon.id, polygon],
  [base.id, base],
  [arbitrum.id, arbitrum],
  [sepolia.id, sepolia],
]);

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const EXIT_REFUSED = 3;

// Human names for the safety rules, used in refusal alerts and logs.
const RULE_LABELS = {
  cap: 'per-refill cap',
  budget: 'total spend budget',
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

// How much of a limit a request represents, as a whole percentage.
function percentOf(part, whole) {
  return whole === 0n ? 0n : (part * 100n) / whole;
}

function usage() {
  console.log(`Usage: node refill.mjs --to 0xTARGET --amount ETH [options]

Required:
  --to 0xADDRESS        target wallet to top up (an address you control)
  --amount ETH          value sent per refill, e.g. 0.005

Options:
  --threshold ETH       refill only when the target holds less than this (default 0)
  --chain ID            chain id: 1, 10, 137, 8453, 42161, 11155111,
                        31337 (local dev chain, default 1)
  --max-per-refill ETH  hard cap for a single refill (required with --live)
  --total-budget ETH    hard cap on total sent per chain (required with --live)
  --rpc URL             RPC endpoint (default: the chain's public RPC)
  --min-treasury ETH    Slack alert when the treasury drops below this floor
  --alert-cooldown SEC  seconds between identical alerts (default 900)
  --audit PATH          audit log path (default ${AUDIT_DEFAULT})
  --watch SECONDS       poll every SECONDS instead of running once
  --live                actually sign and broadcast (otherwise dry run)
  -h, --help            show this help

Environment:
  TREASURY_PRIVATE_KEY  private key of the funding wallet (required)
  MAX_REFILL_ETH        default for --max-per-refill
  TOTAL_BUDGET_ETH      default for --total-budget
  MIN_TREASURY_ETH      default for --min-treasury
  ALERT_COOLDOWN_SECONDS default for --alert-cooldown
  SLACK_WEBHOOK_URL     Slack incoming webhook; alerts are disabled without it
  SLACK_ALERT_WEBHOOK_URL   webhook for refusals (default: SLACK_WEBHOOK_URL)
  SLACK_WARNING_WEBHOOK_URL webhook for low-treasury alerts (default: SLACK_WEBHOOK_URL)
  SLACK_*_WEBHOOK_FILE  read that webhook URL from a file instead, e.g.
                        SLACK_WEBHOOK_FILE=/path/to/webhook
  RPC_URL               default for --rpc

Exit codes: 0 ok/no action, 1 usage or config error, 2 runtime error,
            3 refused by a safety rule.`);
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

function parseArgs(argv) {
  const opts = {
    to: null,
    amountRaw: null,
    thresholdRaw: null,
    chainId: mainnet.id,
    maxPerRefillRaw: process.env.MAX_REFILL_ETH ?? null,
    totalBudgetRaw: process.env.TOTAL_BUDGET_ETH ?? null,
    rpc: process.env.RPC_URL ?? null,
    minTreasuryRaw: process.env.MIN_TREASURY_ETH ?? null,
    alertCooldownRaw: process.env.ALERT_COOLDOWN_SECONDS ?? null,
    watch: 0,
    live: false,
    audit: AUDIT_DEFAULT,
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
    } else if (arg === '--max-per-refill') {
      opts.maxPerRefillRaw = next();
    } else if (arg === '--total-budget') {
      opts.totalBudgetRaw = next();
    } else if (arg === '--rpc') {
      opts.rpc = next();
    } else if (arg === '--audit') {
      opts.audit = next();
    } else if (arg === '--min-treasury') {
      opts.minTreasuryRaw = next();
    } else if (arg === '--alert-cooldown') {
      opts.alertCooldownRaw = next();
    } else if (arg === '--chain') {
      const raw = next();
      const id = Number(raw);
      if (!Number.isInteger(id)) fail(`--chain expects a numeric chain id, got "${raw}"`);
      opts.chainId = id;
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

// Total value already sent on this chain, from the audit log. Read-only.
// Each transaction appears twice (submitted, then confirmed), so count once per
// tx hash. A submitted hash with no confirmation still counts: assume it landed.
function readSpent(auditPath, chainId) {
  if (!existsSync(auditPath)) return 0n;
  const byTx = new Map();
  for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.chainId !== chainId) continue;
      if (entry.status !== 'submitted' && entry.status !== 'confirmed') continue;
      const previous = byTx.get(entry.txHash);
      byTx.set(entry.txHash, {
        amountWei: BigInt(entry.amountWei),
        confirmed: entry.status === 'confirmed' || previous?.confirmed === true,
      });
    } catch {
      // A malformed audit line must not unblock spending, so warn and keep going.
      console.error(`warning: ignoring unreadable audit line in ${auditPath}`);
    }
  }
  let total = 0n;
  for (const record of byTx.values()) total += record.amountWei;
  return total;
}

// Never contains secrets: no key, and no RPC URL (it may carry an API key).
function appendAudit(auditPath, entry) {
  appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
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
      `:rotating_light: *refill refused (high)* - ${ctx.chain.name} (${ctx.chain.id})`,
      reason,
    ];
    if (figures) lines.push(figures);
    lines.push(
      `target ${ctx.to} | treasury ${ctx.account.address}`,
      `mode ${ctx.dryRun ? 'DRY RUN' : 'LIVE'} | severity high | rule ${key} (${label})`,
    );
    await ctx.notifier.alert(`refused:${ctx.chain.id}:${key}`, lines.join('\n'));
  }
  return 'refused';
}

async function tick(ctx) {
  const {
    publicClient,
    walletClient,
    account,
    chain,
    to,
    amount,
    threshold,
    maxPerRefill,
    totalBudget,
    dryRun,
    auditPath,
    minTreasury,
    notifier,
  } = ctx;

  const targetBalance = await publicClient.getBalance({ address: to });
  log(`${chain.name}: target ${to} holds ${formatEther(targetBalance)} ETH, threshold ${formatEther(threshold)} ETH`);
  if (targetBalance >= threshold) {
    log('above threshold, nothing to do');
    return 'idle';
  }

  if (maxPerRefill !== null && amount > maxPerRefill) {
    return refuse(
      ctx,
      'cap',
      `refill ${formatEther(amount)} ETH exceeds the per-refill cap ${formatEther(maxPerRefill)} ETH`,
      `limit ${formatEther(maxPerRefill)} ETH | requested ${formatEther(amount)} ETH | ` +
        `over by ${formatEther(amount - maxPerRefill)} ETH ` +
        `(${percentOf(amount, maxPerRefill)}% of the cap)`,
    );
  }

  const spent = totalBudget === null ? null : readSpent(auditPath, chain.id);
  if (totalBudget !== null && spent + amount > totalBudget) {
    const remaining = spent < totalBudget ? totalBudget - spent : 0n;
    return refuse(
      ctx,
      'budget',
      `budget on ${chain.name} is spent - sent ${formatEther(spent)} ETH of ` +
        `${formatEther(totalBudget)} ETH, this refill needs ${formatEther(amount)} ETH`,
      `limit ${formatEther(totalBudget)} ETH | spent ${formatEther(spent)} ETH | ` +
        `remaining ${formatEther(remaining)} ETH | requested ${formatEther(amount)} ETH | ` +
        `over by ${formatEther(spent + amount - totalBudget)} ETH`,
    );
  }

  // Fees before gas: estimateGas fails outright on an unfunded account, and that has
  // to surface as the "treasury cannot cover this" refusal, not a raw RPC error.
  let fees;
  try {
    fees = await publicClient.estimateFeesPerGas();
  } catch {
    const gasPrice = await publicClient.getGasPrice();
    fees = { gasPrice };
    log(`note: no EIP-1559 fee data from this chain; using legacy gas price ${gasPrice} wei`);
  }
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;

  let gas = null;
  try {
    gas = await publicClient.estimateGas({ account, to, value: amount });
  } catch {
    log('note: gas estimation failed (typical for an unfunded treasury); costing the refill at 100000 gas');
  }
  const gasForCost = gas ?? 100000n;
  const maxCost = amount + gasForCost * maxFeePerGas;

  const treasuryBalance = await publicClient.getBalance({ address: account.address });
  const shortfall =
    `treasury ${account.address} holds ${formatEther(treasuryBalance)} ETH but the refill needs ` +
    `up to ${formatEther(maxCost)} ETH including worst-case gas`;

  // Clamped: this is computed on every run, including solvent ones where the
  // treasury is above maxCost and the naive difference would be negative.
  const shortfallWei = maxCost > treasuryBalance ? maxCost - treasuryBalance : 0n;
  const shortfallFigures =
    `needs up to ${formatEther(maxCost)} ETH (refill ${formatEther(amount)} + ` +
    `gas ${formatEther(gasForCost * maxFeePerGas)} ETH) | treasury holds ` +
    `${formatEther(treasuryBalance)} ETH | short by ${formatEther(shortfallWei)} ETH`;

  if (minTreasury !== null && treasuryBalance < minTreasury) {
    await notifier.alert(
      `low:${chain.id}`,
      [
        `:warning: *treasury low (medium)* - ${chain.name} (${chain.id})`,
        `treasury ${account.address} holds ${formatEther(treasuryBalance)} ETH, below the ${formatEther(minTreasury)} ETH floor`,
        `target ${to}`,
        `mode ${dryRun ? 'DRY RUN' : 'LIVE'} | severity medium`,
      ].join('\n'),
    );
  }

  if (dryRun) {
    log('DRY RUN - nothing signed or broadcast. Plan:');
    console.log(`  send      ${formatEther(amount)} ETH -> ${to} on ${chain.name} (chain ${chain.id})`);
    console.log(
      `  gas       ${gas === null ? `${gasForCost} (assumed)` : gas} units, ` +
        `up to ${formatEther(gasForCost * maxFeePerGas)} ETH at ${maxFeePerGas} wei/gas`,
    );
    console.log(
      `  max cost  ${formatEther(maxCost)} ETH from treasury ${account.address} ` +
        `(holds ${formatEther(treasuryBalance)} ETH)`,
    );
    console.log(
      `  caps      per-refill ${maxPerRefill === null ? 'none' : `${formatEther(maxPerRefill)} ETH`}, ` +
        `budget ${totalBudget === null ? 'none' : `${formatEther(totalBudget)} ETH (spent ${formatEther(spent ?? 0n)} ETH)`}`,
    );
    if (treasuryBalance < maxCost) {
      return refuse(ctx, 'treasury-low', shortfall, shortfallFigures);
    }
    log('dry run: the plan is affordable - add --live to send');
    return 'dry-run';
  }

  if (treasuryBalance < maxCost) {
    return refuse(ctx, 'treasury-low', shortfall, shortfallFigures);
  }

  const request = { to, value: amount };
  if (gas !== null) request.gas = gas;
  if (fees.maxFeePerGas !== undefined) {
    request.maxFeePerGas = fees.maxFeePerGas;
    if (fees.maxPriorityFeePerGas !== undefined) request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } else {
    request.gasPrice = fees.gasPrice;
  }

  const hash = await walletClient.sendTransaction(request);
  appendAudit(auditPath, {
    ts: new Date().toISOString(),
    chainId: chain.id,
    chain: chain.name,
    from: account.address,
    to,
    amountWei: amount.toString(),
    txHash: hash,
    status: 'submitted',
  });
  log(`submitted ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const status = receipt.status === 'success' ? 'confirmed' : 'failed';
  // The submitted line cannot know the fee yet; the receipt can. Record it so the
  // roll-ups can total gas spend. It is a fee, never a key or an RPC URL.
  const feeWei =
    receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined
      ? receipt.gasUsed * receipt.effectiveGasPrice
      : null;
  appendAudit(auditPath, {
    ts: new Date().toISOString(),
    chainId: chain.id,
    chain: chain.name,
    from: account.address,
    to,
    amountWei: amount.toString(),
    ...(feeWei === null ? {} : { feeWei: feeWei.toString() }),
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    status,
  });

  const explorer = chain.blockExplorers?.default?.url;
  log(`${status} in block ${receipt.blockNumber}${explorer ? ` (${explorer}/tx/${hash})` : ''}`);

  if (status === 'confirmed' && notifier.enabled) {
    await notifier.alert(
      `sent:${chain.id}:${hash}`,
      [
        `:white_check_mark: *refill sent* - ${chain.name} (${chain.id})`,
        `${formatEther(amount)} ETH -> ${to}`,
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

  if (!opts.amountRaw) fail('--amount is required');
  const amount = parseEtherArg('--amount', opts.amountRaw);
  const threshold = parseEtherArg('--threshold', opts.thresholdRaw, { allowZero: true }) ?? 0n;
  const maxPerRefill = parseEtherArg('--max-per-refill', opts.maxPerRefillRaw);
  const totalBudget = parseEtherArg('--total-budget', opts.totalBudgetRaw);

  const chain = CHAINS.get(opts.chainId);
  if (!chain) {
    fail(`unsupported chain id ${opts.chainId} (supported: ${[...CHAINS.keys()].join(', ')})`);
  }

  const rawKey = (process.env.TREASURY_PRIVATE_KEY ?? '').trim();
  if (!rawKey) {
    fail('TREASURY_PRIVATE_KEY is not set - put it in a git-ignored .env and run: node --env-file=.env refill.mjs ...');
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
    fail('--live needs explicit caps: pass --max-per-refill and --total-budget (or set MAX_REFILL_ETH and TOTAL_BUDGET_ETH)');
  }
  if (maxPerRefill !== null && amount > maxPerRefill) {
    fail(`--amount ${formatEther(amount)} ETH is already above --max-per-refill ${formatEther(maxPerRefill)} ETH`);
  }
  if (totalBudget !== null && amount > totalBudget) {
    fail(`--amount ${formatEther(amount)} ETH is already above --total-budget ${formatEther(totalBudget)} ETH`);
  }

  const minTreasury = parseEtherArg('--min-treasury', opts.minTreasuryRaw);
  const notifier = createSlackNotifier({
    ...resolveSlackWebhooks(),
    cooldownMs: parseCooldown(opts.alertCooldownRaw) * 1000,
    log,
  });

  const transport = http(opts.rpc ?? undefined);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, account, transport });

  const rpcLabel = opts.rpc ? new URL(opts.rpc).host : 'chain default RPC';
  log(`treasury ${account.address}, chain ${chain.name} (${chain.id}) via ${rpcLabel}, mode ${opts.live ? 'LIVE' : 'DRY RUN'}`);
  log(notifier.describe());

  const ctx = {
    publicClient,
    walletClient,
    account,
    chain,
    to,
    amount,
    threshold,
    maxPerRefill,
    totalBudget,
    dryRun: !opts.live,
    auditPath: opts.audit,
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
