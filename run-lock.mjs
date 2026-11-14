#!/usr/bin/env node
/**
 * Cross-process guards shared by the signing tools.
 *
 * Two things must never happen at once on one machine:
 *   - two refill runs, which would race for the same nonce or the same UTXO set;
 *   - two audit appends, which could interleave a half-written line.
 *
 * The run lock is a file created with O_EXCL, so testing for the lock and
 * claiming it are a single atomic step - there is no window between the check
 * and the claim for a second process to slip through. A lock whose owner is
 * gone (a killed run, a rebooted machine) is reclaimed instead of blocking
 * every future run.
 *
 * The lock covers one audit log - `<audit>.lock` - because that is the file
 * whose spend total decides what the next run may do. Runs against different
 * audit logs keep separate locks, and a run against the same log is refused.
 *
 * Nothing here reads a key: the lock records a pid, a host, a tool name and a
 * timestamp, so it can be inspected safely while it exists.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';

export const EXIT_LOCKED = 4;

// A lock written on another machine (shared checkout) cannot have its pid
// checked, so it is only treated as abandoned once it is this old.
const FOREIGN_HOST_STALE_MS = 60 * 60 * 1000;
// A lock file that cannot be parsed is most likely mid-write by its creator.
const UNREADABLE_STALE_MS = 2000;
// Long enough to outlast any plausible single append, short enough to fail
// loudly rather than hang a scheduled run.
const APPEND_TIMEOUT_MS = 5000;
const RECLAIM_ATTEMPTS = 3;

const activeReleases = new Set();
let exitHookInstalled = false;

export class LockHeldError extends Error {
  constructor(lockPath, holder) {
    super(
      `another run holds ${lockPath} (${describeHolder(holder)}); ` +
        'stop it, or delete that file if the process is gone',
    );
    this.name = 'LockHeldError';
    this.path = lockPath;
    this.holder = holder;
  }
}

function describeHolder(holder) {
  if (!holder || typeof holder !== 'object') {
    // Also the read-only-directory case: the file could not be created at all.
    return 'no readable holder - another run may be mid-claim, or the file cannot be created here';
  }
  const parts = [];
  if (Number.isInteger(holder.pid)) parts.push(`pid ${holder.pid}`);
  if (typeof holder.tool === 'string' && holder.tool) parts.push(holder.tool);
  if (typeof holder.startedAt === 'string' && holder.startedAt) parts.push(`started ${holder.startedAt}`);
  if (typeof holder.host === 'string' && holder.host) parts.push(`on ${holder.host}`);
  return parts.length > 0 ? parts.join(', ') : 'an unknown process';
}

function readHolder(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    const holder = JSON.parse(raw);
    return holder && typeof holder === 'object' ? holder : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Why a lock may be treated as abandoned, or null when it must be respected.
function staleReason(path, holder) {
  if (!holder) {
    const age = ageMs(path);
    if (age === null) return 'the file is gone';
    return age >= UNREADABLE_STALE_MS ? `unreadable for ${Math.round(age / 1000)}s` : null;
  }

  if (typeof holder.host === 'string' && holder.host && holder.host !== hostname()) {
    const started = Date.parse(holder.startedAt ?? '');
    const age = Number.isFinite(started) ? Date.now() - started : ageMs(path);
    return age !== null && age > FOREIGN_HOST_STALE_MS
      ? 'it was written on another host over an hour ago'
      : null;
  }

  if (isAlive(holder.pid)) return null;
  return 'its process is no longer running';
}

// Every code a create-new returns while another process holds or is removing the
// path. Windows reports the removal race as EPERM/EACCES rather than EEXIST, and
// by then the file is usually already gone, so probing for it does not help:
// all four are contention, not failures. No fsync - what makes a lock work is
// the file existing, and a record lost to a crash is reclaimed by the pid check.
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

// Create the lock. Returns false when someone else has it.
function claim(path, record) {
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (CONTENDED.has(err.code)) return false;
    throw new Error(`cannot create ${path}: ${err.message}`);
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous by necessity: an exit handler cannot await. A run killed with
  // SIGKILL or Ctrl+C leaves the file behind, and the pid check reclaims it.
  process.once('exit', () => {
    for (const release of [...activeReleases]) release();
  });
}

export function acquireRunLock(lockPath, { tool = 'treasury tool', log = () => {} } = {}) {
  installExitHook();

  const record = {
    pid: process.pid,
    host: hostname(),
    tool,
    startedAt: new Date().toISOString(),
  };

  if (!claim(lockPath, record)) {
    const holder = readHolder(lockPath);
    const reason = staleReason(lockPath, holder);
    if (!reason) throw new LockHeldError(lockPath, holder);

    log(`note: reclaiming stale run lock ${lockPath} (${reason})`);
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone else reclaimed it first; the claim below decides who wins.
    }
    if (!claim(lockPath, record)) throw new LockHeldError(lockPath, readHolder(lockPath));
  }

  let released = false;
  const release = () => {
    activeReleases.delete(release);
    if (released) return;
    released = true;
    const current = readHolder(lockPath);
    // Only remove the file if it is still ours: a run that started after this
    // one was reclaimed must not have its lock deleted from under it.
    if (!current || current.pid !== record.pid || current.host !== record.host) return;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone, or not removable: the pid check on the next run decides.
    }
  };

  activeReleases.add(release);
  return { path: lockPath, record, release };
}

// CLI convenience: take the lock, or explain the conflict and exit 4.
export function takeRunLock(auditPath, { tool, log = () => {} } = {}) {
  try {
    return acquireRunLock(`${auditPath}.lock`, { tool, log });
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`error: ${err.message}`);
      process.exit(EXIT_LOCKED);
    }
    throw err;
  }
}

// A synchronous sleep. Atomics.wait blocks the thread without spinning, which
// keeps the append below synchronous for its callers.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Append one audit entry as a single durable line.
//
// The line is written under a short-lived mutex (`<audit>.append-lock`) and
// fsynced before the call returns, so two processes cannot interleave halves of
// a line and a line that is on disk is really on disk. Entries are small, so
// the mutex is held for microseconds; the timeout only matters if something
// outside these tools is holding it.
export function appendAuditLine(auditPath, entry, { log = () => {}, timeoutMs = APPEND_TIMEOUT_MS } = {}) {
  const mutexPath = `${auditPath}.append-lock`;
  const record = {
    pid: process.pid,
    host: hostname(),
    tool: 'audit-append',
    startedAt: new Date().toISOString(),
  };
  const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');

  const deadline = Date.now() + timeoutMs;
  let reclaims = 0;
  for (;;) {
    if (claim(mutexPath, record)) break;

    const holder = readHolder(mutexPath);
    const reason = staleReason(mutexPath, holder);
    if (reason && reclaims < RECLAIM_ATTEMPTS) {
      reclaims += 1;
      log(`note: reclaiming stale append lock ${mutexPath} (${reason})`);
      try {
        unlinkSync(mutexPath);
      } catch {
        // Racing another reclaim is fine; the next claim decides it.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${mutexPath} (${describeHolder(holder)}); ` +
          `${auditPath} was not written`,
      );
    }
    sleepSync(15);
  }

  try {
    const fd = openSync(auditPath, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    try {
      unlinkSync(mutexPath);
    } catch {
      // The mutex is ours; if it cannot be removed the timeout covers it.
    }
  }
}
