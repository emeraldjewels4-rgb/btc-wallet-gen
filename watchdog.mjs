#!/usr/bin/env node
/**
 * Dead-man's switch for the scheduled treasury runs.
 *
 * Every other guard here reacts to a run that happened and went wrong. None of
 * them notices a run that never happened: a sleeping machine, a disabled task,
 * a disconnected drive. This one looks backwards instead - it reads the newest
 * timestamp in the audit log and speaks up when nothing has been recorded for
 * about 1.5 times the expected interval.
 *
 * It sees only the ledger, so it cannot tell "nothing needed doing" from "the
 * schedule stopped". That is why the alert reports the age and the interval
 * rather than guessing a cause.
 *
 * Usage:
 *   node --env-file=.env watchdog.mjs --expected-days 7
 *   node watchdog.mjs --audit refill-audit.jsonl --expected-days 3
 *
 * The second thing it looks at is the backup. A successful wallet --expect-file
 * run leaves a timestamp; once that is older than a few months, or missing, the
 * drill has become a one-off and the alert says so.
 *
 * Exit codes: 0 recent activity, 1 usage or config error, 2 runtime error,
 *             3 stale - the code every other tool here uses for a safety refusal,
 *             since both mean "stopped, do not treat this as healthy".
 */

import { existsSync, readFileSync } from 'node:fs';
import { BACKUP_STATE_DEFAULT, readBackupState, recordState } from './backup-state.mjs';
import { createSlackNotifier, resolveSlackWebhooks } from './notify.mjs';

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;
// Twice a year: longer than a quarterly review, short enough that a lapse is
// caught while the backup material can still be found. Days, like --expected-days,
// so the tool has one unit.
const WALLET_DAYS_DEFAULT = 180;
// "About 1.5 intervals" leaves room for one missed run plus clock and timezone
// drift, and still reports a switch-off machine within two weeks of a weekly job.
const STALE_FACTOR = 1.5;
// 3 is the shared "a safety rule stopped this run" code. 4 is already the run
// lock (EXIT_LOCKED in run-lock.mjs), so a stale verdict must not borrow it.
const EXIT_STALE = 3;

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node watchdog.mjs [options]

Fails loudly when the audit log has not advanced recently, which is what a
machine that slept through its scheduled runs looks like from here.

Options:
  --audit PATH        audit log to watch, repeatable (default ${AUDIT_DEFAULT})
  --expected-days N   how often a run is expected (default 7); the alert fires
                      past ${STALE_FACTOR} x this, so 10.5 days by default
  --wallet-state PATH  timestamp left by a successful wallet --expect-file run
                      (default ${BACKUP_STATE_DEFAULT})
  --wallet-days N     how often the backup should be checked, in days (default
                      ${WALLET_DAYS_DEFAULT}); a missing timestamp, or one older than
                      this, is stale just like the log is
  -h, --help          show this help

Environment:
  SLACK_WEBHOOK_URL   Slack incoming webhook; alerts are disabled without it
  SLACK_ALERT_WEBHOOK_URL   channel for this alert (default: SLACK_WEBHOOK_URL)

