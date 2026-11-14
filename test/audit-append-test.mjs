#!/usr/bin/env node
/**
 * Checks the audit appender in run-lock.mjs: one durable line per entry, whole
 * lines under contention from several processes, and a bounded, loud failure
 * when something else is holding the append mutex.
 *
 * Run: npm run test:audit
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAuditLine } from '../run-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

function runWorker(file, writer, count) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['test/append-worker.mjs', file, String(writer), String(count)], {
      cwd: ROOT,
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

const dir = mkdtempSync(join(tmpdir(), 'treasury-append-'));
let sleeper = null;

try {
  console.log('== one line per entry ==');
  const audit = join(dir, 'refill-audit.jsonl');
  const txHash = `0x${'ab'.repeat(32)}`;
  appendAuditLine(audit, {
    ts: '2026-01-01T00:00:00.000Z',
    chainId: 1,
    txHash,
    amountWei: '1000000000000000',
    status: 'submitted',
  });

  const raw = readFileSync(audit, 'utf8');
  const lines = readLines(audit);
  check('one append writes exactly one line', lines.length === 1, String(lines.length));
  check('the line ends with a newline', raw.endsWith('\n'), JSON.stringify(raw.slice(-4)));
  const first = (() => {
    try {
      return JSON.parse(lines[0]);
    } catch {
      return null;
    }
  })();
  check('the line parses back to the entry', first?.txHash === txHash, lines[0]);
  check('the entry is written verbatim', first?.amountWei === '1000000000000000', lines[0]);
  check('the append mutex is removed afterwards', !existsSync(`${audit}.append-lock`));

  appendAuditLine(audit, { seq: 1 });
  appendAuditLine(audit, { seq: 2 });
  const ordered = readLines(audit).map((line) => JSON.parse(line).seq ?? 'first');
  check('appends keep their order', JSON.stringify(ordered) === '["first",1,2]', JSON.stringify(ordered));

  appendAuditLine(audit, { note: 'line one\nline two' });
  const withNewline = readLines(audit);
  check(
    'a newline inside a value does not split the line',
    withNewline.length === 4 && JSON.parse(withNewline[3]).note === 'line one\nline two',
    String(withNewline.length),
  );

  console.log('\n== concurrent writers never interleave ==');
  const shared = join(dir, 'shared.jsonl');
  const writers = 6;
  const perWriter = 40;
  const results = await Promise.all(
    Array.from({ length: writers }, (_, index) => runWorker(shared, index, perWriter)),
  );
  check(
    `all ${writers} writers exited cleanly`,
    results.every((result) => result.code === 0),
    results.map((result) => `exit ${result.code} ${result.out.trim()}`).join(' | '),
  );

  const sharedLines = readLines(shared);
  const expected = writers * perWriter;
  check(`every line landed (${expected})`, sharedLines.length === expected, String(sharedLines.length));
  const parsedAll = sharedLines.every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
  check('every line is complete JSON', parsedAll);
  const keys = new Set();
  let malformed = 0;
  for (const line of sharedLines) {
    try {
      const entry = JSON.parse(line);
      if (!Number.isInteger(entry.writer) || !Number.isInteger(entry.seq)) malformed += 1;
      keys.add(`${entry.writer}:${entry.seq}`);
    } catch {
      malformed += 1;
    }
  }
  check('no entry is truncated or fused with its neighbour', malformed === 0, `${malformed} bad line(s)`);
  check('every writer/seq pair appears exactly once', keys.size === expected, `${keys.size} unique`);
  check('no line holds two entries', !readFileSync(shared, 'utf8').includes('}{'));
  check('the append mutex is not left behind', !existsSync(`${shared}.append-lock`));

  console.log('\n== stale and busy mutexes ==');
  const ghost = spawn(process.execPath, ['-e', '']);
  await once(ghost, 'close');
  const staleFile = join(dir, 'stale.jsonl');
  writeFileSync(
    `${staleFile}.append-lock`,
    JSON.stringify({
      pid: ghost.pid,
      host: hostname(),
      tool: 'audit-append',
      startedAt: new Date().toISOString(),
    }),
  );
  appendAuditLine(staleFile, { recovered: true });
  check('a mutex left by a dead process is reclaimed', readLines(staleFile).length === 1);
  check('the reclaimed mutex is removed', !existsSync(`${staleFile}.append-lock`));

  sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const busyFile = join(dir, 'busy.jsonl');
  appendAuditLine(busyFile, { first: true });
  writeFileSync(
    `${busyFile}.append-lock`,
    JSON.stringify({
      pid: sleeper.pid,
      host: hostname(),
      tool: 'audit-append',
      startedAt: new Date().toISOString(),
    }),
  );
  const startedAt = Date.now();
  let timeoutErr = null;
  try {
    appendAuditLine(busyFile, { second: true }, { timeoutMs: 150 });
  } catch (err) {
    timeoutErr = err;
  }
  const waited = Date.now() - startedAt;
  check('a live mutex holder makes the append fail loudly', /timed out/.test(timeoutErr?.message ?? ''), String(timeoutErr));
  check(
    'the failure names the file it could not write',
    String(timeoutErr?.message).includes(busyFile),
    String(timeoutErr?.message),
  );
  check(
    'the failure names the process holding the mutex',
    String(timeoutErr?.message).includes(`pid ${sleeper.pid}`),
    String(timeoutErr?.message),
  );
  check('nothing is written while the mutex is held elsewhere', readLines(busyFile).length === 1);
  check('the wait is bounded', waited >= 100 && waited < 5000, `${waited} ms`);
  check('the other process keeps its mutex', existsSync(`${busyFile}.append-lock`));

  if (failures > 0) {
    console.error(`\nAUDIT APPEND TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAUDIT APPEND TESTS PASSED');
  }
} finally {
  if (sleeper && sleeper.exitCode === null) sleeper.kill();
  rmSync(dir, { recursive: true, force: true });
}
