#!/usr/bin/env node
/**
 * Checks treasury-monthly.mjs against a synthetic audit log and a fake Slack
 * webhook: calendar-month boundaries, dedupe, per-chain totals, average refill
 * size, largest refill, fee totals, year-to-date totals and the once-per-month
 * guard.
 *
 * Run: npm run test:monthly
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSlack } from './fake-slack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(tmpdir(), 'monthly-test-audit.jsonl');
const EMPTY_AUDIT = join(tmpdir(), 'monthly-test-empty.jsonl');
const MISSING_AUDIT = join(tmpdir(), 'monthly-test-missing.jsonl');
const NOFEE_AUDIT = join(tmpdir(), 'monthly-test-nofee.jsonl');
const WEBHOOK_FILE = join(tmpdir(), 'monthly-test-webhook.txt');
const MISSING_WEBHOOK_FILE = join(tmpdir(), 'monthly-test-webhook-missing.txt');
const SKIP_STATE = join(tmpdir(), 'monthly-test-skip-state.json');
const STATE = join(tmpdir(), 'monthly-test-state.json');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function entry(overrides) {
  return JSON.stringify({
    ts: '2026-11-05T10:00:00.000Z',
    chainId: 1,
    chain: 'Ethereum',
    from: '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4',
    to: '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4',
    amountWei: '10000000000000000',
    txHash: `0x${'11'.repeat(32)}`,
    status: 'confirmed',
    ...overrides,
  });
}

const btcEntry = (overrides) =>
  entry({
    chain: 'bitcoin',
    network: 'mainnet',
    amountSats: '50000',
    txid: '44'.repeat(32),
    ...overrides,
  });

function runMonthly(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['treasury-monthly.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, SLACK_WEBHOOK_URL: '', SLACK_WEBHOOK_FILE: '', ...envExtra },
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
  rmSync(EMPTY_AUDIT, { force: true });
  rmSync(MISSING_AUDIT, { force: true });
  rmSync(NOFEE_AUDIT, { force: true });
  rmSync(STATE, { force: true });
  writeFileSync(EMPTY_AUDIT, '');

  // The reported month is November 2026: 2026-11-01T00:00Z .. 2026-12-01T00:00Z.
  writeFileSync(
    AUDIT,
    [
      entry({ status: 'submitted' }),
      entry({ ts: '2026-11-05T10:00:20.000Z', status: 'confirmed', feeWei: '210000000000000' }),
      entry({ amountWei: '5000000000000000', feeWei: '150000000000000', txHash: `0x${'22'.repeat(32)}` }),
      entry({ amountWei: '20000000000000000', feeWei: '420000000000000', txHash: `0x${'33'.repeat(32)}` }),
      entry({
        ts: '2026-11-01T00:00:00.000Z',
        amountWei: '2000000000000000',
        feeWei: '90000000000000',
        txHash: `0x${'99'.repeat(32)}`,
      }),
      entry({ ts: '2026-10-31T23:59:00.000Z', amountWei: '1000000000000000', txHash: `0x${'88'.repeat(32)}` }),
      btcEntry({ feeSats: '2000' }),
      btcEntry({ amountSats: '25000', txid: '55'.repeat(32), feeSats: '1200' }),
      entry({ ts: '2026-06-01T10:00:00.000Z', amountWei: '20000000000000000', txHash: `0x${'77'.repeat(32)}` }),
      entry({ ts: '2025-09-01T10:00:00.000Z', amountWei: '9000000000000000000', txHash: `0x${'66'.repeat(32)}` }),
      '',
    ].join('\n'),
  );

  // One refill with a fee and one without, to check the unknown-fee wording.
  writeFileSync(
    NOFEE_AUDIT,
    [
      entry({ amountWei: '4000000000000000' }),
      entry({
        ts: '2026-11-06T10:00:00.000Z',
        amountWei: '1000000000000000',
        feeWei: '100000000000000',
        txHash: `0x${'aa'.repeat(32)}`,
      }),
      '',
    ].join('\n'),
  );

  slack = await startFakeSlack();
  const base = ['--audit', AUDIT, '--month', '2026-11', '--state', STATE];

  console.log('== print only ==');
  let run = await runMonthly(base);
  check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('names the calendar month', /monthly treasury roll-up\* - 2026-11-01 to 2026-11-30/.test(run.out), run.out);
  check('counts the deduped EVM refills', /ethereum \(1\): 4 refills, 0\.037 ETH/.test(run.out), run.out);
  check('shows the EVM average refill size', /avg 0\.00925 ETH/.test(run.out), run.out);
  check('shows the EVM largest refill with its tx', /largest 0\.02 ETH tx 0x33333333/.test(run.out), run.out);
  check('counts the BTC refills', /bitcoin mainnet: 2 refills, 0\.00075 BTC/.test(run.out), run.out);
  check('shows the BTC average refill size', /avg 0\.000375 BTC/.test(run.out), run.out);
  check('shows the BTC largest refill with its txid', /largest 0\.0005 BTC tx 44444444/.test(run.out), run.out);
  check('puts the EVM fee total beside spend', /4 refills, 0\.037 ETH, fees 0\.00087 ETH/.test(run.out), run.out);
  check('puts the BTC fee total beside spend', /2 refills, 0\.00075 BTC, fees 0\.000032 BTC/.test(run.out), run.out);
  check('totals the refill count', /Total: 6 refills/.test(run.out), run.out);
  check('keeps the 31 October refill out of November', !/0\.038 ETH/.test(run.out), run.out);
  check('includes the 1 November refill', /0\.037 ETH/.test(run.out), run.out);
  check('names the year-to-date window', /\*Year to date \(2026-01-01 to 2026-11-30\)\*/.test(run.out), run.out);
  check('cumulates YTD EVM spend through the month end', /ethereum \(1\): 6 refills, 0\.058 ETH/.test(run.out), run.out);
  check('cumulates YTD BTC spend through the month end', /bitcoin mainnet: 2 refills, 0\.00075 BTC/.test(run.out), run.out);

  const ytdSection = run.out.slice(run.out.indexOf('*Year to date'));
  check(
    'puts the YTD EVM fees beside spend, flagging the refill with no fee',
    /6 refills, 0\.058 ETH, fees 0\.00087 ETH \(2 unknown\)/.test(ytdSection),
    ytdSection,
  );
  check(
    'puts the YTD BTC fees beside spend',
    /2 refills, 0\.00075 BTC, fees 0\.000032 BTC/.test(ytdSection),
    ytdSection,
  );
  check('excludes activity from previous years', !/9 ETH/.test(run.out), run.out);
  check('posts nothing without --post', slack.messages.length === 0, String(slack.messages.length));

  console.log('\n== posting ==');
  run = await runMonthly([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('posting exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('one message posted', slack.messages.length === 1, String(slack.messages.length));
  check('message is the roll-up', /monthly treasury roll-up/.test(slack.messages[0]?.text ?? '') && /Refills per chain/.test(slack.messages[0]?.text ?? ''));
  check('message carries the largest refill', /largest 0\.02 ETH/.test(slack.messages[0]?.text ?? ''), slack.messages[0]?.text);
  check('message carries the year-to-date section', /Year to date/.test(slack.messages[0]?.text ?? '') && /0\.058 ETH/.test(slack.messages[0]?.text ?? ''), slack.messages[0]?.text);
  check(
    'state file records the month',
    existsSync(STATE) && JSON.parse(readFileSync(STATE, 'utf8')).lastPostedMonth === '2026-11',
  );

  console.log('\n== once per month ==');
  run = await runMonthly([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('second run exits 0', run.code === 0, `exit ${run.code}`);
  check('second run says already posted', /already posted for 2026-11/.test(run.out), run.out.trim());
  check('no duplicate message', slack.messages.length === 1, String(slack.messages.length));

  run = await runMonthly([...base, '--post', '--force'], { SLACK_WEBHOOK_URL: slack.url });
  check('--force posts again', run.code === 0 && slack.messages.length === 2, `exit ${run.code}, messages ${slack.messages.length}`);

  console.log('\n== webhook from a file ==');
  writeFileSync(WEBHOOK_FILE, `${slack.url}\n`);
  rmSync(MISSING_WEBHOOK_FILE, { force: true });

  run = await runMonthly([...base, '--post', '--force', '--webhook-file', WEBHOOK_FILE]);
  check(
    'posts using --webhook-file',
    run.code === 0 && slack.messages.length === 3,
    `exit ${run.code}, messages ${slack.messages.length}: ${run.out.trim()}`,
  );

  run = await runMonthly([...base, '--post', '--force', '--webhook-file', MISSING_WEBHOOK_FILE]);
  check(
    'unreadable --webhook-file fails without posting',
    run.code === 2 && slack.messages.length === 3,
    `exit ${run.code}, messages ${slack.messages.length}`,
  );
  check('error names the file variable', /SLACK_WEBHOOK_FILE/.test(run.out), run.out.trim());

  console.log('\n== quiet month ==');
  run = await runMonthly(['--audit', EMPTY_AUDIT, '--month', '2026-11', '--state', STATE]);
  check('empty audit exits 0', run.code === 0, `exit ${run.code}`);
  check('empty audit reports no refills', /- none/.test(run.out) && /Total: 0 refills/.test(run.out), run.out);

  run = await runMonthly(['--audit', NOFEE_AUDIT, '--month', '2026-11', '--state', STATE]);
  check('flags refills without fee data', /2 refills, 0\.005 ETH, fees 0\.0001 ETH \(1 unknown\)/.test(run.out), run.out);

  run = await runMonthly(['--audit', MISSING_AUDIT, '--month', '2026-11', '--state', STATE]);
  check('missing audit file exits 0', run.code === 0, `exit ${run.code}`);

  console.log('\n== no-webhook skip logs once per month ==');
  rmSync(SKIP_STATE, { force: true });
  run = await runMonthly([...base, '--post', '--state', SKIP_STATE]);
  const skipFirst = run.out;
  check('first skip exits 0 and explains why', run.code === 0 && /no webhook configured/.test(skipFirst), skipFirst.trim());

  run = await runMonthly([...base, '--post', '--state', SKIP_STATE]);
  check('second skip exits 0', run.code === 0, `exit ${run.code}`);
  check('second skip logs nothing', !/no webhook configured/.test(run.out), run.out.trim());
  check(
    'skip state records the month',
    existsSync(SKIP_STATE) && JSON.parse(readFileSync(SKIP_STATE, 'utf8')).skipLoggedMonth === '2026-11',
  );

  console.log('\n== errors ==');
  run = await runMonthly([...base, '--post']);
  check('--post without a webhook exits 0 (clean skip)', run.code === 0, `exit ${run.code}`);
  check(
    'skip names the missing configuration',
    /no webhook configured/.test(run.out) && /SLACK_WEBHOOK_URL/.test(run.out),
    run.out.trim(),
  );
  check('skip sends nothing', slack.messages.length === 3, String(slack.messages.length));

  run = await runMonthly([...base, '--post', '--webhook-file', MISSING_WEBHOOK_FILE]);
  check('a configured but unreadable file still exits 2', run.code === 2, `exit ${run.code}`);

  run = await runMonthly(['--audit', AUDIT, '--month', '2026-13']);
  check('impossible month exits 1', run.code === 1, `exit ${run.code}`);
  check('bad month is named in the error', /--month/.test(run.out), run.out.trim());

  run = await runMonthly(['--audit', AUDIT, '--month', '11-2026']);
  check('malformed month exits 1', run.code === 1, `exit ${run.code}`);

  run = await runMonthly(['--nope']);
  check('unknown argument exits 1', run.code === 1, `exit ${run.code}`);

  if (failures > 0) {
    console.error(`\nMONTHLY TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nMONTHLY TESTS PASSED');
  }
} finally {
  await slack?.close();
  rmSync(AUDIT, { force: true });
  rmSync(EMPTY_AUDIT, { force: true });
  rmSync(MISSING_AUDIT, { force: true });
  rmSync(NOFEE_AUDIT, { force: true });
  rmSync(WEBHOOK_FILE, { force: true });
  rmSync(SKIP_STATE, { force: true });
  rmSync(STATE, { force: true });
}