Exit codes: 0 recent activity, 1 usage or config error, 2 runtime error,
            3 stale. Nothing is written: this tool only reads the log and the
            backup state.`);
}

function parseArgs(argv) {
  const opts = {
    audits: [],
    expectedDays: 7,
    walletState: BACKUP_STATE_DEFAULT,
    walletDays: WALLET_DAYS_DEFAULT,
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
    } else if (arg === '--audit') {
      opts.audits.push(next());
    } else if (arg === '--expected-days') {
      const raw = next();
      const days = Number(raw);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        fail(`--expected-days expects a positive number of days, got "${raw}"`);
      }
      opts.expectedDays = days;
    } else if (arg === '--wallet-state') {
      opts.walletState = next();
    } else if (arg === '--wallet-days') {
      const raw = next();
      const walletDays = Number(raw);
      if (!Number.isFinite(walletDays) || walletDays <= 0 || walletDays > 3650) {
        fail(`--wallet-days expects a positive number of days, got "${raw}"`);
      }
      opts.walletDays = walletDays;
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  if (opts.audits.length === 0) opts.audits.push(AUDIT_DEFAULT);
  return opts;
}

// The newest timestamp across every log given. Unreadable lines are counted but
// skipped: one damaged line must not hide a healthy log, nor fake freshness.
function newestActivity(audits) {
  let newest = null;
  let entries = 0;
  let unreadable = 0;
  const missing = [];

  for (const path of audits) {
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ts;
      try {
        ts = Date.parse(JSON.parse(line).ts);
      } catch {
        unreadable += 1;
        continue;
      }
      if (!Number.isFinite(ts)) {
        unreadable += 1;
        continue;
      }
      entries += 1;
      if (newest === null || ts > newest) newest = ts;
    }
  }

  return { newest, entries, unreadable, missing };
}

function days(ms) {
  return (ms / DAY_MS).toFixed(1);
}

// A backup check that is never repeated is only presumed good, and the record it
// was checked against drifts out of memory first. Reports the age of the last
// successful wallet --expect-file run.
function backupState(path, limitDays, now) {
  const limitMs = limitDays * DAY_MS;
  const { status, verifiedAt, record, recordHash } = readBackupState(path);
  if (status === 'missing') {
    return {
      ok: false,
      message:
        `no backup verification is recorded in ${path} - run ` +
        'node wallet.mjs --restore --expect-file <record> < seed.txt',
    };
  }
  if (status === 'unreadable') {
    return { ok: false, message: `${path} has no readable verifiedAt - re-run the restore check to rewrite it` };
  }

  // The green light was given for one record. If that record has been edited
  // since, the light is for something nobody checked, which matters more than
  // how long ago it was - re-running the drill is the answer to both.
  const state = recordState({ record, recordHash });
  if (state === 'unrecorded') {
    // Written before the state pinned anything, so nothing here can say whether
    // the record still matches what was checked. Not a green light, and not an
    // alarm about the record either: the drill it asks for pins it from now on.
    return {
      ok: false,
      message:
        `${path} records a verification from before the record was pinned to its contents - ` +
        're-run the drill, node wallet.mjs --restore --expect-file <record> < seed.txt',
    };
  }
  if (state === 'changed') {
    return {
      ok: false,
      message: `the record ${record} has changed since the backup was verified - check the backup against it again`,
    };
  }

  const ageMs = now - verifiedAt;
  if (ageMs > limitMs) {
    return {
      ok: false,
      message:
        `the backup was last verified ${new Date(verifiedAt).toISOString()} (${days(ageMs)} days ago) - ` +
        `check it at least every ${limitDays} day(s)`,
    };
  }
  return {
    ok: true,
    message: `backup verified ${days(ageMs)} days ago (${new Date(verifiedAt).toISOString()}); stale past ${days(limitMs)}`,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const notifier = createSlackNotifier({ ...resolveSlackWebhooks(), log });
  const now = Date.now();

  const { newest, entries, unreadable, missing } = newestActivity(opts.audits);
  const limitMs = opts.expectedDays * DAY_MS * STALE_FACTOR;
  const age = newest === null ? null : now - newest;
  const where = opts.audits.join(', ');
  const auditStale = age === null || age > limitMs;

  const summary = [`${opts.audits.length} log(s)`, `${entries} entr${entries === 1 ? 'y' : 'ies'}`];
  if (unreadable) summary.push(`${unreadable} unreadable line(s)`);
  if (missing.length) summary.push(`missing: ${missing.join(', ')}`);
  log(notifier.describe());
  log(summary.join(', '));

  const auditMessage =
    age === null
      ? `no refill activity is recorded in ${where} - the log is missing, empty or has no ` +
        'readable entry, so no scheduled run has reached it'
      : auditStale
        ? `nothing recorded since ${new Date(newest).toISOString()} (${days(age)} days ago), ` +
          `and a run is expected every ${opts.expectedDays} day(s) - anything older than ` +
          `${days(limitMs)} days means the schedule stopped`
        : `newest entry ${new Date(newest).toISOString()} (${days(age)} days ago); ` +
          `expected every ${opts.expectedDays} day(s), stale past ${days(limitMs)}`;

  const backup = backupState(opts.walletState, opts.walletDays, now);

  // Both checks have the same shape: say it when it is fine, collect it when it
  // is not, and report everything collected in one place.
  const reasons = [];
  const report = (ok, message) => (ok ? log(`ok: ${message}`) : reasons.push(message));
  report(!auditStale, auditMessage);
  report(backup.ok, backup.message);

  if (reasons.length === 0) return;

  console.error(reasons.map((reason) => `stale: ${reason}`).join('\n'));

  if (notifier.enabled) {
    await notifier.alert(
      `stale:${opts.audits[0]}`,
      [
        ':rotating_light: *watchdog (high)* - something that should have happened did not',
        ...reasons,
        `log ${where}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
        `expected every ${opts.expectedDays} day(s) | alerts past ${days(limitMs)} days`,
        `backup ${opts.walletState} | checked at least every ${opts.walletDays} day(s)`,
        'severity high',
      ].join('\n'),
    );
  }

  process.exitCode = EXIT_STALE;
}

main().catch((err) => fail(err?.message ?? String(err), 2));
