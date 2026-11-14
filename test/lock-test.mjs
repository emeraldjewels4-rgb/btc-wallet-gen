#!/usr/bin/env node
/**
 * Checks run-lock.mjs: the run lock is exclusive across processes, a lock left
 * by a dead run is reclaimed rather than blocking the treasury forever, and the
 * signing tools refuse a second run with exit 4 before they touch the network.
 *
 * Run: npm run test:lock
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { generatePrivateKey } from 'viem/accounts';
import { encode as encodeWif } from 'wif';
import { EXIT_LOCKED, LockHeldError, acquireRunLock } from '../run-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ECPair = ECPairFactory(ecc);
const TARGET = '0x7f9ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';
// An address that refuses connections, to prove the blocked run never got as
// far as an RPC call.
const UNREACHABLE = 'http://127.0.0.1:1';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function holder(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function run(script, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        SLACK_WEBHOOK_URL: '',
        SLACK_ALERT_WEBHOOK_URL: '',
        SLACK_WARNING_WEBHOOK_URL: '',
        ...extraEnv,
      },
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

const dir = mkdtempSync(join(tmpdir(), 'treasury-lock-'));
let sleeper = null;

try {
  const lockPath = join(dir, 'audit.jsonl.lock');

  console.log('== one lock at a time ==');
  const first = acquireRunLock(lockPath, { tool: 'test-a' });
  check('taking the lock creates the file', existsSync(lockPath));
  const written = holder(lockPath);
  check('the lock records this process', written?.pid === process.pid, JSON.stringify(written));
  check('the lock names the tool', written?.tool === 'test-a', JSON.stringify(written));
  check('the lock records the host', written?.host === hostname(), JSON.stringify(written));

  let conflict = null;
  try {
    acquireRunLock(lockPath, { tool: 'test-b' });
  } catch (err) {
    conflict = err;
  }
  check('a second acquire is refused', conflict instanceof LockHeldError, String(conflict));
  check(
    'the refusal names the holding process',
    conflict instanceof LockHeldError && conflict.message.includes(`pid ${process.pid}`),
    conflict?.message,
  );
  check(
    'the refusal says how to clear a stale lock',
    /delete that file/i.test(conflict?.message ?? ''),
    conflict?.message,
  );
  check('the holder is unchanged after a refusal', holder(lockPath)?.tool === 'test-a');

  first.release();
  check('releasing removes the lock file', !existsSync(lockPath));
  first.release();
  check('releasing twice is harmless', !existsSync(lockPath));

  const again = acquireRunLock(lockPath, { tool: 'test-c' });
  check('the lock can be taken again after a release', holder(lockPath)?.tool === 'test-c');
  again.release();

  console.log('\n== stale locks are reclaimed ==');
  // A pid that was real and is now gone, rather than a made-up number that
  // could collide with a live process on this machine.
  const ghost = spawn(process.execPath, ['-e', '']);
  await once(ghost, 'close');
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: ghost.pid, host: hostname(), tool: 'killed run', startedAt: new Date().toISOString() }),
  );
  const notes = [];
  const reclaimed = acquireRunLock(lockPath, { tool: 'test-d', log: (line) => notes.push(line) });
  check('a lock left by a dead process is reclaimed', holder(lockPath)?.tool === 'test-d');
  check(
    'the reclaim is reported',
    notes.some((line) => /reclaiming stale run lock/.test(line)),
    notes.join(' | '),
  );
  check('the reclaim says why', notes.some((line) => /no longer running/.test(line)), notes.join(' | '));
  reclaimed.release();

  sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await sleep(200);
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: sleeper.pid, host: hostname(), tool: 'manual run', startedAt: new Date().toISOString() }),
  );
  let liveConflict = null;
  try {
    acquireRunLock(lockPath, { tool: 'scheduled run' });
  } catch (err) {
    liveConflict = err;
  }
  check('a lock held by a running process is not stolen', liveConflict instanceof LockHeldError);
  check(
    'the refusal names the running pid',
    liveConflict instanceof LockHeldError && liveConflict.message.includes(String(sleeper.pid)),
    liveConflict?.message,
  );
  check('the running process still owns the lock', holder(lockPath)?.tool === 'manual run');

  console.log('\n== unreadable and foreign locks ==');
  writeFileSync(lockPath, '{"pid":');
  utimesSync(lockPath, new Date(), new Date());
  let garbageConflict = null;
  try {
    acquireRunLock(lockPath, { tool: 'test-f' });
  } catch (err) {
    garbageConflict = err;
  }
  check('a lock that is mid-write is treated as held', garbageConflict instanceof LockHeldError);

  const old = new Date(Date.now() - 5000);
  utimesSync(lockPath, old, old);
  const reclaimedGarbage = acquireRunLock(lockPath, { tool: 'test-g' });
  check('an unreadable lock that is not being written is reclaimed', holder(lockPath)?.tool === 'test-g');
  reclaimedGarbage.release();

  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 1,
      host: 'some-other-machine',
      tool: 'shared checkout',
      startedAt: new Date().toISOString(),
    }),
  );
  let foreignConflict = null;
  try {
    acquireRunLock(lockPath, { tool: 'test-h' });
  } catch (err) {
    foreignConflict = err;
  }
  check('a recent lock from another host is respected', foreignConflict instanceof LockHeldError);

  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 1,
      host: 'some-other-machine',
      tool: 'shared checkout',
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }),
  );
  const reclaimedForeign = acquireRunLock(lockPath, { tool: 'test-i' });
  check('a lock from another host over an hour old is reclaimed', holder(lockPath)?.tool === 'test-i');
  reclaimedForeign.release();

  console.log('\n== independent audit logs get independent locks ==');
  const one = acquireRunLock(join(dir, 'one.jsonl.lock'), { tool: 'evm' });
  const two = acquireRunLock(join(dir, 'two.jsonl.lock'), { tool: 'sepolia' });
  check(
    'two different audit logs can be locked at once',
    existsSync(join(dir, 'one.jsonl.lock')) && existsSync(join(dir, 'two.jsonl.lock')),
  );
  one.release();
  two.release();
  check('both locks are removed', !existsSync(join(dir, 'one.jsonl.lock')) && !existsSync(join(dir, 'two.jsonl.lock')));

  console.log('\n== refill.mjs refuses a second run ==');
  const key = generatePrivateKey();
  const rehearsalAudit = join(dir, 'rehearsal.jsonl');
  const held = acquireRunLock(`${rehearsalAudit}.lock`, { tool: 'manual run' });
  const blocked = await run(
    'refill.mjs',
    ['--to', TARGET, '--amount', '0.001', '--audit', rehearsalAudit, '--rpc', UNREACHABLE],
    { TREASURY_PRIVATE_KEY: key },
  );
  check(`a second refill exits ${EXIT_LOCKED}`, blocked.code === EXIT_LOCKED, `exit ${blocked.code}`);
  check('the blocked run says which lock', /another run holds/.test(blocked.out), blocked.out);
  check(
    'the blocked run never reached the RPC',
    !/ECONNREFUSED|fetch failed|cannot reach/i.test(blocked.out),
    blocked.out,
  );
  held.release();

  const failedRun = await run(
    'refill.mjs',
    ['--to', TARGET, '--amount', '0.001', '--audit', rehearsalAudit, '--rpc', UNREACHABLE],
    { TREASURY_PRIVATE_KEY: key },
  );
  check('a run with an unreachable RPC exits 2', failedRun.code === 2, `exit ${failedRun.code}`);
  check('a failed run releases the lock', !existsSync(`${rehearsalAudit}.lock`));

  const usageAudit = join(dir, 'usage.jsonl');
  const noCaps = await run(
    'refill.mjs',
    ['--to', TARGET, '--amount', '0.001', '--live', '--audit', usageAudit],
    { TREASURY_PRIVATE_KEY: key },
  );
  check('--live without caps is still a usage error', noCaps.code === 1, `exit ${noCaps.code}`);
  check('a rejected run takes no lock', !existsSync(`${usageAudit}.lock`));

  console.log('\n== the other signing tools share the guard ==');
  const sepoliaAudit = join(dir, 'sepolia.jsonl');
  const sepoliaHeld = acquireRunLock(`${sepoliaAudit}.lock`, { tool: 'manual run' });
  const blockedCall = await run(
    'sepolia-call.mjs',
    ['--to', TARGET, '--data', '0xdeadbeef', '--audit', sepoliaAudit, '--rpc', UNREACHABLE],
    { TREASURY_PRIVATE_KEY: key },
  );
  check(`sepolia-call.mjs exits ${EXIT_LOCKED} when the lock is held`, blockedCall.code === EXIT_LOCKED, `exit ${blockedCall.code}`);
  sepoliaHeld.release();

  // The treasury key and the target address must be different wallets: the tool
  // refuses to send to its own address.
  const keyPair = ECPair.fromPrivateKey(randomBytes(32), { network: bitcoin.networks.bitcoin });
  const targetPair = ECPair.fromPrivateKey(randomBytes(32), { network: bitcoin.networks.bitcoin });
  const btcAddress = bitcoin.payments.p2wpkh({
    pubkey: targetPair.publicKey,
    network: bitcoin.networks.bitcoin,
  }).address;
  const wif = encodeWif({ version: 0x80, privateKey: keyPair.privateKey, compressed: true });
  const btcAudit = join(dir, 'btc.jsonl');
  const btcHeld = acquireRunLock(`${btcAudit}.lock`, { tool: 'manual run' });
  const blockedBtc = await run(
    'btc-refill.mjs',
    ['--to', btcAddress, '--amount', '0.0005', '--fee-rate', '5', '--audit', btcAudit],
    { BTC_TREASURY_WIF: wif },
  );
  check(`btc-refill.mjs exits ${EXIT_LOCKED} when the lock is held`, blockedBtc.code === EXIT_LOCKED, `exit ${blockedBtc.code}`);
  btcHeld.release();
  check('no lock is left behind by any blocked run', !existsSync(`${btcAudit}.lock`));

  if (failures > 0) {
    console.error(`\nLOCK TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nLOCK TESTS PASSED');
  }
} finally {
  if (sleeper && sleeper.exitCode === null) sleeper.kill();
  rmSync(dir, { recursive: true, force: true });
}
