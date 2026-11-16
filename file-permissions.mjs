/**
 * Whether a file holding a secret may be read, and what to say about it.
 *
 * `--out` writes a secret with 0600; reading one is the same question in the
 * other direction. The decision lives here, apart from the read, so it can be
 * checked on a platform that has no modes to speak of.
 */

// Returns { ok, note } when the file may be read, or { ok: false, reason } when
// it may not. `note` is advice the caller prints and carries on past.
export function readPermissionVerdict({ path, mode, platform, allowLoose }) {
  if (platform === 'win32') {
    // Saying "owner-only" here would be a promise this platform does not make,
    // the same honesty writeSecret owes on the way out.
    return {
      ok: true,
      note:
        `note: Windows does not report file modes, so who can read ${path} could not be checked -\n` +
        '  keep it on an encrypted volume, under an account with a password\n',
    };
  }

  const bits = mode & 0o777;
  if ((bits & 0o077) !== 0 && !allowLoose) {
    return {
      ok: false,
      reason:
        `${path} is readable by group or others (mode ${bits.toString(8)}) - chmod 600 it, ` +
        'or pass --allow-loose-permissions to read it anyway',
    };
  }
  return { ok: true, note: null };
}
