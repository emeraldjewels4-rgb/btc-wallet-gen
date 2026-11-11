#!/usr/bin/env node
/**
 * Verify HEAD from a clean checkout.
 *
 * Clones this repository into a temporary directory, installs exactly what the
 * committed lockfile pins, and runs the full test suite there. Nothing from the
 * working tree can influence the run - no ignored files, no uncommitted edits,
 * no existing node_modules - so a pass means the commit is self-contained.
 *
 * Usage:
 *   npm run verify:tree
 *   node verify-tree.mjs --keep    # leave the clone for inspection
 *
 * The clone path comes from the OS temp directory through node:os, never from a
 * shell string, because passing a POSIX path to git under Git Bash with
 * MSYS_NO_PATHCONV=1 makes it create a literal C:\tmp while `cd` looks elsewhere.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node verify-tree.mjs [options]

Clones HEAD into a temporary directory, runs "npm ci" against the committed
lockfile, then runs "npm test" there.

Options:
  --strict                 refuse to run when the working tree has changes
  --keep                   keep the clone instead of deleting it
  -h, --help               show this help

Nothing in the working tree is used: uncommitted edits, ignored files and
node_modules are all absent from the clone.

Exit codes: 0 ok, 1 usage error, 2 the clone could not be created, 3 refused by
--strict, or the code of the failing step (npm ci or npm test).`);
}

function parseArgs(argv) {
  const opts = { keep: false, strict: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--strict') {
      opts.strict = true;
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }
  return opts;
}

// npm is a .cmd shim on Windows, which Node refuses to spawn without a shell.
// Prefer the npm CLI script next to the running node binary: no shell, no quoting.
function npmRunner() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) {
    return { command: process.execPath, prefix: [cli], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

function run(command, args, cwd, label, shell = false) {
  log(label);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
  if (result.error) {
    log(`${label}: could not start (${result.error.message})`);
    return 2;
  }
  if (result.status !== 0) {
    log(`${label}: exited ${result.status}`);
    return result.status ?? 2;
  }
  return 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`, 2);
  }
  return result.stdout;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const npm = npmRunner();

  const dirty = git(ROOT, ['status', '--porcelain', '--untracked-files=all']).trim();
  if (dirty && opts.strict) {
    const count = dirty.split('\n').filter(Boolean).length;
    fail(
      `the working tree has ${count} uncommitted change${count === 1 ? '' : 's'}; ` +
        'commit or stash them, or run without --strict to verify HEAD anyway',
      3,
    );
  }
  if (dirty) {
    log('note: the working tree has changes; only HEAD is being verified');
  }

  const dest = mkdtempSync(join(tmpdir(), 'treasury-verify-'));
  log(`cloning HEAD into ${dest}`);

  const cloneStatus = run('git', ['clone', '--quiet', '--no-hardlinks', ROOT, dest], ROOT, 'git clone');
  if (cloneStatus !== 0) {
    rmSync(dest, { recursive: true, force: true });
    fail('could not clone the repository', 2);
  }

  const head = git(dest, ['rev-parse', '--short', 'HEAD']).trim();
  const files = git(dest, ['ls-files']).split('\n').filter(Boolean).length;
  const untracked = git(dest, ['status', '--porcelain', '--untracked-files=all']).trim();
  log(`clone: HEAD ${head}, ${files} tracked files, ${untracked ? 'unexpected changes' : 'clean'}`);

  if (untracked) {
    rmSync(dest, { recursive: true, force: true });
    fail('the clone is not clean, so it does not represent the commit', 3);
  }
  if (existsSync(join(dest, '.env'))) {
    rmSync(dest, { recursive: true, force: true });
    fail('the clone contains .env, which is never committed', 3);
  }
  if (existsSync(join(dest, 'node_modules'))) {
    log('warning: the clone already has node_modules; npm ci will replace it');
  }

  let code = 0;
  try {
    code = run(npm.command, [...npm.prefix, 'ci', '--prefer-offline'], dest, 'npm ci (committed lockfile)', npm.shell);
    if (code === 0) {
      code = run(npm.command, [...npm.prefix, 'test'], dest, 'npm test (clean checkout)', npm.shell);
    }
  } finally {
    if (opts.keep) {
      log(`kept the clone at ${dest}`);
    } else {
      rmSync(dest, { recursive: true, force: true });
      log('removed the clone');
    }
  }

  if (code !== 0) {
    fail(
      `verification failed (exit ${code})` +
        (opts.keep ? '' : '; re-run with --keep to inspect the checkout'),
      code,
    );
  }

  log(`verified HEAD ${head}: the committed tree passes the full suite on its own`);
}

main();
