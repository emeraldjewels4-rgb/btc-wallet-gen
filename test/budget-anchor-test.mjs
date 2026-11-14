#!/usr/bin/env node
/**
 * Checks the spend anchor in refill.mjs: the highest total per chain is recorded
 * beside the audit log, a log that shrank is refused instead of reading as zero
 * spent, and a log that grew re-anchors upward.
 *
 * The runs point at an unreachable RPC on purpose. Exit 2 means the run got past
 * the anchor check and only then failed to reach a node; exit 3 means the anchor
 * stopped it - before any network call.
 *
 * Run: npm run test:anchor
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { generatePrivateKey } from 'viem/accounts';
import { encode as encodeWif } from 'wif';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';
const TS = '2026-01-01T00:00:00.000Z';
const ECPair = ECPairFactory(ecc);
const UNREACHABLE = 'http://127.0.0.1:1';
const KY = generatePrivateKey();
const DIR = mkdtempSync(join(tmpdir(), 'treasury-anchor-'));
const AUDIT = join(DIR, 'refill-audit.jsonl');
const ANCHOR = `${AUDIT}.state.json`;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

const txHash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

function entry(n, amountWei) {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    chainId: 1,
    chain: 'Ethereum',
    from: '0x1111111111111111111111111111111111111111',
    to: TARGET,
    amountWei,
    txHash: txHash(n),
    status: 'confirmed',
  };
}

// entries: [txNumber, amountWei]
function seedLog(entries) {
  writeFileSync(AUDIT, entries.map(([n, amountWei]) => `${JSON.stringify(entry(n, amountWei))}\n`).join(''));
}

function anchorState() {
  try {
    return JSON.parse(readFileSync(ANCHOR, 'utf8'));
  } catch {
    return null;
  }
}

function anchoredSpend(chainId = '1') {
  return anchorState()?.chains?.[chainId];
}

function runTool(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, SLACK_WEBHOOK_URL: '', ...env },
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

function run(extra = []) {
  return runTool(
    'refill.mjs',
    ['--to', TARGET, '--amount', '0.001', '--audit', AUDIT, '--rpc', UNREACHABLE, ...extra],
    { TREASURY_PRIVATE_KEY: KY },
  );
}

try {
  console.log('== a first run adopts the log it finds ==');
  seedLog([
    [1, '5000000000000000'],
    [2, '4000000000000000'],
  ]);
  check('no anchor exists before the first run', !existsSync(ANCHOR));
  let result = await run();
  check('the first run is not refused', result.code === 2 && !/REFUSING/.test(result.out), `exit ${result.code}: ${result.out.trim()}`);
  check('the anchor is created', existsSync(ANCHOR));
  check('the anchor records the log total', anchoredSpend() === '9000000000000000', String(anchoredSpend()));
  check(
    'the first run still makes no audit entry of its own',
    readFileSync(AUDIT, 'utf8').trim().split('\n').length === 2,
  );
  check('the anchor holds no key material', !/0x[0-9a-fA-F]{64}/.test(readFileSync(ANCHOR, 'utf8')));

  console.log('\n== a deleted log is refused, not handed back ==');
  rmSync(AUDIT);
  result = await run();
  check('a deleted log exits 3', result.code === 3, `exit ${result.code}`);
  check('the refusal names the anchor file', result.out.includes(ANCHOR), result.out.trim());
  check('the refusal says the log does not balance', /accounts for only 0 ETH/.test(result.out), result.out.trim());
  check('the refusal reports what is missing', /missing 0\.009 ETH/.test(result.out), result.out.trim());
  check('the refusal is tagged as an anchor mismatch', /rule audit-mismatch/.test(result.out), result.out.trim());
  check(
    'the refusal happens before any RPC call',
    !/ECONNREFUSED|fetch failed|cannot reach/i.test(result.out),
    result.out.trim(),
  );
  check('the deleted log is not recreated', !existsSync(AUDIT));
  check('the anchor still holds the original total', anchoredSpend() === '9000000000000000', String(anchoredSpend()));

  console.log('\n== a truncated log is refused too ==');
  seedLog([[1, '5000000000000000']]);
  result = await run();
  check('a log missing one transaction exits 3', result.code === 3, `exit ${result.code}`);
  check('the missing amount is reported', /missing 0\.004 ETH/.test(result.out), result.out.trim());

  console.log('\n== a growing log is accepted and re-anchors ==');
  seedLog([
    [1, '5000000000000000'],
    [2, '4000000000000000'],
    [3, '2000000000000000'],
  ]);
  result = await run();
  check('a log that grew is accepted', result.code === 2 && !/REFUSING/.test(result.out), `exit ${result.code}`);
  check('the anchor moves up with the log', anchoredSpend() === '11000000000000000', String(anchoredSpend()));

  console.log('\n== a corrupt anchor is refused ==');
  writeFileSync(ANCHOR, '{"chains":');
  result = await run();
  check('an unreadable anchor exits 3', result.code === 3, `exit ${result.code}`);
  check('the refusal says the anchor cannot be used', /cannot be used/.test(result.out), result.out.trim());
  check('the refusal explains how to recover', /delete it to re-anchor/.test(result.out), result.out.trim());

  writeFileSync(ANCHOR, JSON.stringify({ chains: { 1: 'not-a-number' } }));
  result = await run();
  check('an anchor with a non-numeric total is refused', result.code === 3, `exit ${result.code}`);
  check('the refusal says the anchor cannot be used', /cannot be used/.test(result.out), result.out.trim());

  console.log('\n== a dry run is gated the same way ==');
  writeFileSync(ANCHOR, `${JSON.stringify({ chains: { 1: '99000000000000000' } }, null, 2)}\n`);
  result = await run();
  check('a dry run is refused when the ledger does not balance', result.code === 3, `exit ${result.code}`);
  check('the missing amount is reported', /missing 0\.088 ETH/.test(result.out), result.out.trim());
  check('the refused run prints no transaction plan', !/send\s+0\.001 ETH/.test(result.out), result.out.trim());

  console.log('\n== the anchor is per chain ==');
  result = await run(['--chain', '11155111']);
  check('another chain is not blocked by chain 1', result.code === 2 && !/REFUSING/.test(result.out), `exit ${result.code}`);
  check(
    'the anchor keeps a total per chain',
    Object.keys(anchorState()?.chains ?? {}).sort().join(',') === '1,11155111',
    JSON.stringify(Object.keys(anchorState()?.chains ?? {})),
  );

  console.log('\n== deleting the anchor deliberately re-anchors ==');
  rmSync(ANCHOR);
  result = await run();
  check('a run after an anchor reset proceeds', result.code === 2 && !/REFUSING/.test(result.out), `exit ${result.code}`);
  check('the anchor is rebuilt from the log', anchoredSpend() === '11000000000000000', String(anchoredSpend()));

  console.log('\n== btc-refill.mjs is guarded too ==');
  const btcAudit = join(DIR, 'btc-audit.jsonl');
  const btcAnchor = `${btcAudit}.state.json`;
  const treasuryPair = ECPair.fromPrivateKey(randomBytes(32), { network: bitcoin.networks.bitcoin });
  const targetPair = ECPair.fromPrivateKey(randomBytes(32), { network: bitcoin.networks.bitcoin });
  const btcAddress = bitcoin.payments.p2wpkh({
    pubkey: targetPair.publicKey,
    network: bitcoin.networks.bitcoin,
  }).address;
  const btcWif = encodeWif({ version: 0x80, privateKey: treasuryPair.privateKey, compressed: true });
  writeFileSync(
    btcAudit,
    `${JSON.stringify({
      ts: TS,
      chain: 'bitcoin',
      network: 'mainnet',
      from: treasuryPair.publicKey.toString('hex'),
      to: btcAddress,
      amountSats: '50000',
      feeSats: '200',
      txid: 'a'.repeat(64),
      status: 'confirmed',
    })}\n`,
  );
  const btcRun = () =>
    runTool(
      'btc-refill.mjs',
      ['--to', btcAddress, '--amount', '0.0005', '--fee-rate', '5', '--api', UNREACHABLE, '--audit', btcAudit],
      { BTC_TREASURY_WIF: btcWif },
    );

  let btc = await btcRun();
  check('btc: a first run is not refused', btc.code === 2 && !/REFUSING/.test(btc.out), `exit ${btc.code}: ${btc.out.trim()}`);
  check('btc: the anchor is written beside its log', existsSync(btcAnchor));
  check(
    'btc: the anchor records the sats total',
    JSON.parse(readFileSync(btcAnchor, 'utf8')).chains?.mainnet === '50000',
    readFileSync(btcAnchor, 'utf8').trim(),
  );

  rmSync(btcAudit);
  btc = await btcRun();
  check('btc: a deleted log exits 3', btc.code === 3, `exit ${btc.code}`);
  check(
    'btc: the refusal reports the missing sats',
    /accounts for only 0 BTC/.test(btc.out) && /missing 0\.0005 BTC/.test(btc.out),
    btc.out.trim(),
  );
  check('btc: the refusal is tagged as an anchor mismatch', /rule audit-mismatch/.test(btc.out), btc.out.trim());
  check('btc: the deleted log is not recreated', !existsSync(btcAudit));
  check(
    'btc: the refusal happens before any network call',
    !/cannot reach|ECONNREFUSED|fetch failed/i.test(btc.out),
    btc.out.trim(),
  );

  console.log('\n== btc-refill.mjs refuses an unusable anchor ==');
  // Re-seed a log that matches nothing, so the only fault left is the anchor.
  writeFileSync(
    btcAudit,
    `${JSON.stringify({ ts: TS, chain: 'bitcoin', network: 'mainnet', amountSats: '50000', txid: 'a'.repeat(64), status: 'confirmed' })}\n`,
  );
  writeFileSync(btcAnchor, '{"chains":');
  btc = await btcRun();
  check('btc: an unreadable anchor exits 3', btc.code === 3, `exit ${btc.code}`);
  check('btc: the refusal says the anchor cannot be used', /cannot be used/.test(btc.out), btc.out.trim());
  check(
    'btc: the refusal names that tool\'s own log',
    btc.out.includes(btcAudit) && btc.out.includes(btcAnchor),
    btc.out.trim(),
  );
  check(
    'btc: the refusal explains how to recover',
    /restore it, or delete it to re-anchor from/.test(btc.out),
    btc.out.trim(),
  );
  check('btc: a refused anchor is left alone', readFileSync(btcAnchor, 'utf8') === '{"chains":');

  writeFileSync(btcAnchor, JSON.stringify({ chains: { mainnet: 'not-a-number' } }));
  btc = await btcRun();
  check('btc: a non-numeric total exits 3', btc.code === 3, `exit ${btc.code}`);
  check('btc: that refusal says the anchor cannot be used', /cannot be used/.test(btc.out), btc.out.trim());

  // The log (50000 sats from the seed above) now outruns an older anchor.
  writeFileSync(btcAnchor, JSON.stringify({ chains: { mainnet: '10000' } }));
  btc = await btcRun();
  check('btc: a log that grew is accepted', btc.code === 2 && !/REFUSING/.test(btc.out), `exit ${btc.code}`);
  check(
    'btc: the anchor moves up with the log',
    JSON.parse(readFileSync(btcAnchor, 'utf8')).chains?.mainnet === '50000',
    readFileSync(btcAnchor, 'utf8').trim(),
  );

  console.log('\n== sepolia-call.mjs is guarded too ==');
  const sepAudit = join(DIR, 'sepolia-audit.jsonl');
  const sepAnchor = `${sepAudit}.state.json`;
  writeFileSync(
    sepAudit,
    `${JSON.stringify({
      ts: TS,
      chainId: 11155111,
      chain: 'Sepolia',
      from: TARGET,
      to: TARGET,
      valueWei: '1000000000000000',
      txHash: `0x${'b'.repeat(64)}`,
      status: 'confirmed',
    })}\n`,
  );
  const sepRun = () =>
    runTool(
      'sepolia-call.mjs',
      ['--to', TARGET, '--data', '0xdeadbeef', '--audit', sepAudit, '--rpc', UNREACHABLE],
      { TREASURY_PRIVATE_KEY: KY },
    );

  let sep = await sepRun();
  check('sepolia: a first run is not refused', sep.code === 2 && !/REFUSING/.test(sep.out), `exit ${sep.code}: ${sep.out.trim()}`);
  check('sepolia: the anchor is written beside its log', existsSync(sepAnchor));
  check(
    'sepolia: the anchor records the wei total',
    JSON.parse(readFileSync(sepAnchor, 'utf8')).chains?.['11155111'] === '1000000000000000',
    readFileSync(sepAnchor, 'utf8').trim(),
  );

  rmSync(sepAudit);
  sep = await sepRun();
  check('sepolia: a deleted log exits 3', sep.code === 3, `exit ${sep.code}`);
  check(
    'sepolia: the refusal reports the missing ether',
    /accounts for only 0 ETH/.test(sep.out) && /missing 0\.001 ETH/.test(sep.out),
    sep.out.trim(),
  );
  check('sepolia: the refusal is tagged as an anchor mismatch', /rule audit-mismatch/.test(sep.out), sep.out.trim());
  check('sepolia: the deleted log is not recreated', !existsSync(sepAudit));
  check(
    'sepolia: the refusal happens before any network call',
    !/cannot reach|ECONNREFUSED|fetch failed/i.test(sep.out),
    sep.out.trim(),
  );

  console.log('\n== sepolia-call.mjs refuses an unusable anchor ==');
  writeFileSync(
    sepAudit,
    `${JSON.stringify({ ts: TS, chainId: 11155111, valueWei: '1000000000000000', txHash: `0x${'b'.repeat(64)}`, status: 'confirmed' })}\n`,
  );
  writeFileSync(sepAnchor, '{"chains":');
  sep = await sepRun();
  check('sepolia: an unreadable anchor exits 3', sep.code === 3, `exit ${sep.code}`);
  check('sepolia: the refusal says the anchor cannot be used', /cannot be used/.test(sep.out), sep.out.trim());
  check(
    'sepolia: the refusal names that tool\'s own log',
    sep.out.includes(sepAudit) && sep.out.includes(sepAnchor),
    sep.out.trim(),
  );
  check(
    'sepolia: the refusal explains how to recover',
    /restore it, or delete it to re-anchor from/.test(sep.out),
    sep.out.trim(),
  );
  check('sepolia: a refused anchor is left alone', readFileSync(sepAnchor, 'utf8') === '{"chains":');

  writeFileSync(sepAnchor, JSON.stringify({ chains: { 11155111: 'not-a-number' } }));
  sep = await sepRun();
  check('sepolia: a non-numeric total exits 3', sep.code === 3, `exit ${sep.code}`);
  check('sepolia: that refusal says the anchor cannot be used', /cannot be used/.test(sep.out), sep.out.trim());

  // The log (0.001 ETH from the seed above) now outruns an older anchor.
  writeFileSync(sepAnchor, JSON.stringify({ chains: { 11155111: '500000000000000' } }));
  sep = await sepRun();
  check('sepolia: a log that grew is accepted', sep.code === 2 && !/REFUSING/.test(sep.out), `exit ${sep.code}`);
  check(
    'sepolia: the anchor moves up with the log',
    JSON.parse(readFileSync(sepAnchor, 'utf8')).chains?.['11155111'] === '1000000000000000',
    readFileSync(sepAnchor, 'utf8').trim(),
  );

  if (failures > 0) {
    console.error(`\nANCHOR TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nANCHOR TESTS PASSED');
  }
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
