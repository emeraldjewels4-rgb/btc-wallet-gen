#!/usr/bin/env node
/**
 * Checks treasury-summary.mjs end to end against a fake JSON-RPC node, a fake
 * mempool.space API and a fake Slack webhook.
 *
 * Run: npm run test:summary
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { startFakeSlack } from './fake-slack.mjs';

const ECPair = ECPairFactory(ecc);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(tmpdir(), 'summary-test-audit.jsonl');
const STATE = join(tmpdir(), 'summary-test-state.json');
const ONE_ETH = '0xde0b6b3a7640000';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

const btcAddress = bitcoin.payments.p2wpkh({
  pubkey: ECPair.makeRandom({ network: bitcoin.networks.mainnet }).publicKey,
  network: bitcoin.networks.mainnet,
}).address;
const evmAddress = '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';

const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    let result = null;
    if (body.method === 'eth_getBalance') result = ONE_ETH;
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

function runSummary(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['treasury-summary.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, SLACK_WEBHOOK_URL: '', ...envExtra },
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

let slack = null;

try {
  rmSync(AUDIT, { force: true });
  rmSync(STATE, { force: true });

  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address();
  const apiBase = `http://127.0.0.1:${port}`;
  slack = await startFakeSlack();

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    AUDIT,
    [
      { ts: now, chainId: 1, chain: 'Ethereum', from: evmAddress, to: evmAddress, amountWei: '10000000000000000', txHash: `0x${'11'.repeat(32)}`, status: 'submitted' },
      { ts: now, chainId: 1, chain: 'Ethereum', from: evmAddress, to: evmAddress, amountWei: '10000000000000000', txHash: `0x${'11'.repeat(32)}`, status: 'confirmed' },
      { ts: now, chain: 'bitcoin', network: 'mainnet', from: btcAddress, to: btcAddress, amountSats: '50000', txid: '22'.repeat(32), status: 'confirmed' },
      { ts: old, chainId: 1, chain: 'Ethereum', from: evmAddress, to: evmAddress, amountWei: '9000000000000000000', txHash: `0x${'33'.repeat(32)}`, status: 'confirmed' },
      '',
    ].map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'),
  );

  const base = [
    '--evm', `1:${evmAddress}`,
    '--evm-rpc', apiBase,
    '--btc', `mainnet:${btcAddress}`,
    '--btc-api', apiBase,
    '--audit', AUDIT,
    '--state', STATE,
    '--day', '2026-11-10',
  ];

  console.log('== print only ==');
  let run = await runSummary(base);
  check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('reports the EVM balance', /: 1 ETH/.test(run.out), run.out);
  check('reports the BTC balance', /: 0\.0025 BTC/.test(run.out), run.out);
  check('reports 24h EVM spend once', /1 on ethereum \(1\): 0\.01 ETH/.test(run.out), run.out);
  check('reports 24h BTC spend', /1 on bitcoin mainnet: 0\.0005 BTC/.test(run.out), run.out);
  check('excludes activity older than 24h', !/9 ETH/.test(run.out), run.out);
  check('posts nothing without --post', slack.messages.length === 0, String(slack.messages.length));

  console.log('\n== posting ==');
  run = await runSummary([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('posting exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('one message posted', slack.messages.length === 1, String(slack.messages.length));
  check('message is the summary', /treasury summary/.test(slack.messages[0]?.text ?? '') && /Balances/.test(slack.messages[0]?.text ?? ''));
  check('message carries the balances', /1 ETH/.test(slack.messages[0]?.text ?? '') && /0\.0025 BTC/.test(slack.messages[0]?.text ?? ''));
  check('state file records the day', existsSync(STATE) && JSON.parse(readFileSync(STATE, 'utf8')).lastPostedDay === '2026-11-10');

  console.log('\n== once per day ==');
  run = await runSummary([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('second run exits 0', run.code === 0, `exit ${run.code}`);
  check('second run says already posted', /already posted/.test(run.out), run.out.trim());
  check('no duplicate message', slack.messages.length === 1, String(slack.messages.length));

  run = await runSummary([...base, '--post', '--force'], { SLACK_WEBHOOK_URL: slack.url });
  check('--force posts again', run.code === 0 && slack.messages.length === 2, `exit ${run.code}, messages ${slack.messages.length}`);

  console.log('\n== no-webhook skip logs once per day ==');
  const skipState = join(tmpdir(), `summary-test-skip-${Date.now()}.json`);
  run = await runSummary([...base, '--post', '--state', skipState]);
  const skipFirst = run.out;
  check('first skip exits 0 and explains why', run.code === 0 && /no webhook configured/.test(skipFirst), skipFirst.trim());

  run = await runSummary([...base, '--post', '--state', skipState]);
  check('second skip exits 0', run.code === 0, `exit ${run.code}`);
  check('second skip logs nothing', !/no webhook configured/.test(run.out), run.out.trim());
  check(
    'skip state records the day',
    existsSync(skipState) && typeof JSON.parse(readFileSync(skipState, 'utf8')).skipLoggedDay === 'string',
  );

  console.log('\n== errors ==');
  run = await runSummary([...base, '--post']);
  check('--post without a webhook exits 0 (clean skip)', run.code === 0, `exit ${run.code}`);
  check(
    'skip names the missing configuration',
    /no webhook configured/.test(run.out) && /SLACK_WEBHOOK_URL/.test(run.out),
    run.out.trim(),
  );

  run = await runSummary(['--evm', '1:not-an-address', '--evm-rpc', apiBase]);
  check('invalid EVM address rejected', run.code === 1, `exit ${run.code}`);

  run = await runSummary(['--btc', `mainnet:${ecPairTestnetAddress()}`]);
  check('wrong-network BTC address rejected', run.code === 1, `exit ${run.code}`);

  run = await runSummary([]);
  check('no wallets is a usage error', run.code === 1, `exit ${run.code}`);

  if (failures > 0) {
    console.error(`\nSUMMARY TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nSUMMARY TESTS PASSED');
  }
} finally {
  await new Promise((resolve) => api.close(resolve));
  await slack?.close();
  rmSync(AUDIT, { force: true });
  rmSync(STATE, { force: true });
}

function ecPairTestnetAddress() {
  return bitcoin.payments.p2wpkh({
    pubkey: ECPair.makeRandom({ network: bitcoin.networks.testnet }).publicKey,
    network: bitcoin.networks.testnet,
  }).address;
}
