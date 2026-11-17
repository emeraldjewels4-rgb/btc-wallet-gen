/**
 * Whether a file holding a secret may be read, and what to say about it.
 *
 * `--out` writes a secret with 0600; reading one is the same question in the
 * other direction. The decision lives here, apart from the read, so it can be
 * checked on a platform that has no modes to speak of.
 *
 * Two questions, because one is not enough: who can read the file, and who can
 * replace it. A 0600 file in a writable directory is only as private as the
 * directory, since anyone who can write there can swap it for one they own.
 *
 * POSIX only: Windows has ACLs rather than modes, and windows-acl.mjs answers
 * there instead of this module saying it cannot tell.
 */

// Returns { ok, note } when the file may be read, or { ok: false, reason } when
// it may not. `note` is advice the caller prints and carries on past.
// `mode` and `dirMode` are st_mode values; on POSIX the caller always has both.
export function readPermissionVerdict({ path, mode, dirPath, dirMode, allowLoose }) {
  const bits = mode & 0o777;
  if ((bits & 0o077) !== 0 && !allowLoose) {
    return {
      ok: false,
      reason:
        `${path} is readable by group or others (mode ${bits.toString(8)}) - chmod 600 it, ` +
        'or pass --allow-loose-permissions to read it anyway. A redirect gets that mode ' +
        'from the umask; --phrase-only --out PATH creates the file 0600 instead',
    };
  }

  // Someone who can write to the directory can delete the file and put their own
  // in its place, so its own mode only speaks for as long as that cannot happen.
  // The sticky bit is the exception, which is why /tmp is not a refusal: there,
  // others cannot unlink a file they do not own.
  const dir = dirMode & 0o1777;
  if ((dir & 0o022) !== 0 && (dir & 0o1000) === 0 && !allowLoose) {
    return {
      ok: false,
      reason:
        `${dirPath} can be written by group or others (mode ${(dir & 0o777).toString(8)}), so ` +
        `${path} can be replaced by a file whose permissions you did not choose - ` +
        `chmod 700 ${dirPath}, or pass --allow-loose-permissions to read it anyway`,
    };
  }
  return { ok: true, note: null };
}
