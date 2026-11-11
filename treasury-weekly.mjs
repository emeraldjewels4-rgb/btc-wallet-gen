#!/usr/bin/env node
/**
 * Weekly treasury roll-up for Slack.
 *
 * Read-only: totals the refills in one ISO calendar week (Monday to Sunday, UTC)
 * and compares them with the week before. It reads only refill-audit.jsonl, so
 * it needs no key, no RPC and no wallet list - it still works when a chain is
 * unreachable.
 *
 * Usage:
 *   node --env-file=.env treasury-weekly.mjs --post
 *   node --env-file=.env treasury-weekly.mjs --week 2026-W45 --post
 *
 * The default is the previous ISO week by local date, so the reported window is
 * the same whichever day the task happens to run. --state records the posted
 * week, so a retry for the same week is a no-op unless --force is passed.
 */

import { createSlackNotifier, resolveWebhook } from './notify.mjs';
import {
  DAY_MS,
  DECIMALS,
  fail,
  feeText,
  formatUnits,
  isoDay,
  log,
  readState,
  readWindow,
  shortRef,
  summarize,
  writeState,
} from './rollup.mjs';

const AUDIT_DEFAULT = 'refill-audit.jsonl';
const STATE_DEFAULT = '.treasury-weekly-state.json';
const WEEK_MS = 7 * DAY_MS;

function usage() {
  console.log(`Usage: node treasury-weekly.mjs [options]

Options:
  --audit PATH          audit log to summarise (default ${AUDIT_DEFAULT})
  --week YYYY-Www       ISO week to report, Monday-Sunday UTC (default: previous week, local date)
  --post                post to Slack (otherwise print only)
  --webhook-file PATH   read the webhook URL from this file (wins over .env)
  --force               post even if this week was already posted
  --state PATH          state file for the once-per-week guard (default ${STATE_DEFAULT})
  -h, --help            show this help

Environment:
  SLACK_WEBHOOK_URL     required with --post
  SLACK_WEBHOOK_FILE    read that URL from a file instead

Exit codes: 0 ok, 1 usage or config error, 2 runtime error.`);
}

