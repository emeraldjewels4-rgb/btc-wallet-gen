#!/usr/bin/env node
/**
 * Refresh the public treasury status page and upload it.
 *
 * Intended to run right after the weekly roll-up: it regenerates site/index.html
 * from the audit log plus the public addresses in summary-wallets.txt, then
 * hands that file to upload.mjs. Publishing is opt-in - without .env.upload the
 * page is refreshed locally and nothing is sent, so the scheduled task never
 * fails just because publishing was never set up.
 *
 * Usage:
 *   node publish-status.mjs            # refresh the page, upload in dry-run
 *   node publish-status.mjs --live     # refresh and upload (run-weekly.cmd)
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WALLETS_DEFAULT = 'summary-wallets.txt';
const ENV_DEFAULT = '.env.upload';
const PAGE_PATH = 'site/index.html';

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node publish-status.mjs [options]

Regenerates ${PAGE_PATH}, then uploads it with upload.mjs.

Options:
  --live                   upload after refreshing (otherwise upload.mjs dry-runs)
  --wallets PATH           public addresses to include (default ${WALLETS_DEFAULT})
  --audit PATH             audit log for status-page.mjs (default refill-audit.jsonl)
  --env PATH               SFTP config for upload.mjs (default ${ENV_DEFAULT})
  --remote-dir DIR         remote directory, passed to upload.mjs
  -h, --help               show this help

Without ${ENV_DEFAULT} the page is still refreshed and nothing is uploaded, and
this exits 0, so the weekly task stays green while publishing is unconfigured.

Exit codes: 0 ok, otherwise the exit code of the step that failed
(1 usage, 2 runtime, 3 refused).`);
}

function parseArgs(argv) {
  const opts = {
    live: false,
    wallets: WALLETS_DEFAULT,
    audit: null,
    env: ENV_DEFAULT,
    remoteDir: null,
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
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--dry-run') {
      opts.live = false;
    } else if (arg === '--wallets') {
      opts.wallets = next();
    } else if (arg === '--audit') {
      opts.audit = next();
    } else if (arg === '--env') {
      opts.env = next();
    } else if (arg === '--remote-dir') {
      opts.remoteDir = next();
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

// One argument pair per line, e.g. "--evm 1:0x..." - the same file and format
// run-summary.cmd feeds to treasury-summary.mjs. Addresses only, never keys.
function readWallets(path) {
  if (!existsSync(path)) {
    log(`no wallet list at ${path} - the page will show activity only`);
    return [];
  }

  const args = [];
  let index = 0;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    index += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) {
      fail(`${path}:${index} must be exactly two fields like "--evm 1:0x...", got "${line}"`);
    }
    args.push(parts[0], parts[1]);
  }
  return args;
}

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wallets = readWallets(opts.wallets);

  log(
    `refreshing ${PAGE_PATH}` +
      (wallets.length > 0 ? ` with ${wallets.length / 2} wallet(s)` : ' without balances'),
  );

  const pageArgs = [...wallets, '--out', PAGE_PATH];
  if (opts.audit) pageArgs.push('--audit', opts.audit);

  const pageCode = await run('status-page.mjs', pageArgs);
  if (pageCode !== 0) {
    fail(`status page was not refreshed (exit ${pageCode}); nothing was uploaded`, pageCode);
  }

  if (!existsSync(opts.env)) {
    log(
      `page refreshed, not uploaded: no ${opts.env} ` +
        '(copy .env.upload.example to .env.upload to publish it)',
    );
    return;
  }

  log(`${opts.live ? 'uploading' : 'upload dry run'} via ${opts.env}`);
  const uploadArgs = ['--env', opts.env];
  if (opts.remoteDir) uploadArgs.push('--remote-dir', opts.remoteDir);
  if (opts.live) uploadArgs.push('--live');

  const uploadCode = await run('upload.mjs', uploadArgs);
  if (uploadCode !== 0) fail(`upload failed (exit ${uploadCode})`, uploadCode);
}

main().catch((err) => fail(err?.message ?? String(err), 2));
