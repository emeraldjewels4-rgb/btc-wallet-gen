#!/usr/bin/env node
/**
 * Checks sepolia-call.mjs against a local Ganache node pinned to chain 11155111.
 *
 * Covers the dry-run default, both caps, the wrong-chain refusal, calldata
 * limits, and a real signed transaction whose payload is verified on chain and
 * in the audit log (as a hash, not raw bytes).
 *
 * Run: npm run test:sepolia-call
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, defineChain, formatEther, getAddress, http, keccak256 } from 'viem';
import { startFakeSlack } from './fake-slack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8548;
const CHAIN_ID = 11155111;
const RPC = `http://127.0.0.1:${PORT}`;
const AUDIT = join(tmpdir(), 'sepolia-call-test-audit.jsonl');
// The spend anchor beside the log: reset it whenever the log is reset, or the
// next run is refused for contradicting a ledger this test cleared on purpose.
const ANCHOR = `${AUDIT}.state.json`;
const DATA = `0xdeadbeef${'11'.repeat(32)}`;
const DATA_BYTES = 36;
// The oversized payload goes through a file. Handing 16KB of hex to a spawn as
// an argument makes some hosts refuse the process outright (spawn EPERM), which
// would fail the suite for a reason that has nothing to do with the size limit
// being tested.
const OVERSIZED = join(tmpdir(), 'sepolia-call-test-oversized.hex');

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Sepolia rehearsal',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

let failures = 0;
const outputs = [];
let slack = null;
let stub = null;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function runCall(args, key) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['sepolia-call.mjs', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        TREASURY_PRIVATE_KEY: key,
        SLACK_WEBHOOK_URL: slack.url,
        SLACK_ALERT_WEBHOOK_URL: '',
        SLACK_WARNING_WEBHOOK_URL: '',
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => {
      outputs.push(out);
      resolve({ code, out });
    });
  });
}

const server = ganache.server({
  chain: { chainId: CHAIN_ID },
  wallet: { deterministic: true, totalAccounts: 10, defaultBalance: 1000 },
  logging: { quiet: true },
});

try {
  rmSync(AUDIT, { force: true });
  rmSync(ANCHOR, { force: true });

  try {
    await server.listen(PORT);
  } catch (err) {
    console.error(`could not start the Sepolia rehearsal chain on port ${PORT}: ${err.message}`);
    console.error('another local node may be using that port');
    process.exit(1);
  }

  slack = await startFakeSlack();
  const accounts = Object.entries(server.provider.getInitialAccounts());
  const treasuryAddress = accounts[0][0];
  const targetRaw = accounts[1][0];
  const target = getAddress(targetRaw);
  const key = accounts[0][1].secretKey.startsWith('0x')
    ? accounts[0][1].secretKey
    : `0x${accounts[0][1].secretKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ganache did not expose a usable key');

  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const balance = async () => formatEther(await publicClient.getBalance({ address: target }));
  const balanceWei = async () => publicClient.getBalance({ address: target });
  const initialWei = await balanceWei();

  console.log(`sepolia rehearsal chain on ${RPC} (chain ${CHAIN_ID}), treasury ${treasuryAddress}`);
  console.log(`target ${target}\n`);

  const base = ['--to', target, '--data', DATA, '--rpc', RPC, '--audit', AUDIT];
  const capped = [...base, '--value', '0.001', '--max-per-refill', '0.01', '--total-budget', '0.05'];

  console.log('== dry run ==');
  let run = await runCall(capped, key);
  check('dry run exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('dry run prints the plan', /DRY RUN/.test(run.out) && /Plan:/.test(run.out), run.out.trim());
  check('plan names the calldata size and hash', new RegExp(`${DATA_BYTES} bytes, keccak 0x[0-9a-f]{64}`).test(run.out), run.out.trim());
  check('plan names the caps', /per-refill 0\.01 ETH, budget 0\.05 ETH/.test(run.out), run.out.trim());
  check('dry run says how to send', /add --live to send/.test(run.out), run.out.trim());
  check('dry run writes no audit log', !existsSync(AUDIT));
  check('dry run sends nothing', (await balanceWei()) === initialWei, await balance());

  console.log('\n== usage and safety refusals ==');
  run = await runCall(['--live', ...base, '--value', '0.001'], key);
  check('--live without caps exits 1', run.code === 1, `exit ${run.code}`);
  check('missing caps are named', /--max-per-refill and --total-budget/.test(run.out), run.out.trim());

  run = await runCall(['--to', target, '--data', '0xabc', '--rpc', RPC, '--audit', AUDIT], key);
  check('odd-length calldata rejected (exit 1)', run.code === 1, `exit ${run.code}`);
  check('error explains whole bytes', /whole bytes/.test(run.out), run.out.trim());

  writeFileSync(OVERSIZED, `0x${'11'.repeat(8193)}\n`);
  run = await runCall(['--to', target, '--data-file', OVERSIZED, '--rpc', RPC, '--audit', AUDIT], key);
  check('oversized calldata rejected (exit 1)', run.code === 1, `exit ${run.code}`);
  check('error states the 8192-byte limit', /limit is 8192 bytes/.test(run.out), run.out.trim());

  run = await runCall(['--to', target, '--data', DATA, '--data-file', OVERSIZED, '--rpc', RPC, '--audit', AUDIT], key);
  check('--data with --data-file rejected (exit 1)', run.code === 1, `exit ${run.code}`);
  check('error asks for one payload source', /either --data or --data-file/.test(run.out), run.out.trim());

  run = await runCall(
    ['--to', target, '--data-file', join(tmpdir(), 'sepolia-call-test-absent.hex'), '--rpc', RPC, '--audit', AUDIT],
    key,
  );
  check('missing --data-file rejected (exit 1)', run.code === 1, `exit ${run.code}`);
  check('error names the absent file', /does not exist/.test(run.out), run.out.trim());

  run = await runCall([...base, '--chain', '1'], key);
  check('--chain is refused', run.code === 1 && /only/.test(run.out), `exit ${run.code}`);

  // A stub RPC that claims mainnet: the tool must refuse before any signing.
  stub = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const result = body.method === 'eth_chainId' ? '0x1' : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  run = await runCall(['--to', target, '--data', DATA, '--rpc', stubUrl, '--audit', AUDIT], key);
  check('non-Sepolia chain refused (exit 3)', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check('refusal names the Sepolia requirement', /only sends on Sepolia \(11155111\)/.test(run.out), run.out.trim());
  check(
    'chain refusal posted to slack',
    slack.messages.some((message) => /sepolia calldata refused/.test(message.text ?? '')),
    String(slack.messages.length),
  );

  console.log('\n== caps ==');
  run = await runCall(
    ['--to', target, '--data', DATA, '--rpc', RPC, '--audit', AUDIT, '--value', '0.5', '--max-per-refill', '0.01', '--total-budget', '1'],
    key,
  );
  check('value above the per-refill cap refused (exit 3)', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check('cap refusal names the rule', /rule cap \(per-refill cap\)/.test(run.out), run.out.trim());
  check('cap refusal sent nothing', (await balanceWei()) === initialWei, await balance());

  const seeded = [
    {
      ts: '2026-11-01T00:00:00.000Z',
      chainId: CHAIN_ID,
      chain: 'Sepolia',
      from: treasuryAddress,
      to: target,
      valueWei: '50000000000000000',
      dataHash: `0x${'22'.repeat(32)}`,
      dataBytes: 4,
      txHash: `0x${'33'.repeat(32)}`,
      status: 'submitted',
    },
    {
      ts: '2026-11-01T00:00:01.000Z',
      chainId: CHAIN_ID,
      chain: 'Sepolia',
      from: treasuryAddress,
      to: target,
      valueWei: '50000000000000000',
      dataHash: `0x${'22'.repeat(32)}`,
      dataBytes: 4,
      feeWei: '1000000000000000',
      txHash: `0x${'33'.repeat(32)}`,
      blockNumber: '1',
      status: 'confirmed',
    },
  ];
  writeFileSync(AUDIT, `${seeded.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  run = await runCall([...base, '--value', '0.001', '--max-per-refill', '0.01', '--total-budget', '0.05'], key);
  check('budget spent refused (exit 3)', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check('budget refusal names the rule', /rule budget \(total spend budget\)/.test(run.out), run.out.trim());
  check('budget refusal sent nothing', (await balanceWei()) === initialWei, await balance());

  console.log('\n== live send ==');
  rmSync(AUDIT, { force: true });
  rmSync(ANCHOR, { force: true });
  run = await runCall(['--live', ...capped], key);
  check('live send exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('live send confirmed on chain', /confirmed in block \d+/.test(run.out), run.out.trim());
  check('target received the value', (await balanceWei()) === initialWei + 1000000000000000n, await balance());
  check('success alert posted', slack.messages.some((message) => /sepolia calldata sent/.test(message.text ?? '')));

  const hash = (run.out.match(/0x[0-9a-f]{64}/) ?? [])[0];
  check('stdout carries the tx hash', Boolean(hash), run.out.trim());
  if (hash) {
    const tx = await publicClient.getTransaction({ hash });
    const txInput = tx.input ?? tx.data;
    check('on-chain calldata matches', txInput?.toLowerCase() === DATA.toLowerCase(), String(txInput));
    check('on-chain target matches', getAddress(tx.to) === target, tx.to);
    check('on-chain value matches', tx.value === 1000000000000000n, String(tx.value));
  }

  console.log('\n== audit log ==');
  const raw = readFileSync(AUDIT, 'utf8').trim();
  const entries = raw.split('\n').map((line) => JSON.parse(line));
  const submitted = entries.filter((entry) => entry.status === 'submitted');
  const confirmed = entries.filter((entry) => entry.status === 'confirmed');
  check('2 entries (submitted + confirmed)', entries.length === 2, String(entries.length));
  check('one submitted and one confirmed', submitted.length === 1 && confirmed.length === 1);
  check('audit records the chain id', entries.every((entry) => entry.chainId === CHAIN_ID));
  check('audit records value and data size', entries.every((entry) => entry.valueWei === '1000000000000000' && entry.dataBytes === DATA_BYTES));
  check(
    'audit stores the payload hash, not the payload',
    entries.every((entry) => entry.dataHash === keccak256(DATA)) && !raw.includes(DATA),
    raw.slice(0, 200),
  );
  check('confirmed entry records the gas fee', confirmed.length === 1 && BigInt(confirmed[0].feeWei ?? 0) > 0n, confirmed[0]?.feeWei);

  console.log('\n== secret hygiene ==');
  check('key never appears in any run output', !outputs.join('').includes(key));
  check('key never appears in the audit log', !raw.includes(key));

  if (failures > 0) {
    console.error(`\nSEPOLIA CALL TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nSEPOLIA CALL TESTS PASSED');
  }
} finally {
  await server.close();
  await slack?.close();
  if (stub) await new Promise((resolve) => stub.close(resolve));
  rmSync(AUDIT, { force: true });
  rmSync(ANCHOR, { force: true });
  rmSync(OVERSIZED, { force: true });
}
