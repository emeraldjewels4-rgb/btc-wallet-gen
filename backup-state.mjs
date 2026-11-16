/**
 * The timestamp a successful `wallet.mjs --expect-file` run leaves behind.
 *
 * One definition, read by the three places that care: wallet.mjs writes it,
 * watchdog.mjs alerts when it goes stale, and treasury-weekly.mjs reports its age
 * every week so the lapse is visible before it becomes an alert. It holds no
 * secret and no addresses - only when the drill was last done, and against which
 * record.
 */

import { existsSync, readFileSync } from 'node:fs';

export const BACKUP_STATE_DEFAULT = '.wallet-verify-state.json';

// 'missing' and 'unreadable' are kept apart: nothing was ever recorded is a
// different problem from something recorded that cannot be read, and they need
// different advice.
export function readBackupState(path) {
  if (!existsSync(path)) return { status: 'missing', verifiedAt: null };

  try {
    const { verifiedAt } = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(verifiedAt);
    if (Number.isFinite(at)) return { status: 'ok', verifiedAt: at };
  } catch {
    // Falls through to 'unreadable': a truncated or hand-edited file must not
    // look like a missing one.
  }
  return { status: 'unreadable', verifiedAt: null };
}
