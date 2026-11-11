#!/usr/bin/env node
/**
 * End-to-end rehearsal for refill.mjs on a local Ganache chain with fake funds.
 *
 * This exercises the LIVE send path: real signing, real transactions broadcast to
 * a throwaway chain, real receipts. Nothing of value is involved.
 *
 * Run: npm run rehearse
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, defineChain, formatEther, http } from 'viem';
import { startFakeSlack } from './fake-slack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8547;
const CHAIN_ID = 31337;
const AUDIT = join(tmpdir(), 'refill-rehearsal-audit.jsonl');
const DRY_AUDIT = join(tmpdir(), 'refill-rehearsal-dry.jsonl');
const TARGET = '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';
const RPC = `http://127.0.0.1:${PORT}`;

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Rehearsal chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

let failures = 0;
const outputs = [];
let slack = null;
let alertSlack = null;
let warningSlack = null;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function runRefill(args, key) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['refill.mjs', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        TREASURY_PRIVATE_KEY: key,
        SLACK_WEBHOOK_URL: slack.url,
        SLACK_ALERT_WEBHOOK_URL: alertSlack.url,
        SLACK_WARNING_WEBHOOK_URL: warningSlack.url,
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
  rmSync(DRY_AUDIT, { force: true });

  try {
    await server.listen(PORT);
  } catch (err) {
    console.error(`could not start the rehearsal chain on port ${PORT}: ${err.message}`);
    console.error('another local node may be using that port');
    process.exit(1);
  }

  slack = await startFakeSlack();
  alertSlack = await startFakeSlack();
  warningSlack = await startFakeSlack();
  const accounts = server.provider.getInitialAccounts();
  const [treasuryAddress, treasury] = Object.entries(accounts)[0];
  const key = treasury.secretKey.startsWith('0x') ? treasury.secretKey : `0x${treasury.secretKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ganache did not expose a usable treasury key');

  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const balance = async () => formatEther(await publicClient.getBalance({ address: TARGET }));

  console.log(`rehearsal chain on ${RPC} (chain ${CHAIN_ID}), treasury ${treasuryAddress}`);
  console.log(`target ${TARGET}\n`);

  const live = ['--live', '--to', TARGET, '--chain', String(CHAIN_ID), '--rpc', RPC, '--audit', AUDIT];
  const send = (overrides) =>
    runRefill([...live, '--amount', '0.005', '--max-per-refill', '0.006', '--total-budget', '0.02', ...overrides], key);

  console.log('== live refills ==');
  check('target starts empty', (await balance()) === '0', await balance());

  let run = await send(['--threshold', '0.01']);
  check('refill #1 exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #1 confirmed on chain', /confirmed in block \d+/.test(run.out), run.out.trim());
  check('refill #1 delivered 0.005 ETH', (await balance()) === '0.005', await balance());

  run = await send(['--threshold', '0.01']);
  check('refill #2 exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #2 delivered another 0.005 ETH', (await balance()) === '0.01', await balance());

  run = await send(['--threshold', '0.02']);
  check('refill #3 exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #3 delivered to 0.015 ETH', (await balance()) === '0.015', await balance());

  run = await send(['--threshold', '0.02']);
  check('refill #4 exits 0 at the exact budget', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #4 delivered to 0.02 ETH', (await balance()) === '0.02', await balance());

  const beforeRefusal = await balance();
  run = await send(['--threshold', '0.03']);
  check('refill #5 refused by the budget (exit 3)', run.code === 3, `exit ${run.code}`);
  check('refusal names the budget', /REFUSING: budget/.test(run.out), run.out.trim());
  check('refused run sent nothing', (await balance()) === beforeRefusal, `${beforeRefusal} -> ${await balance()}`);

  const refusalAlerts = alertSlack.messages.filter((message) => /refill refused/.test(message.text ?? ''));
  check('refusal alert posted to the alert channel', refusalAlerts.length === 1, String(alertSlack.messages.length));
  check('refusal alert carries the high severity marker', /severity high/.test(refusalAlerts[0]?.text ?? ''), refusalAlerts[0]?.text);
  check(
    'refusal alert spells out which rule fired and by how much',
    /rule budget \(total spend budget\)/.test(refusalAlerts[0]?.text ?? '') &&
      /limit 0\.02 ETH \| spent 0\.02 ETH \| remaining 0 ETH \| requested 0\.005 ETH \| over by 0\.005 ETH/.test(
        refusalAlerts[0]?.text ?? '',
      ),
    refusalAlerts[0]?.text,
  );
  check(
    'refusal alert was not cross-posted',
    !slack.messages.some((message) => /refill refused/.test(message.text ?? '')) &&
      !warningSlack.messages.some((message) => /refill refused/.test(message.text ?? '')),
  );
  check(
    'alert names the chain and the budget',
    /Local dev chain \(31337\)/.test(refusalAlerts[0]?.text ?? '') && /budget/.test(refusalAlerts[0]?.text ?? ''),
    refusalAlerts[0]?.text,
  );

  console.log('\n== caps and dry run ==');
  run = await runRefill(
    [...live, '--amount', '0.01', '--threshold', '1', '--max-per-refill', '0.006', '--total-budget', '0.1'],
    key,
  );
  check('amount above per-refill cap rejected (exit 1)', run.code === 1, `exit ${run.code}`);

  run = await runRefill(
    [
      '--to', TARGET, '--chain', String(CHAIN_ID), '--rpc', RPC, '--audit', DRY_AUDIT,
      '--amount', '0.005', '--threshold', '1', '--max-per-refill', '0.01', '--total-budget', '0.02',
    ],
    key,
  );
  check('dry run exits 0 and prints a plan', run.code === 0 && /DRY RUN/.test(run.out), `exit ${run.code}`);
  check('dry run says how to send', /add --live to send/.test(run.out), run.out.trim());
  check('dry run writes no audit log', !existsSync(DRY_AUDIT));
  check('dry run sends nothing', (await balance()) === beforeRefusal, await balance());

  run = await runRefill(
    [
      '--to', TARGET, '--chain', String(CHAIN_ID), '--rpc', RPC, '--audit', DRY_AUDIT,
      '--amount', '0.005', '--threshold', '0.5', '--min-treasury', '5000',
      '--max-per-refill', '0.01', '--total-budget', '0.02',
    ],
    key,
  );
  check('dry run with a treasury floor exits 0', run.code === 0, `exit ${run.code}`);
  check(
    'low-treasury alert posted to the warning channel',
    warningSlack.messages.some((message) => /treasury low/.test(message.text ?? '')),
    String(warningSlack.messages.length),
  );
  check(
    'low-treasury alert carries the medium severity marker',
    /severity medium/.test(warningSlack.messages.map((message) => message.text ?? '').join('\n')),
  );
  check(
    'low-treasury alert was not cross-posted',
    !slack.messages.some((message) => /treasury low/.test(message.text ?? '')) &&
      !alertSlack.messages.some((message) => /treasury low/.test(message.text ?? '')),
  );
  check(
    'no key material in any alert',
    ![slack, alertSlack, warningSlack].some((server) =>
      server.messages.some((message) => JSON.stringify(message).includes(key)),
    ),
  );

  console.log('\n== audit log ==');
  const raw = readFileSync(AUDIT, 'utf8').trim();
  const entries = raw.split('\n').map((line) => JSON.parse(line));
  const confirmed = entries.filter((entry) => entry.status === 'confirmed');
  const sum = confirmed.reduce((acc, entry) => acc + BigInt(entry.amountWei), 0n);
  check('8 entries (4 sends x submitted + confirmed)', entries.length === 8, String(entries.length));
  check('4 confirmed entries', confirmed.length === 4, String(confirmed.length));
  check('confirmed total is 0.02 ETH', sum === 20000000000000000n, sum.toString());
  check('4 distinct tx hashes', new Set(entries.map((entry) => entry.txHash)).size === 4);
  check('hashes are 32-byte hex', entries.every((entry) => /^0x[0-9a-f]{64}$/.test(entry.txHash)));
  check('no key material in the audit log', !raw.includes(key));
  check(
    'confirmed entries record the gas fee',
    confirmed.length === 4 && confirmed.every((entry) => BigInt(entry.feeWei ?? 0) > 0n),
    confirmed.map((entry) => entry.feeWei ?? 'missing').join(', '),
  );

  console.log('\n== slack success alerts ==');
  const successAlerts = slack.messages.filter((message) => /refill sent/.test(message.text ?? ''));
  check('success alert posted for each of the 4 sends', successAlerts.length === 4, String(successAlerts.length));  check(
    'success alerts carry tx hashes',
    successAlerts.every((message) => /0x[0-9a-f]{64}/.test(message.text ?? '')),
    successAlerts[0]?.text,
  );
  check(
    'success alerts stayed out of the alert and warning channels',
    !alertSlack.messages.some((message) => /refill sent/.test(message.text ?? '')) &&
      !warningSlack.messages.some((message) => /refill sent/.test(message.text ?? '')),
  );

  console.log('\n== secret hygiene ==');
  check('treasury key never appears in any run output', !outputs.join('').includes(key));

  if (failures > 0) {
    console.error(`\nREHEARSAL FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nREHEARSAL PASSED');
  }
} finally {
  await server.close();
  await slack?.close();
  await alertSlack?.close();
  await warningSlack?.close();
  rmSync(AUDIT, { force: true });
  rmSync(DRY_AUDIT, { force: true });
}
