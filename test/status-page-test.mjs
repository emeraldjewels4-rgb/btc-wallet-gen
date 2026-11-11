#!/usr/bin/env node
/**
 * Checks status-page.mjs end to end: it renders a treasury snapshot from an
 * audit log and live balances, and refuses to write a page that would carry a
 * secret to a public host.
 *
 * Run: npm run test:status
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(tmpdir(), 'status-page-test-audit.jsonl');
const OUT = join(tmpdir(), 'status-page-test-site', 'index.html');
const REFUSED_OUT = join(tmpdir(), 'status-page-test-site', 'refused.html');
const NO_PAGE_OUT = join(tmpdir(), 'status-page-test-site', 'never.html');
const PORT = 8549;

// BIP-173 test vector: a valid mainnet P2WPKH address.
const BTC_ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const EVM_ADDRESS = '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';
const EVM_RECENT = `0x${'ab'.repeat(32)}`;
const EVM_OLD = `0x${'ef'.repeat(32)}`;
const BTC_RECENT = 'cd'.repeat(32);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

const now = Date.now();
const recent = new Date(now - 60 * 1000).toISOString();
const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    let result = null;
    if (body.method === 'eth_getBalance') result = '0x1bc16d674ec80000'; // 2 ETH
    else if (body.method === 'eth_chainId') result = '0x1';
    else if (body.method === 'eth_blockNumber') result = '0x1';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    return;
  }

  if (/^\/address\/[^/]+\/utxo$/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ txid: 'ab'.repeat(32), vout: 0, value: 250000, status: { confirmed: true } }]));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

function runStatus(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['status-page.mjs', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        TREASURY_PRIVATE_KEY: '',
        BTC_TREASURY_WIF: '',
        SLACK_WEBHOOK_URL: '',
        ...envExtra,
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const wallets = [
  '--evm',
  `1:${EVM_ADDRESS}`,
  '--btc',
  `mainnet:${BTC_ADDRESS}`,
  '--evm-rpc',
  `http://127.0.0.1:${PORT}`,
  '--btc-api',
  `http://127.0.0.1:${PORT}`,
];

await new Promise((resolve) => api.listen(PORT, '127.0.0.1', resolve));

try {
  rmSync(OUT, { force: true });
  rmSync(REFUSED_OUT, { force: true });
  rmSync(NO_PAGE_OUT, { force: true });
  rmSync(AUDIT, { force: true });

  writeFileSync(
    AUDIT,
    [
      { ts: recent, chainId: 1, amountWei: '1000000000000000', txHash: EVM_RECENT, status: 'submitted' },
      {
        ts: recent,
        chainId: 1,
        amountWei: '1000000000000000',
        txHash: EVM_RECENT,
        status: 'confirmed',
        feeWei: '21000000000000',
      },
      {
        ts: recent,
        chain: 'bitcoin',
        network: 'mainnet',
        amountSats: 250000,
        feeSats: 1200,
        txid: BTC_RECENT,
        status: 'submitted',
      },
      {
        ts: recent,
        chain: 'bitcoin',
        network: 'mainnet',
        amountSats: 250000,
        feeSats: 1200,
        txid: BTC_RECENT,
        status: 'confirmed',
      },
      { ts: old, chainId: 1, amountWei: '1000000000000000', txHash: EVM_OLD, status: 'confirmed', feeWei: '21000000000000' },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  console.log('render');

  const render = await runStatus([
    ...wallets,
    '--audit',
    AUDIT,
    '--out',
    OUT,
    '--budget-eth',
    '0.05',
    '--budget-btc',
    '0.001',
  ]);

  check('exits 0', render.code === 0, render.out.trim().split('\n').pop());
  check('writes the page', existsSync(OUT));

  const html = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

  check('publishes the EVM balance', /2\s*<span>ETH<\/span>/.test(html), html.slice(0, 400));
  check('publishes the BTC balance', /0\.0025\s*<span>BTC<\/span>/.test(html));
  check('sums all-time ETH spend including fees', html.includes('0.002042 / 0.05 ETH'));
  check('sums all-time BTC spend including fees', html.includes('0.002512 / 0.001 BTC'));
  check('clamps an over-budget bar', html.includes('width:100%'));
  check('counts only the last 24h in the window', html.includes('>1</span> on ethereum:'));
  check('excludes the old refill from the window', !html.includes('>2</span> on ethereum:'));
  check('keeps the old refill in the all-time total', html.includes('0.002042'));

  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  check('dedupes submitted and confirmed lines', (body.match(/<tr>/g) ?? []).length === 3, `${(body.match(/<tr>/g) ?? []).length} rows`);

  check('ships no JavaScript', !/<script/i.test(html));
  check('uses no external assets', !/(src|href)="https?:/i.test(html));
  check('marks the page noindex', html.includes('content="noindex, nofollow"'));

  console.log('secret hygiene');

  const leaked = await runStatus(
    [...wallets, '--audit', AUDIT, '--out', REFUSED_OUT, '--title', `key 0x${'9f'.repeat(32)}`],
    {
      TREASURY_PRIVATE_KEY: `0x${'9f'.repeat(32)}`,
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/XXXXTEST',
    },
  );
  check('refuses a private key in the title', leaked.code === 3, `exit ${leaked.code}`);
  check('explains the refusal', /refusing to write the page/i.test(leaked.out));
  check('writes nothing when refused', !existsSync(REFUSED_OUT));

  const webhook = await runStatus(
    [...wallets, '--audit', AUDIT, '--out', REFUSED_OUT, '--title', 'x https://hooks.slack.com/services/T000/B000/XXXXTEST'],
    { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/XXXXTEST' },
  );
  check('refuses a Slack webhook URL', webhook.code === 3, `exit ${webhook.code}`);

  const xpub = await runStatus(
    [...wallets, '--audit', AUDIT, '--out', REFUSED_OUT, '--title', `x pub${'A'.repeat(60)}`],
  );
  check('allows ordinary prose that is not a key', xpub.code === 0 || xpub.code === 3);

  const hexes = [...html.matchAll(/0x[0-9a-fA-F]{64}/g)].map((match) => match[0].toLowerCase());
  check(
    'only audit transaction ids appear as 32-byte hex',
    hexes.every((hex) => hex === EVM_RECENT.toLowerCase() || hex === EVM_OLD.toLowerCase()),
    hexes.join(' '),
  );
  check('no webhook in the rendered page', !html.includes('hooks.slack.com'));
  check('no key material in the rendered page', !new RegExp('9f'.repeat(32)).test(html));

  console.log('args and failures');

  const markupTitle = await runStatus(['--audit', AUDIT, '--out', OUT, '--title', '<b>treasury</b>']);
  const escaped = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  check(
    'escapes a title with markup',
    markupTitle.code === 0 && escaped.includes('&lt;b&gt;treasury&lt;/b&gt;') && !escaped.includes('<b>'),
    `exit ${markupTitle.code}`,
  );

  const help = await runStatus(['--help']);
  check('--help exits 0', help.code === 0 && /Usage: node status-page\.mjs/.test(help.out));

  const missing = await runStatus(['--out']);
  check('a flag without a value fails', missing.code === 1, `exit ${missing.code}`);

  const badAddress = await runStatus(['--evm', '1:not-an-address']);
  check('rejects an invalid EVM address', badAddress.code === 1, `exit ${badAddress.code}`);

  const badBudget = await runStatus(['--budget-eth', 'plenty']);
  check('rejects a non-numeric budget', badBudget.code === 1, `exit ${badBudget.code}`);

  const zeroBudget = await runStatus(['--budget-btc', '0']);
  check('rejects a zero budget', zeroBudget.code === 1, `exit ${zeroBudget.code}`);

  const noWallets = await runStatus(['--audit', AUDIT, '--out', OUT]);
  check('renders without wallets', noWallets.code === 0, noWallets.out.trim().split('\n').pop());
  check('says balances are missing', readFileSync(OUT, 'utf8').includes('No wallets were supplied'));

  const deadRpc = await runStatus([
    '--evm',
    `1:${EVM_ADDRESS}`,
    '--evm-rpc',
    'http://127.0.0.1:1',
    '--audit',
    AUDIT,
    '--out',
    NO_PAGE_OUT,
  ]);
  check('fails when a balance cannot be read', deadRpc.code === 2, `exit ${deadRpc.code}`);
  check('writes nothing when a balance fails', !existsSync(NO_PAGE_OUT));

  const emptyAudit = await runStatus(['--audit', join(tmpdir(), 'status-page-test-missing.jsonl'), '--out', OUT]);
  check('renders with no audit log', emptyAudit.code === 0, emptyAudit.out.trim().split('\n').pop());
  check('says no refills were recorded', readFileSync(OUT, 'utf8').includes('No refills recorded yet'));
} finally {
  api.close();
  for (const path of [OUT, REFUSED_OUT, NO_PAGE_OUT, AUDIT]) rmSync(path, { force: true });
}

console.log('');
if (failures > 0) {
  console.log(`STATUS PAGE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log('STATUS PAGE TESTS PASSED');
