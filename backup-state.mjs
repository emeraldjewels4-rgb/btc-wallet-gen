/**
 * The timestamp a successful `wallet.mjs --expect-file` run leaves behind.
 *
 * One definition, read by the three places that care: wallet.mjs writes it,
 * watchdog.mjs alerts when it goes stale, and treasury-weekly.mjs reports its age
 * every week so the lapse is visible before it becomes an alert. It holds no
 * secret and no addresses - when the drill was last done, against which record,
 * and the hash of that record's contents.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const BACKUP_STATE_DEFAULT = '.wallet-verify-state.json';

export function recordDigest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

// 'missing' and 'unreadable' are kept apart: nothing was ever recorded is a
// different problem from something recorded that cannot be read, and they need
// different advice.
export function readBackupState(path) {
  if (!existsSync(path)) return { status: 'missing', verifiedAt: null, record: null, recordHash: null };

  try {
    const { verifiedAt, record, recordHash } = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(verifiedAt);
    if (Number.isFinite(at)) {
      return { status: 'ok', verifiedAt: at, record: record ?? null, recordHash: recordHash ?? null };
    }
  } catch {
    // Falls through to 'unreadable': a truncated or hand-edited file must not
    // look like a missing one.
  }
  return { status: 'unreadable', verifiedAt: null, record: null, recordHash: null };
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
