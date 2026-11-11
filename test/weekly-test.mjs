#!/usr/bin/env node
/**
 * Checks treasury-weekly.mjs against a synthetic audit log and a fake Slack
 * webhook: ISO week boundaries, dedupe, totals, trends and the once-per-week
 * guard.
 *
 * Run: npm run test:weekly
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSlack } from './fake-slack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(tmpdir(), 'weekly-test-audit.jsonl');
const EMPTY_AUDIT = join(tmpdir(), 'weekly-test-empty.jsonl');
const NOFEE_AUDIT = join(tmpdir(), 'weekly-test-nofee.jsonl');
const WEBHOOK_FILE = join(tmpdir(), 'weekly-test-webhook.txt');
const MISSING_WEBHOOK_FILE = join(tmpdir(), 'weekly-test-webhook-missing.txt');
const MISSING_AUDIT = join(tmpdir(), 'weekly-test-missing.jsonl');
const STATE = join(tmpdir(), 'weekly-test-state.json');

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
    txid: '22'.repeat(32),
    ...overrides,
  });

function runWeekly(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['treasury-weekly.mjs', ...args], {
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

  // ISO week 2026-W45 is 2026-11-02 .. 2026-11-08 (UTC); W44 is 2026-10-26 .. 11-01.
  // The fee sits on the confirmed EVM line and on the submitted BTC line, which
  // exercises both shapes the reader has to merge.
  writeFileSync(
    AUDIT,
    [
      entry({ ts: '2026-11-05T10:00:00.000Z', status: 'submitted' }),
      entry({ ts: '2026-11-05T10:00:30.000Z', status: 'confirmed', feeWei: '210000000000000' }),
      entry({
        ts: '2026-11-06T12:00:00.000Z',
        amountWei: '5000000000000000',
        feeWei: '150000000000000',
        txHash: `0x${'33'.repeat(32)}`,
      }),
      entry({
        ts: '2026-11-02T00:00:00.000Z',
        amountWei: '2000000000000000',
        feeWei: '84000000000000',
        txHash: `0x${'99'.repeat(32)}`,
      }),
      btcEntry({ ts: '2026-11-04T09:00:00.000Z', feeSats: '2000' }),
      entry({
        ts: '2026-11-01T23:59:00.000Z',
        amountWei: '1000000000000000',
        feeWei: '70000000000000',
        txHash: `0x${'88'.repeat(32)}`,
      }),
      entry({ ts: '2026-10-30T10:00:00.000Z', txHash: `0x${'44'.repeat(32)}` }),
      btcEntry({ ts: '2026-10-31T10:00:00.000Z', txid: '55'.repeat(32), feeSats: '1500' }),
      entry({ ts: '2026-10-01T10:00:00.000Z', amountWei: '9000000000000000000', txHash: `0x${'66'.repeat(32)}` }),
      '',
    ].join('\n'),
  );

  // One refill with a fee and one without, to check the "unknown" wording.
  writeFileSync(
    NOFEE_AUDIT,
    [
      entry({ ts: '2026-11-05T10:00:00.000Z', amountWei: '4000000000000000' }),
      entry({
        ts: '2026-11-05T11:00:00.000Z',
        amountWei: '1000000000000000',
        feeWei: '100000000000000',
        txHash: `0x${'77'.repeat(32)}`,
      }),
      '',
    ].join('\n'),
  );

  slack = await startFakeSlack();
  const base = ['--audit', AUDIT, '--week', '2026-W45', '--state', STATE];

  console.log('== print only ==');
  let run = await runWeekly(base);
  check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('names the ISO week and its dates', /weekly treasury roll-up\* - 2026-W45 \(2026-11-02 to 2026-11-08, UTC\)/.test(run.out), run.out);
  check('counts the deduped EVM refills', /ethereum \(1\): 3 refills, 0\.017 ETH/.test(run.out), run.out);
  check('shows a daily average', /avg 0\.002428\d* ETH\/day/.test(run.out), run.out);
  check('counts the BTC refill', /bitcoin mainnet: 1 refill, 0\.0005 BTC/.test(run.out), run.out);
  check('shows the EVM largest refill with its tx', /largest 0\.01 ETH tx 0x11111111/.test(run.out), run.out);
  check('shows the BTC largest refill with its txid', /largest 0\.0005 BTC tx 22222222/.test(run.out), run.out);
  check('puts the EVM fee total beside spend', /3 refills, 0\.017 ETH, fees 0\.000444 ETH/.test(run.out), run.out);
  check('puts the BTC fee total beside spend', /1 refill, 0\.0005 BTC, fees 0\.00002 BTC/.test(run.out), run.out);
  check('totals the refill count', /Total: 4 refills/.test(run.out), run.out);
  check('shows the EVM trend against the previous week', /\+54\.5%/.test(run.out), run.out);
  check('shows the BTC trend as flat', /flat vs 0\.0005 BTC/.test(run.out), run.out);
  check('names the previous ISO week', /previous week \(2026-W44, 2026-10-26 to 2026-11-01\)/.test(run.out), run.out);
  check('keeps the 1 November refill out of week 45', !/0\.018 ETH/.test(run.out), run.out);
  check('excludes activity older than both weeks', !/9 ETH/.test(run.out), run.out);
  check('posts nothing without --post', slack.messages.length === 0, String(slack.messages.length));

  console.log('\n== posting ==');
  run = await runWeekly([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('posting exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('one message posted', slack.messages.length === 1, String(slack.messages.length));
  check('message is the roll-up', /weekly treasury roll-up/.test(slack.messages[0]?.text ?? '') && /Trend vs previous week/.test(slack.messages[0]?.text ?? ''));
  check('message carries the totals', /0\.017 ETH/.test(slack.messages[0]?.text ?? '') && /Total: 4 refills/.test(slack.messages[0]?.text ?? ''));
  check(
    'state file records the week',
    existsSync(STATE) && JSON.parse(readFileSync(STATE, 'utf8')).lastPostedWeek === '2026-W45',
  );

  console.log('\n== once per week ==');
  run = await runWeekly([...base, '--post'], { SLACK_WEBHOOK_URL: slack.url });
  check('second run exits 0', run.code === 0, `exit ${run.code}`);
  check('second run says already posted', /already posted for 2026-W45/.test(run.out), run.out.trim());
  check('no duplicate message', slack.messages.length === 1, String(slack.messages.length));

  run = await runWeekly([...base, '--post', '--force'], { SLACK_WEBHOOK_URL: slack.url });
  check('--force posts again', run.code === 0 && slack.messages.length === 2, `exit ${run.code}, messages ${slack.messages.length}`);

  console.log('\n== webhook from a file ==');
  writeFileSync(WEBHOOK_FILE, `${slack.url}\n`);
  rmSync(MISSING_WEBHOOK_FILE, { force: true });

  run = await runWeekly([...base, '--post', '--force'], {
    SLACK_WEBHOOK_URL: '',
    SLACK_WEBHOOK_FILE: WEBHOOK_FILE,
  });
  check(
    'posts using a webhook file',
    run.code === 0 && slack.messages.length === 3,
    `exit ${run.code}, messages ${slack.messages.length}: ${run.out.trim()}`,
  );

  run = await runWeekly([...base, '--post', '--force'], {
    SLACK_WEBHOOK_URL: '',
    SLACK_WEBHOOK_FILE: MISSING_WEBHOOK_FILE,
  });
  check(
    'unreadable webhook file fails without posting',
    run.code === 2 && slack.messages.length === 3,
    `exit ${run.code}, messages ${slack.messages.length}`,
  );
  check('error names the file variable', /SLACK_WEBHOOK_FILE/.test(run.out), run.out.trim());

  console.log('\n== quiet weeks ==');
  run = await runWeekly(['--audit', EMPTY_AUDIT, '--week', '2026-W45', '--state', STATE]);
  check('empty audit exits 0', run.code === 0, `exit ${run.code}`);
  check('empty audit reports no refills', /- none/.test(run.out) && /Total: 0 refills/.test(run.out), run.out);
  check('empty audit says no refills in either week', /no refills in either week/.test(run.out), run.out);

  run = await runWeekly(['--audit', MISSING_AUDIT, '--week', '2026-W45', '--state', STATE]);
  check('missing audit file exits 0', run.code === 0, `exit ${run.code}`);

  run = await runWeekly(['--audit', NOFEE_AUDIT, '--week', '2026-W45', '--state', STATE]);
  check('totals only the recorded fees', /2 refills, 0\.005 ETH, fees 0\.0001 ETH \(1 unknown\)/.test(run.out), run.out);

  console.log('\n== no-webhook skip logs once per week ==');
  const skipState = join(tmpdir(), `weekly-test-skip-${Date.now()}.json`);
  run = await runWeekly([...base, '--post', '--state', skipState]);
  const skipFirst = run.out;
  check('first skip exits 0 and explains why', run.code === 0 && /no webhook configured/.test(skipFirst), skipFirst.trim());

  run = await runWeekly([...base, '--post', '--state', skipState]);
  check('second skip exits 0', run.code === 0, `exit ${run.code}`);
  check('second skip logs nothing', !/no webhook configured/.test(run.out), run.out.trim());
  check(
    'skip state records the week',
    existsSync(skipState) && JSON.parse(readFileSync(skipState, 'utf8')).skipLoggedWeek === '2026-W45',
  );

  console.log('\n== errors ==');
  run = await runWeekly([...base, '--post']);
  check('--post without a webhook exits 0 (clean skip)', run.code === 0, `exit ${run.code}`);
  check(
    'skip names the missing configuration',
    /no webhook configured/.test(run.out) && /SLACK_WEBHOOK_URL/.test(run.out),
    run.out.trim(),
  );

  run = await runWeekly(['--audit', AUDIT, '--week', '2026-W54']);
  check('impossible week exits 1', run.code === 1, `exit ${run.code}`);
  check('bad week is named in the error', /--week/.test(run.out), run.out.trim());

  run = await runWeekly(['--audit', AUDIT, '--week', '2026-45']);
  check('malformed week exits 1', run.code === 1, `exit ${run.code}`);

  run = await runWeekly(['--nope']);
  check('unknown argument exits 1', run.code === 1, `exit ${run.code}`);

  if (failures > 0) {
    console.error(`\nWEEKLY TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nWEEKLY TESTS PASSED');
  }
} finally {
  await slack?.close();
  rmSync(AUDIT, { force: true });
  rmSync(EMPTY_AUDIT, { force: true });
  rmSync(MISSING_AUDIT, { force: true });
  rmSync(NOFEE_AUDIT, { force: true });
  rmSync(WEBHOOK_FILE, { force: true });
  rmSync(STATE, { force: true });
}
