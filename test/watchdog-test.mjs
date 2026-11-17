#!/usr/bin/env node
/**
 * Checks watchdog.mjs: the dead-man's switch fires past 1.5 intervals, stays
 * quiet below it, treats a missing log as stale rather than silent, and sends
 * its alert to the alert channel.
 *
 * Run: npm run test:watchdog
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const WALLET_STATE = join(DIR, 'wallet-verify-state.json');
let slack = null;
// The audit log the drills are appended to, and the timestamp of the state the
// fixtures last wrote: a drill entry only counts when both agree exactly.
let LOG = null;
let STATE_TS = null;
const DEFAULT_CONTENTS = 'address #0: bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu\n';

function drillLine(ts, contents = DEFAULT_CONTENTS) {
  return `${JSON.stringify({
    ts: new Date(ts).toISOString(),
    status: 'wallet-drill',
    record: 'record.txt',
    recordHash: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
  })}\n`;
}

// Put the log back in step after a fixture truncates it.
function appendDrill() {
  if (LOG !== null && STATE_TS !== null) appendFileSync(LOG, drillLine(STATE_TS));
}

// A state as wallet.mjs now writes it: the record it verified, pinned by hash.
function freshBackup(verifiedAt = Date.now()) {
  backupWithRecord(verifiedAt);
}

// A state file that names the record it verified and pins its contents, as
// wallet.mjs writes one. The digest is computed here, not by the tool.
const RECORD = join(DIR, 'record.txt');
function backupWithRecord(
  verifiedAt = Date.now(),
  contents = 'address #0: bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu\n',
  spendCheckedAt = verifiedAt,
) {
  writeFileSync(RECORD, contents);
  writeFileSync(
    WALLET_STATE,
    JSON.stringify({
      verifiedAt: new Date(verifiedAt).toISOString(),
      record: RECORD,
      recordHash: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      // null means the field is absent, as in a state written by a version that
      // never proved spending.
      spendCheckedAt: spendCheckedAt === null ? undefined : new Date(spendCheckedAt).toISOString(),
    }),
  );
  STATE_TS = verifiedAt;
  appendDrill();
}

// Every run gets a backup state unless the test supplies its own, so the audit
// checks below stay about the audit.
function runWatchdog(args, env = {}) {
  const full = args.includes('--wallet-state') ? args : ['--wallet-state', WALLET_STATE, ...args];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['watchdog.mjs', ...full], {
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
  LOG = join(DIR, 'refill-audit.jsonl');
  const log = LOG;
  freshBackup(now);

  console.log('== recent activity ==');
  writeFileSync(log, `${entry(now - 60 * 60 * 1000)}\n`);
  appendDrill();
  let run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a recent entry exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('no alert is sent', slack.messages.length === 0, JSON.stringify(slack.messages));
  check('it reports the age', /ok: newest entry .*\(0\.0 days ago\)/.test(run.out), run.out.trim());

  console.log('\n== the 1.5x threshold ==');
  writeFileSync(log, `${entry(now - 10 * DAY)}\n`);
  appendDrill();
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('10 days is still inside 1.5 x 7', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and stays quiet', slack.messages.length === 0);

  writeFileSync(log, `${entry(now - 11 * DAY)}\n`);
  appendDrill();
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
  check('the alert is labelled high severity', /watchdog \(high\)/.test(text), text);
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
  freshBackup(now);
  const staleLog = join(DIR, 'stale.jsonl');
  const freshLog = join(DIR, 'fresh.jsonl');
  writeFileSync(staleLog, `${entry(now - 40 * DAY)}\n`);
  // The drill can be in any of the watched logs; this one carries it.
  writeFileSync(freshLog, `${entry(now - 2 * DAY, 'cd')}\n${drillLine(STATE_TS)}`);
  run = await runWatchdog(['--audit', staleLog, '--audit', freshLog, '--expected-days', '7']);
  check('one fresh log is enough to be healthy', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);

  console.log('\n== damaged lines ==');
  writeFileSync(log, ['not json', JSON.stringify({ ts: 'not-a-date' }), entry(now - 60 * 60 * 1000)].join('\n') + '\n');
  appendDrill();
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('unreadable lines do not hide a fresh entry', run.code === 0, `exit ${run.code}`);
  check('it counts what it skipped', /2 unreadable line\(s\)/.test(run.out), run.out.trim());

  console.log('\n== with and without a webhook ==');
  const beforeQuiet = slack.messages.length;
  writeFileSync(log, `${entry(now - 30 * DAY)}\n`);
  appendDrill();
  run = await runWatchdog(['--audit', log, '--expected-days', '7'], { SLACK_WEBHOOK_URL: '' });
  check('a stale log without a webhook still exits 3', run.code === 3, `exit ${run.code}`);
  check('and sends nothing', slack.messages.length === beforeQuiet);
  check('the reason is still printed', /stale: nothing recorded since/.test(run.out), run.out.trim());

  console.log('\n== the backup drill must not decay ==');
  writeFileSync(log, `${entry(now - 60 * 60 * 1000)}\n`);
  appendDrill();
  freshBackup(now);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a recently verified backup exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and reports when it was verified', /ok: backup verified 0\.0 days ago/.test(run.out), run.out.trim());

  freshBackup(now - 240 * DAY);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a backup unchecked for eight months exits 3', run.code === 3, `exit ${run.code}`);
  check('it says when it was last verified', /last verified .*\(240\.0 days ago\)/.test(run.out), run.out.trim());
  check('and how often it should be checked', /at least every 180 day\(s\)/.test(run.out), run.out.trim());
  check('the alert carries the backup reason', /last verified/.test(slack.messages.at(-1)?.text ?? ''), slack.messages.at(-1)?.text);
  check('the alert names the state file', (slack.messages.at(-1)?.text ?? '').includes(WALLET_STATE));

  run = await runWatchdog(['--audit', log, '--expected-days', '7', '--wallet-days', '365']);
  check('--wallet-days widens the window', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);

  freshBackup(now - 60 * DAY);
  run = await runWatchdog(['--audit', log, '--expected-days', '7', '--wallet-days', '30']);
  check('--wallet-days narrows it too', run.code === 3, `exit ${run.code}`);

  console.log('\n== an edited record is not a green light ==');
  backupWithRecord(now);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('an unchanged record on a fresh verification exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and reports it as verified', /ok: backup verified 0\.0 days ago/.test(run.out), run.out.trim());

  writeFileSync(RECORD, 'address #0: bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu\n# edited\n');
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('the same record edited afterwards exits 3', run.code === 3, `exit ${run.code}`);
  check(
    'and says the record changed, naming it',
    /has changed since the backup was verified/.test(run.out) && run.out.includes(RECORD),
    run.out.trim(),
  );
  check('the change beats a fresh timestamp', !/ok: backup verified/.test(run.out), run.out.trim());
  check('and the alert carries it', /has changed since/.test(slack.messages.at(-1)?.text ?? ''), slack.messages.at(-1)?.text);

  // A record on the off-line machine is a legitimate arrangement: no opinion,
  // rather than an alarm about a file this machine was never meant to have.
  rmSync(RECORD, { force: true });
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('an unreadable record is not an alarm', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and the age is still reported', /ok: backup verified/.test(run.out), run.out.trim());

  console.log('\n== a state from before records were pinned ==');
  // Written by a version that stored a timestamp and a path but nothing that
  // could say whether the record still matches: not a green light, and the
  // drill it asks for is the thing that pins it.
  writeFileSync(
    WALLET_STATE,
    JSON.stringify({ verifiedAt: new Date(now).toISOString(), record: RECORD }),
  );
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('an unpinned verification exits 3', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check(
    'and says the record was never pinned, asking for the drill',
    /before the record was pinned/.test(run.out) && /re-run the drill/.test(run.out),
    run.out.trim(),
  );
  check('the alert carries it too', /before the record was pinned/.test(slack.messages.at(-1)?.text ?? ''), slack.messages.at(-1)?.text);

  writeFileSync(WALLET_STATE, JSON.stringify({ verifiedAt: new Date(now).toISOString() }));
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a state with no record at all says the same', /before the record was pinned/.test(run.out), run.out.trim());

  console.log('\n== the drill claim rests on the audit log ==');
  // The log is append-only, so a drill it never saw cannot be manufactured by
  // editing the state file that claims it.
  backupWithRecord(now);
  writeFileSync(log, `${entry(now)}\n`);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a state whose drill the log lacks exits 3', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check(
    'and says the log does not have it',
    /records a drill the audit log does not have/.test(run.out),
    run.out.trim(),
  );
  check('naming the log', run.out.includes(log), run.out.trim());
  check('the alert carries it', /audit log does not have/.test(slack.messages.at(-1)?.text ?? ''), slack.messages.at(-1)?.text);

  writeFileSync(log, `${entry(now)}\n`);
  appendDrill();
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a state the log corroborates exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);

  // The match is exact: borrowing a drill from a second earlier would let any
  // edit of the state file pass as long as a drill happened recently.
  const rewritten = JSON.parse(readFileSync(WALLET_STATE, 'utf8'));
  rewritten.verifiedAt = new Date(now + 1000).toISOString();
  writeFileSync(WALLET_STATE, JSON.stringify(rewritten));
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a timestamp the log does not have exits 3', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);

  // A drill proves someone was at the keyboard, not that the refill agent ran.
  backupWithRecord(now);
  writeFileSync(log, '');
  appendDrill();
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check(
    'a drill alone is not refill activity',
    run.code === 3 && /no refill activity/.test(run.out),
    run.out.trim(),
  );

  backupWithRecord(now);
  writeFileSync(log, `${entry(now)}\n`);
  appendDrill();

  console.log('\n== a spend proof has its own clock ==');
  backupWithRecord(now);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a drill that proved spending exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('and the message dates the proof', /spend proof 0\.0 days ago/.test(run.out), run.out.trim());

  // The addresses matched minutes ago; the last time this backup was proved able
  // to spend was months ago. That is the clock the green light was hiding.
  backupWithRecord(now, undefined, now - 200 * DAY);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a spend proof beyond the window exits 3', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check(
    'and says the backup was last proved spendable then',
    /was last proved spendable .*\(200\.0 days ago\)/.test(run.out) && /--spend-check/.test(run.out),
    run.out.trim(),
  );
  check('the alert carries it', /proved spendable/.test(slack.messages.at(-1)?.text ?? ''), slack.messages.at(-1)?.text);

  run = await runWatchdog(['--audit', log, '--expected-days', '7', '--wallet-days', '365']);
  check('--wallet-days gives the proof the same window', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);

  backupWithRecord(now, undefined, null);
  run = await runWatchdog(['--audit', log, '--expected-days', '7']);
  check('a state with no spend proof at all exits 3', run.code === 3, `exit ${run.code}: ${run.out.trim()}`);
  check(
    'and names the flag that would produce one',
    /no spend check is recorded/.test(run.out) && /--spend-check/.test(run.out),
    run.out.trim(),
  );

  freshBackup(now);
  const never = join(DIR, 'never-verified.json');
  run = await runWatchdog(['--wallet-state', never, '--audit', log, '--expected-days', '7']);
  check('a backup that was never checked exits 3', run.code === 3, `exit ${run.code}`);
  check(
    'and says how to do it',
    /no backup verification is recorded in .*--restore --expect-file/.test(run.out),
    run.out.trim(),
  );

  const broken = join(DIR, 'broken-state.json');
  writeFileSync(broken, 'not json');
  run = await runWatchdog(['--wallet-state', broken, '--audit', log, '--expected-days', '7']);
  check('an unreadable state file exits 3', run.code === 3, `exit ${run.code}`);
  check('and says the timestamp is unreadable', /no readable verifiedAt/.test(run.out), run.out.trim());

  const badWalletDays = await runWatchdog(['--wallet-days', '0']);
  check('--wallet-days must be positive', badWalletDays.code === 1, `exit ${badWalletDays.code}`);

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
