/**
 * The timestamp a successful `wallet.mjs --expect-file` run leaves behind.
 *
 * One definition, read by the three places that care: wallet.mjs writes it,
 * watchdog.mjs alerts when it goes stale, and treasury-weekly.mjs reports its age
 * every week so the lapse is visible before it becomes an alert. It holds no
 * secret and no addresses - when the drill was last done, against which record,
 * the hash of that record's contents, and when the key was last proved able to
 * spend from it, which is a separate clock because a drill that only compares
 * addresses does not prove that.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// The audit log records each drill as a line of its own. The state file can be
// rewritten by anyone with a text editor; an append-only log cannot hide a drill
// that never happened, so the log is what the readers trust.
export const DRILL_STATUS = 'wallet-drill';

export const BACKUP_STATE_DEFAULT = '.wallet-verify-state.json';

export function recordDigest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

// 'missing' and 'unreadable' are kept apart: nothing was ever recorded is a
// different problem from something recorded that cannot be read, and they need
// different advice.
export function readBackupState(path) {
  if (!existsSync(path)) {
    return { status: 'missing', verifiedAt: null, record: null, recordHash: null, spendCheckedAt: null };
  }

  try {
    const { verifiedAt, record, recordHash, spendCheckedAt } = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(verifiedAt);
    if (Number.isFinite(at)) {
      const spent = Date.parse(spendCheckedAt);
      return {
        status: 'ok',
        verifiedAt: at,
        record: record ?? null,
        recordHash: recordHash ?? null,
        spendCheckedAt: Number.isFinite(spent) ? spent : null,
      };
    }
  } catch {
    // Falls through to 'unreadable': a truncated or hand-edited file must not
    // look like a missing one.
  }
  return { status: 'unreadable', verifiedAt: null, record: null, recordHash: null, spendCheckedAt: null };
}

// A verification is a claim about one record, not about whatever is at that path
// later. 'changed' means the claim no longer applies; 'unrecorded' and
// 'unreadable' mean nobody can tell - the state may predate the hash, or the
// record may live on the off-line machine, which is a legitimate arrangement and
// not something to raise an alarm about.
export function recordState({ record, recordHash }) {
  if (!record || !recordHash) return 'unrecorded';

  let digest;
  try {
    digest = recordDigest(readFileSync(record, 'utf8'));
  } catch {
    return 'unreadable';
  }
  return digest === recordHash ? 'unchanged' : 'changed';
}

// Drill entries from one or more audit logs, oldest first. Unreadable lines are
// counted rather than thrown, the same way the watchdog treats the refill lines
// beside them.
export function readDrills(paths) {
  const drills = [];
  let unreadable = 0;
  const missing = [];

  for (const path of paths) {
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        unreadable += 1;
        continue;
      }
      if (entry?.status !== DRILL_STATUS) continue;
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts)) {
        unreadable += 1;
        continue;
      }
      drills.push({ ts, recordHash: entry.recordHash ?? null, spendChecked: entry.spendChecked === true });
    }
  }

  drills.sort((a, b) => a.ts - b.ts);
  return { drills, unreadable, missing };
}

// Whether the log contains the drill a state file claims. The match is exact,
// because the drill writes one timestamp into both places: any slack would let a
// rewritten state file borrow a neighbouring drill's evidence.
export function drillEvidence({ verifiedAt, recordHash, drills }) {
  if (!recordHash || verifiedAt === null) return { status: 'unknown', newest: drills.length > 0 ? drills.at(-1).ts : null, count: drills.length };
  const match = drills.find((drill) => drill.recordHash === recordHash && drill.ts === verifiedAt);
  return {
    status: match ? 'confirmed' : 'absent',
    newest: drills.length > 0 ? drills.at(-1).ts : null,
    count: drills.length,
  };
}
