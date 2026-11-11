#!/usr/bin/env node
/**
 * Monthly treasury roll-up for Slack.
 *
 * Read-only: summarises one calendar month of refills per chain and network -
 * count, total spend, average refill size and the largest single refill with its
 * transaction reference - plus year-to-date totals through the month end. It
 * reads only refill-audit.jsonl, so it needs no key, no RPC and no wallet list.
 *
 * Usage:
 *   node --env-file=.env treasury-monthly.mjs --post
 *   node --env-file=.env treasury-monthly.mjs --month 2026-11 --post
 *
 * --month picks the calendar month; the default is the previous month by local
 * date, which is what the 1st-of-month scheduled task should report. --state
 * records the posted month, so a retry for the same month is a no-op unless
 * --force is passed. A failed post leaves the state untouched.
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
const STATE_DEFAULT = '.treasury-monthly-state.json';

function usage() {
  console.log(`Usage: node treasury-monthly.mjs [options]

Options:
  --audit PATH          audit log to summarise (default ${AUDIT_DEFAULT})
  --month YYYY-MM       calendar month to report (default: previous month, local date)
  --post                post to Slack (otherwise print only)
  --webhook-file PATH   read the webhook URL from this file (wins over .env)
  --force               post even if this month was already posted
  --state PATH          state file for the once-per-month guard (default ${STATE_DEFAULT})
  -h, --help            show this help

Environment:
  SLACK_WEBHOOK_URL     required with --post
  SLACK_WEBHOOK_FILE    read that URL from a file instead

Exit codes: 0 ok, 1 usage or config error, 2 runtime error.`);
}

function parseArgs(argv) {
  const opts = {
    audit: AUDIT_DEFAULT,
    month: null,
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
    } else if (arg === '--month') {
      opts.month = next();
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

// Previous calendar month by local date: on the 1st, a run with no --month
// reports the month that just ended rather than a single day of the new one.
function defaultMonth(now = new Date()) {
  const lastOfPrevious = new Date(now.getFullYear(), now.getMonth(), 0);
  return `${lastOfPrevious.getFullYear()}-${String(lastOfPrevious.getMonth() + 1).padStart(2, '0')}`;
}

// Returns the UTC half-open window [startMs, endMs) for a YYYY-MM month.
function monthBounds(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) fail(`--month must look like 2026-11, got "${month}"`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) fail(`--month is not a real month: "${month}"`);
  return {
    year,
    startMs: Date.UTC(year, monthNumber - 1, 1),
    endMs: Date.UTC(year, monthNumber, 1),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const month = opts.month ?? defaultMonth();
  const { year, startMs, endMs } = monthBounds(month);
  const monthEnd = isoDay(endMs - DAY_MS);

  const buckets = summarize(readWindow(opts.audit, startMs, endMs));
  const totalRefills = [...buckets.values()].reduce((sum, bucket) => sum + bucket.count, 0);

  const lines = [...buckets.values()].map((bucket) => {
    const decimals = DECIMALS[bucket.unit];
    const average = bucket.total / BigInt(bucket.count);
    return (
      `- ${bucket.label}: ${bucket.count} refill${bucket.count === 1 ? '' : 's'}, ` +
      `${formatUnits(bucket.total, decimals)} ${bucket.unit}, ` +
      `${feeText(bucket)} ` +
      `(avg ${formatUnits(average, decimals)} ${bucket.unit}, ` +
      `largest ${formatUnits(bucket.largest.amount, decimals)} ${bucket.unit} ` +
      `tx ${shortRef(bucket.largest.txRef)})`
    );
  });

  // Cumulative view from 1 January of the reported year through the month end,
  // so a quiet month still shows the year's spend per chain.
  const yearStartMs = Date.UTC(year, 0, 1);
  const ytdBuckets = summarize(readWindow(opts.audit, yearStartMs, endMs));
  const ytdLines = [...ytdBuckets.values()].map(
    (bucket) =>
      `- ${bucket.label}: ${bucket.count} refill${bucket.count === 1 ? '' : 's'}, ` +
      `${formatUnits(bucket.total, DECIMALS[bucket.unit])} ${bucket.unit}, ` +
      `${feeText(bucket)}`,
  );

  const message = [
    `:calendar: *monthly treasury roll-up* - ${isoDay(startMs)} to ${monthEnd} (UTC)`,
    '',
    '*Refills per chain*',
    ...(lines.length > 0 ? lines : ['- none']),
    `Total: ${totalRefills} refill${totalRefills === 1 ? '' : 's'}`,
    '',
    `*Year to date (${isoDay(yearStartMs)} to ${monthEnd})*`,
    ...(ytdLines.length > 0 ? ytdLines : ['- none']),
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
    // A missing webhook is a configuration gap, not a failure. Log it once per
    // month so the three monthly triggers do not repeat the same line; state is
    // otherwise untouched, so the next run with a webhook still posts.
    if (state.skipLoggedMonth !== month) {
      log(
        'not posted: no webhook configured (set SLACK_WEBHOOK_URL, SLACK_WEBHOOK_FILE ' +
          'or pass --webhook-file)',
      );
      writeState(opts.state, { ...state, skipLoggedMonth: month });
    }
    return;
  }

  if (!opts.force && state.lastPostedMonth === month) {
    log(`monthly roll-up already posted for ${month} (use --force to post again)`);
    return;
  }

  const notifier = createSlackNotifier({ webhookUrl, cooldownMs: 0, log });
  const result = await notifier.alert(`summary:monthly:${month}`, message);

  if (result === 'sent') {
    writeState(opts.state, { lastPostedMonth: month, lastPostedAt: new Date().toISOString() });
    log(`monthly roll-up posted to slack for ${month}`);
  } else if (result === 'failed') {
    // Leave the state untouched so the next run retries the same month.
    fail('slack post failed', 2);
  }
}

main().catch((err) => fail(err?.message ?? String(err), 2));
