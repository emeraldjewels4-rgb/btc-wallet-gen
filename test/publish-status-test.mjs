#!/usr/bin/env node
/**
 * Checks publish-status.mjs: it refreshes site/index.html from the audit log and
 * the wallet list, skips the upload cleanly when no SFTP config exists, and
 * propagates the exit code of whichever step failed.
 *
 * No network is used: the failing cases are a bad wallet line and an
 * unreachable SFTP port.
 *
 * Run: npm run test:publish
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(tmpdir(), 'publish-status-test-work');
const PAGE = join(WORK, 'site', 'index.html');
const AUDIT = join(WORK, 'refill-audit.jsonl');
const WALLETS = join(WORK, 'wallets.txt');
const ENV_FILE = join(WORK, '.env.upload');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function runPublish(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'publish-status.mjs'), ...args], {
      cwd: WORK,
      env: { ...process.env },
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
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(
    AUDIT,
    `${JSON.stringify({
      ts: recent,
      chainId: 1,
      amountWei: '1000000000000000',
      txHash: `0x${'ab'.repeat(32)}`,
      status: 'confirmed',
      feeWei: '21000000000000',
    })}\n`,
  );

  console.log('refresh');

  const help = await runPublish(['--help']);
  check('--help exits 0', help.code === 0 && /Usage: node publish-status\.mjs/.test(help.out));

  const noWallets = await runPublish(['--wallets', 'wallets.txt', '--audit', 'refill-audit.jsonl']);
  check('exits 0 without a wallet list', noWallets.code === 0, noWallets.out.trim().split('\n').pop());
  check('writes the page', existsSync(PAGE));
  check('says balances are missing', /no wallet list/.test(noWallets.out));

  const html = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : '';
  check('page reflects the audit log', html.includes('0.001 ETH'), html.slice(0, 300));
  check('page is static', !/<script/i.test(html));

  console.log('upload skip');

  check('reports the upload skip', /not uploaded: no \.env\.upload/.test(noWallets.out));
  check('does not upload without a config', !/uploading via/.test(noWallets.out));

  console.log('failures propagate');

  writeFileSync(WALLETS, '--evm 1:0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4 extra\n');
  const malformed = await runPublish(['--wallets', 'wallets.txt']);
  check('rejects a malformed wallet line', malformed.code === 1, `exit ${malformed.code}`);
  check('names the offending line', /must be exactly two fields/.test(malformed.out));

  writeFileSync(WALLETS, '--evm 1:not-an-address\n');
  const badAddress = await runPublish(['--wallets', 'wallets.txt']);
  check('propagates a failed page build', badAddress.code === 1, `exit ${badAddress.code}`);
  check('says nothing was uploaded', /nothing was uploaded/.test(badAddress.out));

  console.log('upload attempt');

  // No addresses here: the upload path must not need the network.
  writeFileSync(WALLETS, '# no addresses during the upload tests\n');
  writeFileSync(
    ENV_FILE,
    ['SFTP_HOST=127.0.0.1', 'SFTP_PORT=1', 'SFTP_USER=web9999', 'SFTP_PASSWORD=not-real', 'SFTP_REMOTE_DIR=public_html'].join('\n') + '\n',
  );

  const unreachable = await runPublish(['--wallets', 'wallets.txt', '--live']);
  check('uses the upload config when present', /uploading via \.env\.upload/.test(unreachable.out));
  check('propagates an upload failure', unreachable.code === 2, `exit ${unreachable.code}`);
  check('reports the upload failure', /upload failed \(exit 2\)/.test(unreachable.out));

  const dryRun = await runPublish(['--wallets', 'wallets.txt']);
  check('dry run is the default', /upload dry run via \.env\.upload/.test(dryRun.out), dryRun.out);
  check('dry run does not claim to upload', !/uploading via/.test(dryRun.out));
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.log(`PUBLISH TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log('PUBLISH TESTS PASSED');
