#!/usr/bin/env node
/**
 * Daily treasury summary for Slack.
 *
 * Read-only: it queries public balances for the wallets you list and summarises
 * refills recorded in the audit log over the last 24 hours. It needs no private
 * key and never signs anything.
 *
 * Usage:
 *   node --env-file=.env treasury-summary.mjs \
 *     --evm 1:0xTREASURY --evm 8453:0xTREASURY --btc mainnet:bc1q... --post
 *
 * Intended to run once a day from cron or Windows Task Scheduler. --state records
 * the last posted date, so a second run in the same day is a no-op unless
 * --force is passed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { createPublicClient, formatEther, http, isAddress } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon, sepolia } from 'viem/chains';
import { createSlackNotifier, resolveWebhook } from './notify.mjs';

const CHAINS = new Map([
  [mainnet.id, mainnet],
  [optimism.id, optimism],
  [polygon.id, polygon],
  [base.id, base],
  [arbitrum.id, arbitrum],
  [sepolia.id, sepolia],
]);

const BTC_NETWORKS = {
  mainnet: { network: bitcoin.networks.bitcoin, api: 'https://mempool.space/api' },
  testnet: { network: bitcoin.networks.testnet, api: 'https://mempool.space/testnet/api' },
};

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const STATE_DEFAULT = '.treasury-summary-state.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node treasury-summary.mjs [wallets] [options]

Wallets (repeatable, read-only - no keys needed):
  --evm CHAIN_ID:ADDRESS   EVM treasury, e.g. 1:0xabc...
  --btc NETWORK:ADDRESS    Bitcoin treasury, e.g. mainnet:bc1q...

Options:
  --audit PATH             audit log to summarise (default ${AUDIT_DEFAULT})
  --evm-rpc URL            RPC endpoint for all EVM entries (default: chain RPC)
  --btc-api URL            mempool.space-compatible endpoint for BTC entries
  --post                   post to Slack (otherwise print only)
  --webhook-file PATH      read the webhook URL from this file (wins over .env)
  --force                  post even if today's summary was already posted
  --state PATH             state file for the once-per-day guard (default ${STATE_DEFAULT})
  --day YYYY-MM-DD         date to record/post for (default today, UTC)
  -h, --help               show this help

Environment:
  SLACK_WEBHOOK_URL        required with --post
  SLACK_WEBHOOK_FILE       read that URL from a file instead

Exit codes: 0 ok, 1 usage or config error, 2 runtime error.`);
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

function parseArgs(argv) {
  const opts = {
    evm: [],
    btc: [],
    audit: AUDIT_DEFAULT,
    evmRpc: null,
    btcApi: null,
    post: false,
    force: false,
    state: STATE_DEFAULT,
    day: null,
    webhookFile: null,
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
    } else if (arg === '--evm') {
      opts.evm.push(next());
    } else if (arg === '--btc') {
      opts.btc.push(next());
    } else if (arg === '--audit') {
      opts.audit = next();
    } else if (arg === '--evm-rpc') {
      opts.evmRpc = next();
    } else if (arg === '--btc-api') {
      opts.btcApi = next().replace(/\/+$/, '');
    } else if (arg === '--post') {
      opts.post = true;
    } else if (arg === '--webhook-file') {
      opts.webhookFile = next();
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--state') {
      opts.state = next();
    } else if (arg === '--day') {
      opts.day = next();
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

function satsToBtc(sats) {
  const whole = sats / 100000000n;
  const frac = (sats % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`GET ${new URL(url).pathname} -> HTTP ${res.status}`);
  }
  return res.json();
}

// One row per transaction: audit logs write a submitted and a confirmed line.
function readActivity(auditPath, sinceMs) {
  if (!existsSync(auditPath)) return [];
  const rows = [];
  for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.status !== 'submitted' && entry.status !== 'confirmed') continue;
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      rows.push(entry);
    } catch {
      console.error(`warning: ignoring unreadable audit line in ${auditPath}`);
    }
  }
  return rows;
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.evm.length === 0 && opts.btc.length === 0) {
    fail('at least one --evm CHAIN_ID:ADDRESS or --btc NETWORK:ADDRESS is required');
  }

  const day = opts.day ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`--day must look like 2026-11-10, got "${day}"`);

  const balanceLines = [];

  for (const entry of opts.evm) {
    const [chainPart, address] = splitOnce(entry, ':');
    const chainId = Number(chainPart);
    const chain = CHAINS.get(chainId);
    if (!chain) fail(`unsupported EVM chain id "${chainPart}" (supported: ${[...CHAINS.keys()].join(', ')})`);
    if (!address || !isAddress(address)) fail(`--evm expects CHAIN_ID:0xADDRESS, got "${entry}"`);

    const client = createPublicClient({ chain, transport: http(opts.evmRpc ?? undefined) });
    const wei = await client.getBalance({ address });
    balanceLines.push(`- ${chain.name.toLowerCase()} (${chain.id}) ${address}: ${formatEther(wei)} ETH`);
  }

  for (const entry of opts.btc) {
    const [networkName, address] = splitOnce(entry, ':');
    const net = BTC_NETWORKS[networkName];
    if (!net) fail(`unsupported bitcoin network "${networkName}" (use mainnet or testnet)`);
    if (!address) fail(`--btc expects NETWORK:ADDRESS, got "${entry}"`);
    try {
      bitcoin.address.toOutputScript(address, net.network);
    } catch {
      fail(`--btc address "${address}" is not valid on ${networkName}`);
    }

    const api = opts.btcApi ?? net.api;
    const utxos = await getJson(`${api}/address/${address}/utxo`);
    const sats = utxos
      .filter((utxo) => utxo.status?.confirmed)
      .reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);
    balanceLines.push(`- bitcoin ${networkName} ${address}: ${satsToBtc(sats)} BTC`);
  }

  const since = Date.now() - DAY_MS;
  const activity = readActivity(opts.audit, since);

  const evmTotals = new Map();
  const btcTotals = new Map();
  const seen = new Set();

  for (const entry of activity) {
    if (entry.chain === 'bitcoin') {
      const key = `btc:${entry.network}:${entry.txid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = btcTotals.get(entry.network) ?? { count: 0, sats: 0n };
      btcTotals.set(entry.network, { count: current.count + 1, sats: current.sats + BigInt(entry.amountSats) });
    } else if (typeof entry.chainId === 'number') {
      const key = `evm:${entry.chainId}:${entry.txHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = evmTotals.get(entry.chainId) ?? { count: 0, wei: 0n };
      evmTotals.set(entry.chainId, { count: current.count + 1, wei: current.wei + BigInt(entry.amountWei) });
    }
  }

  const activityLines = [];
  for (const [chainId, total] of evmTotals) {
    const chainName = CHAINS.get(chainId)?.name ?? `chain ${chainId}`;
    activityLines.push(`- ${total.count} on ${chainName.toLowerCase()} (${chainId}): ${formatEther(total.wei)} ETH`);
  }
  for (const [networkName, total] of btcTotals) {
    activityLines.push(`- ${total.count} on bitcoin ${networkName}: ${satsToBtc(total.sats)} BTC`);
  }

  const message = [
    `:bank: *treasury summary* - ${day} (UTC)`,
    '',
    '*Balances*',
    ...(balanceLines.length > 0 ? balanceLines : ['- no wallets configured']),
    '',
    '*Refills, last 24h*',
    ...(activityLines.length > 0 ? activityLines : ['- none']),
  ].join('\n');

  console.log(message);

  if (!opts.post) {
    log('not posted (pass --post to send this to Slack)');
    return;
  }

  // --webhook-file wins, then SLACK_WEBHOOK_FILE, then SLACK_WEBHOOK_URL.
  const webhookUrl = opts.webhookFile
    ? resolveWebhook({ SLACK_WEBHOOK_FILE: opts.webhookFile }, 'SLACK_WEBHOOK_URL')
    : resolveWebhook(process.env, 'SLACK_WEBHOOK_URL');
  const state = readState(opts.state);

  if (!webhookUrl) {
    // Skip cleanly rather than fail, and log it once per day so the three daily
    // triggers do not repeat the same line.
    if (state.skipLoggedDay !== day) {
      log(
        'not posted: no webhook configured (set SLACK_WEBHOOK_URL, SLACK_WEBHOOK_FILE ' +
          'or pass --webhook-file)',
      );
      writeState(opts.state, { ...state, skipLoggedDay: day });
    }
    return;
  }

  if (!opts.force && state.lastPostedDay === day) {
    log(`summary already posted for ${day} (use --force to post again)`);
    return;
  }

  const notifier = createSlackNotifier({ webhookUrl, cooldownMs: 0, log });
  const result = await notifier.alert(`summary:${day}`, message);

  if (result === 'sent') {
    writeState(opts.state, { lastPostedDay: day, lastPostedAt: new Date().toISOString() });
    log(`summary posted to slack for ${day}`);
  } else if (result === 'failed') {
    // Leave the state file untouched so the next run retries.
    fail('slack post failed', 2);
  }
}

main().catch((err) => fail(err?.message ?? String(err), 2));
