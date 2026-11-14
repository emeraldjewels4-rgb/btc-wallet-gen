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
 * Exit codes: 0 recent activity, 1 usage or config error, 2 runtime error,
 *             3 stale - the code every other tool here uses for a safety refusal,
 *             since both mean "stopped, do not treat this as healthy".
 */

import { existsSync, readFileSync } from 'node:fs';
import { createSlackNotifier, resolveSlackWebhooks } from './notify.mjs';

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;
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
  -h, --help          show this help

Environment:
  SLACK_WEBHOOK_URL   Slack incoming webhook; alerts are disabled without it
  SLACK_ALERT_WEBHOOK_URL   channel for this alert (default: SLACK_WEBHOOK_URL)

Exit codes: 0 recent activity, 1 usage or config error, 2 runtime error,
            3 stale. Nothing is written: this tool only reads the log.`);
}

function parseArgs(argv) {
  const opts = { audits: [], expectedDays: 7 };

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const notifier = createSlackNotifier({ ...resolveSlackWebhooks(), log });
  const now = Date.now();

  const { newest, entries, unreadable, missing } = newestActivity(opts.audits);
  const limitMs = opts.expectedDays * DAY_MS * STALE_FACTOR;
  const age = newest === null ? null : now - newest;
  const where = opts.audits.join(', ');

  const summary = [`${opts.audits.length} log(s)`, `${entries} entr${entries === 1 ? 'y' : 'ies'}`];
  if (unreadable) summary.push(`${unreadable} unreadable line(s)`);
  if (missing.length) summary.push(`missing: ${missing.join(', ')}`);
  log(notifier.describe());
  log(summary.join(', '));

  if (age !== null && age <= limitMs) {
    log(
      `ok: newest entry ${new Date(newest).toISOString()} (${days(age)} days ago); ` +
        `expected every ${opts.expectedDays} day(s), stale past ${days(limitMs)}`,
    );
    return;
  }

  const reason =
    age === null
      ? `no refill activity is recorded in ${where} - the log is missing, empty or has no ` +
        'readable entry, so no scheduled run has reached it'
      : `nothing recorded since ${new Date(newest).toISOString()} (${days(age)} days ago), ` +
        `and a run is expected every ${opts.expectedDays} day(s) - anything older than ` +
        `${days(limitMs)} days means the schedule stopped`;

  console.error(`stale: ${reason}`);

  if (notifier.enabled) {
    await notifier.alert(
      `stale:${opts.audits[0]}`,
      [
        ":rotating_light: *no refill activity (high)* - dead-man's switch",
        reason,
        `log ${where}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
        `expected every ${opts.expectedDays} day(s) | alerts past ${days(limitMs)} days`,
        'severity high',
      ].join('\n'),
    );
  }

  process.exitCode = EXIT_STALE;
}

main().catch((err) => fail(err?.message ?? String(err), 2));
