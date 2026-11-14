#!/usr/bin/env node
/**
 * Checks watchdog.mjs: the dead-man's switch fires past 1.5 intervals, stays
 * quiet below it, treats a missing log as stale rather than silent, and sends
 * its alert to the alert channel.
 *
 * Run: npm run test:watchdog
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSlack } from './fake-slack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function entry(tsMs, txByte = 'ab') {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    chainId: 1,
    chain: 'Ethereum',
    amountWei: '1000000000000000',
    txHash: `0x${txByte.repeat(32)}`,
    status: 'confirmed',
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'treasury-watchdog-'));
let slack = null;

function runWatchdog(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['watchdog.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, SLACK_WEBHOOK_URL: slack.url, ...env },
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

try {
  slack = await startFakeSlack();
  const now = Date.now();
  const log = join(DIR, 'refill-audit.jsonl');

  console.log('== recent activity ==');
  writeFileSync(log, `${entry(now - 60 * 60 * 1000)}\n`);
  let run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a recent entry exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('no alert is sent', slack.messages.length === 0, JSON.stringify(slack.messages));
  check('it reports the age', /ok: newest entry .*\(0\.0 days ago\)/.test(run.out), run.out.trim());

  console.log('\n== the 1.5x threshold ==');
  writeFileSync(log, `${entry(now - 10 * DAY)}\n`);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('10 days is still inside 1.5 x 7', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and stays quiet', slack.messages.length === 0);

  writeFileSync(log, `${entry(now - 11 * DAY)}\n`);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('11 days is stale', run.code === 3, `exit ${run.code}`);
  check('it says nothing was recorded', /stale: nothing recorded since/.test(run.out), run.out.trim());
  check(
    'it names the age and the limit',
    /11\.0 days ago/.test(run.out) && /10\.5 days/.test(run.out),
    run.out.trim(),
  );
  check('exactly one alert was sent', slack.messages.length === 1, String(slack.messages.length));

  const text = slack.messages[0]?.text ?? '';
  check('the alert is labelled high severity', /no refill activity \(high\)/.test(text), text);
  check('the alert carries the interval', /expected every 7 day\(s\)/.test(text), text);
  check('the alert carries the log path', text.includes(log), text);
  check('the alert carries no transaction id or key', !/0x[0-9a-fA-F]{64}/.test(text), text);

  console.log('\n== a missing log is stale, not silent ==');
  const missing = join(DIR, 'never-written.jsonl');
  run = await runWatchdog(['--audit', missing, '--expected-days', '7']);
  check('a missing log exits 3', run.code === 3, `exit ${run.code}`);
  check(
    'it explains that the log is missing',
    /log is missing, empty or has no readable entry/.test(run.out),
    run.out.trim(),
  );
  check('the alert names the missing file', (slack.messages.at(-1)?.text ?? '').includes(missing));

  const empty = join(DIR, 'empty.jsonl');
  writeFileSync(empty, '');
  run = await runWatchdog(['--audit', empty, '--expected-days', '7']);
  check('an existing but empty log is stale too', run.code === 3, `exit ${run.code}`);

  console.log('\n== several logs at once ==');
  const staleLog = join(DIR, 'stale.jsonl');
  const freshLog = join(DIR, 'fresh.jsonl');
  writeFileSync(staleLog, `${entry(now - 40 * DAY)}\n`);
  writeFileSync(freshLog, `${entry(now - 2 * DAY, 'cd')}\n`);
  run = await runWatchdog(['--audit', staleLog, '--audit', freshLog, '--expected-days', '7']);
  check('one fresh log is enough to be healthy', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);

  console.log('\n== damaged lines ==');
  writeFileSync(log, ['not json', JSON.stringify({ ts: 'not-a-date' }), entry(now - 60 * 60 * 1000)].join('\n') + '\n');
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('unreadable lines do not hide a fresh entry', run.code === 0, `exit ${run.code}`);
  check('it counts what it skipped', /2 unreadable line\(s\)/.test(run.out), run.out.trim());

  console.log('\n== with and without a webhook ==');
  const beforeQuiet = slack.messages.length;
  writeFileSync(log, `${entry(now - 30 * DAY)}\n`);
  run = await runWatchdog(['--audit', log, '--expected-days', '7'], { SLACK_WEBHOOK_URL: '' });
  check('a stale log without a webhook still exits 3', run.code === 3, `exit ${run.code}`);
  check('and sends nothing', slack.messages.length === beforeQuiet);
  check('the reason is still printed', /stale: nothing recorded since/.test(run.out), run.out.trim());

  console.log('\n== arguments ==');
  const badDays = await runWatchdog(['--expected-days', '0']);
  check('--expected-days must be positive', badDays.code === 1, `exit ${badDays.code}`);
  const badValue = await runWatchdog(['--expected-days']);
  check('a flag without a value fails', badValue.code === 1, `exit ${badValue.code}`);
  const help = await runWatchdog(['--help']);
  check('--help exits 0', help.code === 0 && /Usage: node watchdog\.mjs/.test(help.out), help.out.trim());

  if (failures > 0) {
    console.error(`\nWATCHDOG TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nWATCHDOG TESTS PASSED');
  }
} finally {
  await slack?.close();
  rmSync(DIR, { recursive: true, force: true });
}
