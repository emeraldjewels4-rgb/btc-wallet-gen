/**
 * Owner-only permissions on Windows, which has filesystem ACLs instead of modes.
 *
 * `--out` asks for 0600 on POSIX; here the equivalent is a DACL naming only the
 * account that wrote the file (plus SYSTEM and Administrators, who can take
 * ownership anyway). `--phrase-file` asks the same question of an existing file
 * by reading its ACL through icacls, so the check is a check rather than a note
 * about the platform.
 *
 * icacls is a system tool, so this whole module is Windows-only; the decision it
 * makes is kept apart from the calls, so it can be tested without depending on
 * what the ACL of a temporary file happens to be.
 */

import { execFileSync } from 'node:child_process';

// Principals that can already do anything to the file, so their presence says
// nothing about who else can read it.
const PRIVILEGED = [/^NT AUTHORITY\\SYSTEM$/i, /^BUILTIN\\Administrators$/i, /^NT SERVICE\\/i, /^OWNER RIGHTS$/i];

export function currentUser() {
  return process.env.USERNAME ?? null;
}

// icacls prints the path once and then one indented "PRINCIPAL:(RIGHTS)" per
// entry; the trailer lines have no rights in parentheses and are ignored.
export function parseIcacls(text, path) {
  const at = path ? text.indexOf(path) : -1;
  const body = at >= 0 ? text.slice(at + path.length) : text;
  const entries = [];
  for (const match of body.matchAll(/([^\r\n:()]+?):((?:\([^)]+\))+)/g)) {
    const principal = match[1].trim();
    if (principal !== '') entries.push({ principal, rights: match[2] });
  }
  return entries;
}

const isUser = (principal, user) => {
  if (user === null) return false;
  const lower = principal.toLowerCase();
  return lower === user.toLowerCase() || lower.endsWith(`\\${user.toLowerCase()}`);
};

// Returns { ok: true } or { ok: false, reason } for the principals listed on a
// file: anyone who is neither this account nor an administrator is a stranger.
export function aclVerdict({ path, user, entries, allowLoose }) {
  const strangers = [
    ...new Set(
      entries
        .map((entry) => entry.principal)
        .filter((principal) => !isUser(principal, user) && !PRIVILEGED.some((re) => re.test(principal))),
    ),
  ];
  if (strangers.length === 0 || allowLoose) return { ok: true };
  return {
    ok: false,
    reason:
      `${path} is readable by ${strangers.join(', ')} (Windows ACLs) - restrict it with ` +
      `icacls "${path}" /inheritance:r /grant:r "${user ?? '%USERNAME%'}:F", ` +
      'or pass --allow-loose-permissions to read it anyway',
  };
}

export function readAcl(path) {
  try {
    const text = execFileSync('icacls', [path], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return { ok: true, entries: parseIcacls(text, path) };
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim().split(/\r?\n/)[0] : '';
    return { ok: false, error: stderr || (err.message ?? 'icacls failed') };
  }
}

// Applies the owner-only DACL and then reads it back, so the caller can report
// what was actually set rather than what was asked for.
export function applyOwnerOnly(path) {
  const user = currentUser();
  if (user === null) return { ok: false, error: 'USERNAME is not set' };
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim().split(/\r?\n/)[0] : '';
    return { ok: false, error: stderr || (err.message ?? 'icacls failed') };
  }

  const after = readAcl(path);
  if (!after.ok) return { ok: false, error: after.error };
  const verdict = aclVerdict({ path, user, entries: after.entries, allowLoose: false });
  return verdict.ok ? { ok: true, entries: after.entries } : { ok: false, error: verdict.reason };
}
