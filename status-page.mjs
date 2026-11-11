#!/usr/bin/env node
/**
 * Render a public, read-only treasury status page.
 *
 * Reads the refill audit log and, optionally, live public balances for wallets
 * named on the command line, then writes one self-contained HTML file: no
 * scripts, no external assets, no keys. That file is the only thing meant for a
 * web host's public directory.
 *
 * You are publishing this. It contains treasury addresses, amounts and
 * transaction ids, which are public chain data - but never point --out at a
 * folder that also holds .env, the audit log or the wallet bundle, and never
 * pass an RPC URL that carries an API key.
 *
 * Usage:
 *   node status-page.mjs --evm 1:0xTREASURY --btc mainnet:bc1q... \
 *     --budget-eth 0.05 --budget-btc 0.001 --out site/index.html
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { createPublicClient, http, isAddress, parseUnits } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon, sepolia } from 'viem/chains';
import { formatUnits, shortRef } from './rollup.mjs';

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
const OUT_DEFAULT = 'site/index.html';
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ROWS = 8;

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node status-page.mjs [wallets] [options]

Wallets (repeatable, read-only - no keys needed):
  --evm CHAIN_ID:ADDRESS   EVM treasury balance to publish, e.g. 1:0xabc...
  --btc NETWORK:ADDRESS    Bitcoin treasury balance to publish, e.g. mainnet:bc1q...

Options:
  --audit PATH             refill audit log to summarise (default ${AUDIT_DEFAULT})
  --out PATH               HTML file to write (default ${OUT_DEFAULT})
  --title TEXT             page heading (default "Treasury status")
  --budget-eth AMOUNT      all-time EVM refill budget, e.g. 0.05
  --budget-btc AMOUNT      all-time Bitcoin refill budget, e.g. 0.001
  --evm-rpc URL            RPC endpoint for all EVM wallets (default: chain RPC)
  --btc-api URL            mempool.space-compatible endpoint for BTC wallets
  -h, --help               show this help

The page is a static snapshot: no JavaScript, no external assets, no keys, and
no webhook URLs. Re-run this script to refresh it, then upload only the
generated file.

Exit codes: 0 ok, 1 usage error, 2 runtime error, 3 refused (output would leak
something that must never be published).`);
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
    out: OUT_DEFAULT,
    title: 'Treasury status',
    budgetEth: null,
    budgetBtc: null,
    evmRpc: null,
    btcApi: null,
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
    } else if (arg === '--out') {
      opts.out = next();
    } else if (arg === '--title') {
      opts.title = next();
    } else if (arg === '--budget-eth') {
      opts.budgetEth = parseBudget(next(), '--budget-eth', 18);
    } else if (arg === '--budget-btc') {
      opts.budgetBtc = parseBudget(next(), '--budget-btc', 8);
    } else if (arg === '--evm-rpc') {
      opts.evmRpc = next();
    } else if (arg === '--btc-api') {
      opts.btcApi = next().replace(/\/+$/, '');
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

function parseBudget(raw, flag, decimals) {
  if (!/^\d+(\.\d+)?$/.test(raw)) fail(`${flag} expects a positive decimal amount, got "${raw}"`);
  const value = parseUnits(raw, decimals);
  if (value <= 0n) fail(`${flag} must be greater than zero`);
  return value;
}

// An RPC URL can carry an API key, so error text is reduced to the host before
// it is printed anywhere.
function scrub(message) {
  return String(message).replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '<url>';
    }
  });
}

// One record per transaction: the refill tools log a submitted and a confirmed
// line, and only the confirmed one carries the EVM gas fee.
function readEntries(auditPath) {
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
    if (!Number.isFinite(ts)) continue;

    const isBitcoin = entry.chain === 'bitcoin';
    const bucketKey = isBitcoin ? `btc:${entry.network}` : `evm:${entry.chainId}`;
    const txKey = isBitcoin
      ? `btc:${entry.network}:${entry.txid}`
      : `evm:${entry.chainId}:${entry.txHash}`;
    const rawFee = isBitcoin ? entry.feeSats : entry.feeWei;
    const fee = rawFee === undefined || rawFee === null ? null : BigInt(rawFee);

    const existing = byTx.get(txKey);
    if (existing) {
      if (existing.fee === null && fee !== null) existing.fee = fee;
      if (entry.status === 'confirmed') existing.confirmed = true;
      if (ts < existing.ts) existing.ts = ts;
      continue;
    }

    byTx.set(txKey, {
      bucketKey,
      label: isBitcoin
        ? `bitcoin ${entry.network}`
        : `${String(CHAINS.get(entry.chainId)?.name ?? `chain ${entry.chainId}`).toLowerCase()}`,
      unit: isBitcoin ? 'BTC' : 'ETH',
      decimals: isBitcoin ? 8 : 18,
      amount: BigInt(isBitcoin ? entry.amountSats : entry.amountWei),
      fee,
      ts,
      ref: isBitcoin ? entry.txid : entry.txHash,
      confirmed: entry.status === 'confirmed',
    });
  }
  return [...byTx.values()];
}

function totalBy(entries, key, unit) {
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry[key]) ?? {
      label: entry.label,
      unit,
      count: 0,
      total: 0n,
      feeTotal: 0n,
      feeUnknown: 0,
    };
    bucket.count += 1;
    bucket.total += entry.amount;
    if (entry.fee === null) bucket.feeUnknown += 1;
    else bucket.feeTotal += entry.fee;
    buckets.set(entry[key], bucket);
  }
  return [...buckets.values()];
}

async function evmBalance(entry, rpcUrl) {
  const [chainPart, address] = splitOnce(entry, ':');
  const chainId = Number(chainPart);
  const chain = CHAINS.get(chainId);
  if (!chain) fail(`unsupported EVM chain id "${chainPart}" (supported: ${[...CHAINS.keys()].join(', ')})`);
  if (!address || !isAddress(address)) fail(`--evm expects CHAIN_ID:0xADDRESS, got "${entry}"`);

  const client = createPublicClient({ chain, transport: http(rpcUrl ?? undefined) });
  try {
    const wei = await client.getBalance({ address });
    return {
      label: `${chain.name.toLowerCase()} (${chain.id})`,
      address,
      amount: formatUnits(wei, 18),
      unit: 'ETH',
    };
  } catch (err) {
    fail(`could not read the balance of ${address} on ${chain.name}: ${scrub(err?.message ?? err)}`, 2);
  }
}

async function btcBalance(entry, apiUrl) {
  const [networkName, address] = splitOnce(entry, ':');
  const net = BTC_NETWORKS[networkName];
  if (!net) fail(`unsupported bitcoin network "${networkName}" (use mainnet or testnet)`);
  if (!address) fail(`--btc expects NETWORK:ADDRESS, got "${entry}"`);
  try {
    bitcoin.address.toOutputScript(address, net.network);
  } catch {
    fail(`--btc address "${address}" is not valid on ${networkName}`);
  }

  const api = apiUrl ?? net.api;
  try {
    const res = await fetch(`${api}/address/${address}/utxo`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) fail(`GET /address/${address}/utxo -> HTTP ${res.status}`, 2);
    const utxos = await res.json();
    const sats = utxos
      .filter((utxo) => utxo.status?.confirmed)
      .reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);
    return { label: `bitcoin ${networkName}`, address, amount: formatUnits(sats, 8), unit: 'BTC' };
  } catch (err) {
    fail(`could not read the balance of ${address} on bitcoin ${networkName}: ${scrub(err?.message ?? err)}`, 2);
  }
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

// Long fractions are noise on a status page; keep six decimals.
function compact(amount, decimals) {
  const text = formatUnits(amount, decimals);
  const [whole, fraction] = text.split('.');
  if (!fraction || fraction.length <= 6) return text;
  const trimmed = fraction.slice(0, 6).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function percent(part, whole) {
  if (whole === null || whole <= 0n) return null;
  return Math.max(0, Math.min(100, Number((part * 10000n) / whole) / 100));
}

function balanceCards(balances) {
  if (balances.length === 0) {
    return '<p class="empty">No wallets were supplied, so this snapshot shows activity only.</p>';
  }
  return `<div class="cards">${balances
    .map(
      (row) => `<article class="card">
        <p class="label">${esc(row.label)}</p>
        <p class="value num">${esc(row.amount)} <span>${esc(row.unit)}</span></p>
        <p class="addr num">${esc(row.address)}</p>
      </article>`,
    )
    .join('')}</div>`;
}

function budgetRows(evm, btc) {
  const rows = [];
  for (const bucket of evm) {
    const spent = bucket.total + bucket.feeTotal;
    const pct = percent(spent, evm.budget ?? null);
    rows.push({ label: 'ETH spent, all time', spent, budget: evm.budget, unit: 'ETH', decimals: 18, pct });
  }
  for (const bucket of btc) {
    const spent = bucket.total + bucket.feeTotal;
    const pct = percent(spent, btc.budget ?? null);
    rows.push({ label: 'BTC spent, all time', spent, budget: btc.budget, unit: 'BTC', decimals: 8, pct });
  }
  return rows
    .map((row) => {
      const head = row.budget
        ? `${compact(row.spent, row.decimals)} / ${compact(row.budget, row.decimals)} ${row.unit}`
        : `${compact(row.spent, row.decimals)} ${row.unit} (no budget set)`;
      const bar =
        row.pct === null
          ? ''
          : `<div class="bar"><i style="width:${row.pct}%"></i></div>`;
      return `<div class="row"><div class="row-head"><span>${esc(row.label)}</span><span class="num">${esc(head)}</span></div>${bar}</div>`;
    })
    .join('');
}

function windowList(windowEntries) {
  if (windowEntries.length === 0) return '<p class="empty">No refills in the last 24 hours.</p>';
  const evm = totalBy(windowEntries.filter((entry) => entry.unit === 'ETH'), 'bucketKey', 'ETH');
  const btc = totalBy(windowEntries.filter((entry) => entry.unit === 'BTC'), 'bucketKey', 'BTC');
  return `<ul class="chips">${[...evm, ...btc]
    .map(
      (bucket) =>
        `<li><span class="num">${bucket.count}</span> on ${esc(bucket.label)}: <span class="num">${esc(compact(bucket.total, bucket.unit === 'BTC' ? 8 : 18))} ${bucket.unit}</span></li>`,
    )
    .join('')}</ul>`;
}

function recentTable(rows) {
  if (rows.length === 0) return '<p class="empty">No refills recorded yet.</p>';
  return `<div class="scroll"><table>
    <thead><tr><th>when (UTC)</th><th>treasury</th><th>amount</th><th>fee</th><th>transaction</th></tr></thead>
    <tbody>${rows
      .map((row) => {
        const when = esc(new Date(row.ts).toISOString().slice(0, 16).replace('T', ' '));
        const fee = row.fee === null ? 'not recorded' : `${esc(compact(row.fee, row.decimals))} ${row.unit}`;
        const pending = row.confirmed ? '' : ' <span class="tag">pending</span>';
        return `<tr>
          <td class="num">${when}</td>
          <td>${esc(row.label)}</td>
          <td class="num">${esc(compact(row.amount, row.decimals))} ${row.unit}${pending}</td>
          <td class="num">${fee}</td>
          <td class="num ref">${esc(shortRef(row.ref))}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

function buildHtml({ title, generatedAt, balances, evmSpend, btcSpend, evmBudget, btcBudget, windowEntries, recent }) {
  const evm = evmSpend.map((bucket) => bucket);
  const btc = btcSpend.map((bucket) => bucket);
  evm.budget = evmBudget;
  btc.budget = btcBudget;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --panel: #151b23;
    --line: #232b36;
    --ink: #e6edf3;
    --muted: #8b949e;
    --accent: #4cc38a;
    --amber: #d29922;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 60rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1.5rem; margin-bottom: 2rem; }
  .kicker {
    margin: 0 0 .5rem;
    font-size: .72rem;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 { margin: 0 0 .5rem; font-size: clamp(1.6rem, 4vw, 2.2rem); font-weight: 600; letter-spacing: -.01em; }
  .generated { margin: 0; color: var(--muted); font-size: .9rem; }
  section { margin: 0 0 2.25rem; }
  h2 {
    margin: 0 0 .9rem;
    font-size: .75rem;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
  }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 1rem 1.1rem;
  }
  .card .label { margin: 0 0 .35rem; font-size: .8rem; color: var(--muted); }
  .card .value { margin: 0 0 .4rem; font-size: 1.55rem; letter-spacing: -.01em; }
  .card .value span { font-size: .85rem; color: var(--muted); }
  .card .addr { margin: 0; font-size: .74rem; color: var(--muted); word-break: break-all; }
  .row { margin-bottom: 1rem; }
  .row-head { display: flex; justify-content: space-between; gap: 1rem; font-size: .88rem; margin-bottom: .4rem; }
  .row-head span:first-child { color: var(--muted); }
  .bar { height: 6px; background: #1f2731; border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
  .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  .chips li {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: .35rem .8rem;
    font-size: .85rem;
  }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .6rem .8rem; white-space: nowrap; }
  thead th { background: var(--panel); color: var(--muted); font-weight: 600; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
  tbody tr + tr td { border-top: 1px solid var(--line); }
  .ref { color: var(--muted); }
  .tag {
    display: inline-block;
    margin-left: .35rem;
    font-size: .68rem;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 4px;
    padding: 0 .3rem;
    vertical-align: .08em;
  }
  .empty { margin: 0; color: var(--muted); font-size: .9rem; }
  footer { border-top: 1px solid var(--line); padding-top: 1rem; color: var(--muted); font-size: .78rem; }
  footer p { margin: 0 0 .3rem; }
</style>
</head>
<body>
<main>
  <header>
    <p class="kicker">read-only snapshot</p>
    <h1>${esc(title)}</h1>
    <p class="generated">Generated ${esc(generatedAt)} UTC. Static page: refreshed by re-running the exporter, not live.</p>
  </header>

  <section>
    <h2>Treasury balances</h2>
    ${balanceCards(balances)}
  </section>

  <section>
    <h2>Spend against budget</h2>
    ${budgetRows(evm, btc) || '<p class="empty">No refills recorded yet.</p>'}
  </section>

  <section>
    <h2>Refills, last 24 hours</h2>
    ${windowList(windowEntries)}
  </section>

  <section>
    <h2>Recent refills</h2>
    ${recentTable(recent)}
  </section>

  <footer>
    <p>Balances read from public endpoints; amounts and transaction ids come from the local refill audit log.</p>
    <p>This page contains no keys, seed phrases, wallet descriptors or webhook URLs.</p>
  </footer>
</main>
</body>
</html>
`;
}

// Published output is scanned before it is written. Anything resembling a
// secret stops the export, and every 32-byte hex value must be a transaction id
// that is already in the audit log.
const FORBIDDEN = [
  [/hooks\.slack\.com/i, 'a Slack webhook URL'],
  [/\b(?:xprv|tprv|xpub|tpub)[0-9A-Za-z]{20,}/, 'a wallet extended key'],
  [/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/, 'a Bitcoin WIF key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a PEM private key'],
];

const SECRET_ENV = [
  'TREASURY_PRIVATE_KEY',
  'BTC_TREASURY_WIF',
  'SLACK_WEBHOOK_URL',
  'SLACK_ALERT_WEBHOOK_URL',
  'SLACK_WARNING_WEBHOOK_URL',
];

function assertPublishable(html, allowedRefs) {
  const problems = [];

  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(html)) problems.push(what);
  }

  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 16 && html.includes(value)) problems.push(`the value of ${name}`);
  }

  for (const match of html.matchAll(/0x[0-9a-fA-F]{64}/g)) {
    if (!allowedRefs.has(match[0].toLowerCase())) {
      problems.push(`an unexplained 32-byte value (${shortRef(match[0])})`);
    }
  }

  if (problems.length > 0) {
    fail(
      `refusing to write the page: the output would contain ${[...new Set(problems)].join(', ')}. ` +
        'Nothing was written.',
      3,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const balances = [];
  for (const entry of opts.evm) balances.push(await evmBalance(entry, opts.evmRpc));
  for (const entry of opts.btc) balances.push(await btcBalance(entry, opts.btcApi));

  const entries = readEntries(opts.audit);
  const windowEntries = entries.filter((entry) => entry.ts >= now - DAY_MS);
  const recent = [...entries].sort((a, b) => b.ts - a.ts).slice(0, RECENT_ROWS);

  const html = buildHtml({
    title: opts.title,
    generatedAt: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
    balances,
    evmSpend: totalBy(entries.filter((entry) => entry.unit === 'ETH'), 'bucketKey', 'ETH'),
    btcSpend: totalBy(entries.filter((entry) => entry.unit === 'BTC'), 'bucketKey', 'BTC'),
    evmBudget: opts.budgetEth,
    btcBudget: opts.budgetBtc,
    windowEntries,
    recent,
  });

  assertPublishable(html, new Set(entries.map((entry) => String(entry.ref).toLowerCase())));

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, html);
  log(
    `wrote ${opts.out} (${html.length} bytes, ${balances.length} balances, ` +
      `${entries.length} refills total, ${windowEntries.length} in the last 24h)`,
  );
  log('upload only this file to the public web root');
}

main().catch((err) => fail(scrub(err?.message ?? err), 2));