function parseArgs(argv) {
  const opts = {
    audit: AUDIT_DEFAULT,
    week: null,
    post: false,
    force: false,
    state: STATE_DEFAULT,
    webhookFile: null,
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
      opts.audit = next();
    } else if (arg === '--week') {
      opts.week = next();
    } else if (arg === '--post') {
      opts.post = true;
    } else if (arg === '--webhook-file') {
      opts.webhookFile = next();
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--state') {
      opts.state = next();
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

// ISO week number/year for a timestamp; week 1 is the week containing 4 January.
function isoWeekOf(ms) {
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Weekday * DAY_MS;
  const week = Math.floor((ms - week1Monday) / WEEK_MS) + 1;
  return { year, week };
}

function weekLabel({ year, week }) {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Monday 00:00 UTC of the given ISO week, rejecting weeks that do not exist.
function weekStart(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Weekday * DAY_MS;
  const startMs = week1Monday + (week - 1) * WEEK_MS;
  const actual = isoWeekOf(startMs);
  if (actual.year !== year || actual.week !== week) {
    fail(`--week ${year}-W${String(week).padStart(2, '0')} does not exist`);
  }
  return startMs;
}

function parseWeekArg(raw) {
  const match = /^(\d{4})-W(\d{2})$/.exec(raw);
  if (!match) fail(`--week must look like 2026-W45, got "${raw}"`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) fail(`--week is not a real ISO week: "${raw}"`);
  return { year, week, startMs: weekStart(year, week) };
}

// Previous ISO week by local date: the window does not shift with the weekday
// the task happens to run on.
function defaultWeek(now = new Date()) {
  const weekday = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekday - 7);
  const startMs = Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate());
  return { ...isoWeekOf(startMs), startMs };
}

function trendText(current, previous, decimals, unit) {
  if (previous === 0n) return current === 0n ? 'no change' : 'new this week';
  const delta = current - previous;
  if (delta === 0n) return `flat vs ${formatUnits(previous, decimals)} ${unit}`;
  const magnitude = ((delta < 0n ? -delta : delta) * 1000n) / previous;
  const percent = magnitude % 10n === 0n ? `${magnitude / 10n}%` : `${magnitude / 10n}.${magnitude % 10n}%`;
  return `${delta > 0n ? '+' : '-'}${percent}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const week = opts.week ? parseWeekArg(opts.week) : defaultWeek();
  const currentFrom = week.startMs;
  const currentTo = currentFrom + WEEK_MS;
  const previousFrom = currentFrom - WEEK_MS;
  const previousTo = currentFrom;
  const label = weekLabel(week);
  const previousLabel = weekLabel(isoWeekOf(previousFrom));

  const current = summarize(readWindow(opts.audit, currentFrom, currentTo));
  const previous = summarize(readWindow(opts.audit, previousFrom, previousTo));

  const weekLines = [...current.values()].map(
    (bucket) =>
      `- ${bucket.label}: ${bucket.count} refill${bucket.count === 1 ? '' : 's'}, ` +
      `${formatUnits(bucket.total, DECIMALS[bucket.unit])} ${bucket.unit}, ` +
      `${feeText(bucket)} ` +
      `(avg ${formatUnits(bucket.total / BigInt(WEEK_MS / DAY_MS), DECIMALS[bucket.unit])} ${bucket.unit}/day, ` +
      `largest ${formatUnits(bucket.largest.amount, DECIMALS[bucket.unit])} ${bucket.unit} ` +
      `tx ${shortRef(bucket.largest.txRef)})`,
  );
  const totalRefills = [...current.values()].reduce((sum, bucket) => sum + bucket.count, 0);

  const keys = new Set([...current.keys(), ...previous.keys()]);
  const trendLines = [];
  for (const key of keys) {
    const cur = current.get(key);
    const prev = previous.get(key);
    const meta = cur ?? prev;
    if (!meta) continue;
    const decimals = DECIMALS[meta.unit];
    const curTotal = cur?.total ?? 0n;
    const prevTotal = prev?.total ?? 0n;
    const curCount = cur?.count ?? 0;
    const prevCount = prev?.count ?? 0;
    if (curCount === 0 && prevCount === 0) continue;
    trendLines.push(
      `- ${meta.label}: ${curCount} vs ${prevCount} refills, ` +
        `${formatUnits(curTotal, decimals)} ${meta.unit} vs ` +
        `${formatUnits(prevTotal, decimals)} ${meta.unit} ` +
        `(${trendText(curTotal, prevTotal, decimals, meta.unit)})`,
    );
  }

  const message = [
    `:bar_chart: *weekly treasury roll-up* - ${label} ` +
      `(${isoDay(currentFrom)} to ${isoDay(currentTo - DAY_MS)}, UTC)`,
    '',
    '*Refills this week*',
    ...(weekLines.length > 0 ? weekLines : ['- none']),
    `Total: ${totalRefills} refill${totalRefills === 1 ? '' : 's'}`,
    '',
    `*Trend vs previous week (${previousLabel}, ` +
      `${isoDay(previousFrom)} to ${isoDay(previousTo - DAY_MS)})*`,
    ...(trendLines.length > 0 ? trendLines : ['- no refills in either week']),
  ].join('\n');

  console.log(message);

  if (!opts.post) {
    log('not posted (pass --post to send this to Slack)');
    return;
  }

  // --webhook-file wins, then SLACK_WEBHOOK_FILE, then SLACK_WEBHOOK_URL.
  const webhookUrl = opts.webhookFile
    ? resolveWebhook({ SLACK_WEBHOOK_FILE: opts.webhookFile }, 'SLACK_WEBHOOK_URL')
    : resolveWebhook(process.env, 'SLACK_WEBHOOK_URL');
  const state = readState(opts.state);

  if (!webhookUrl) {
    // Skip cleanly rather than fail, and log it once per ISO week so the three
    // Monday triggers do not repeat the same line.
    if (state.skipLoggedWeek !== label) {
      log(
        'not posted: no webhook configured (set SLACK_WEBHOOK_URL, SLACK_WEBHOOK_FILE ' +
          'or pass --webhook-file)',
      );
      writeState(opts.state, { ...state, skipLoggedWeek: label });
    }
    return;
  }

  if (!opts.force && state.lastPostedWeek === label) {
    log(`weekly roll-up already posted for ${label} (use --force to post again)`);
    return;
  }

  const notifier = createSlackNotifier({ webhookUrl, cooldownMs: 0, log });
  const result = await notifier.alert(`summary:weekly:${label}`, message);

  if (result === 'sent') {
    writeState(opts.state, { lastPostedWeek: label, lastPostedAt: new Date().toISOString() });
    log(`weekly roll-up posted to slack for ${label}`);
  } else if (result === 'failed') {
    // Leave the state untouched so the next run retries the same week.
    fail('slack post failed', 2);
  }
}

main().catch((err) => fail(err?.message ?? String(err), 2));
