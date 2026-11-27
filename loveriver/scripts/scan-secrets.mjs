#!/usr/bin/env node
// Checks what a push would publish: every commit reachable from HEAD in this
// repository, by path and by content, for wallet material - the CSV wallet sets,
// a 0x private key, or a keystore JSON. Read-only, needs only git and no key, so
// it is safe to run before every push.
//
// It scans the whole history on purpose. A secret committed and then deleted is
// still in every clone, and the push publishes it either way, so checking only
// the current tree would report exactly the case that matters as clean.
//
// Nothing found is ever printed: a private key is shown masked, enough to find
// the line and no more.
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, { input, binary = false } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    input,
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout;
}

let head;
try {
  head = git(['rev-parse', 'HEAD']).trim();
} catch {
  console.error('not inside a git repository with a commit; nothing to scan.');
  process.exit(1);
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const short = (sha) => sha.slice(0, 7);

// Every path a push would add, keyed by the object holding it. Commits and trees
// come back without a path, which is how they get skipped.
const paths = new Map();
const objects = [];
for (const line of git(['rev-list', '--objects', 'HEAD']).split('\n')) {
  if (!line) continue;
  const space = line.indexOf(' ');
  const id = space === -1 ? line : line.slice(0, space);
  objects.push(id);
  if (space !== -1) paths.set(id, line.slice(space + 1));
}

const inspect = git(['cat-file', '--batch-check'], { input: `${objects.join('\n')}\n` });
const blobs = [];
for (const line of inspect.split('\n')) {
  const [id, type, size] = line.split(' ');
  if (type === 'blob') blobs.push({ id, size: Number(size) });
}

// Wallet material is most often recognisable by where it sits, which holds even
// for files this scanner cannot read as text.
const findings = [];
const seen = new Set();
const reportedFiles = new Set();
// A file is named once even when several rules catch it: the path is what the
// reader acts on, not the count. Content hits keep their line number.
function report(path, reason) {
  const key = `${path}\u0000${reason}`;
  if (seen.has(key)) return;
  seen.add(key);
  const file = path.replace(/:\d+$/, '');
  if (!path.includes(':') && reportedFiles.has(file)) return;
  reportedFiles.add(file);
  findings.push({ path, reason });
}

for (const [, path] of paths) {
  if (/(^|\/)wallets\//i.test(path)) report(path, 'inside a wallets directory');
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/^(admins|holders)\.csv$/i.test(name)) report(path, 'wallet CSV name');
  if (/\.keystore\.json$/i.test(name)) report(path, 'keystore file name');
  if (/\.key$/i.test(name) && !/\.key\.example$/i.test(name)) report(path, 'key file name');
}

// Content rules run on blob text: a renamed copy still carries the key, and a
// keystore's fields identify it whatever it is called.
const contentRules = [
  [
    /0x[0-9a-fA-F]{64}\b/g,
    // An all-zero value is a placeholder - it is not a usable key - and the
    // repo's own .env.example templates use one. Everything else is reported.
    (match) => (match === `0x${'0'.repeat(64)}` ? undefined : `0x${match.slice(2, 6)}…${match.slice(-4)}`),
    (shown) => `plaintext private key ${shown}`,
  ],
  [/"ciphertext"\s*:\s*"/g, () => 'ciphertext field', () => 'keystore JSON'],
  [/"crypto"\s*:\s*\{[^}]*"cipherparams"/g, () => 'crypto/cipherparams block', () => 'keystore JSON'],
];

function scans(text) {
  const hits = [];
  for (const [pattern, show, label] of contentRules) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      const shown = show(match[0]);
      if (shown !== undefined) hits.push({ line, reason: label(shown) });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return hits;
}

// One cat-file process for all of it, so a large history stays a couple of
// seconds rather than a fork per file.
const raw = git(['cat-file', '--batch'], { input: `${blobs.map((blob) => blob.id).join('\n')}\n`, binary: true });
let offset = 0;
for (const blob of blobs) {
  const headerEnd = raw.indexOf(10, offset);
  if (headerEnd === -1) break;
  const header = raw.toString('utf8', offset, headerEnd);
  const size = Number(header.slice(header.lastIndexOf(' ') + 1));
  const start = headerEnd + 1;
  const body = raw.subarray(start, start + size);
  offset = start + size + 1;
  const path = paths.get(blob.id);
  if (!path) continue; // a blob no commit points at cannot be pushed
  // A NUL byte means it is not text; the name rules above still cover it.
  if (body.includes(0)) continue;
  for (const hit of scans(body.toString('utf8'))) report(`${path}:${hit.line}`, hit.reason);
}

const commits = Number(git(['rev-list', '--count', 'HEAD']).trim());
const megabytes = (blobs.reduce((sum, blob) => sum + blob.size, 0) / 1024 / 1024).toFixed(1);
console.log(`repository ${relative(process.cwd(), root) || '.'} (${branch} at ${short(head)})`);
console.log(`history    ${commits} commit(s) reachable from HEAD, all of them published by a push`);
console.log(`scanned    ${blobs.length} file blob(s), ${megabytes} MiB`);

if (findings.length === 0) {
  console.log('\nclean: no wallet CSV, private key or keystore JSON in anything a push would publish.');
  process.exit(0);
}

console.log(`\nfound      ${findings.length}`);
for (const { path, reason } of findings.slice(0, 20)) console.log(`  ${path}  (${reason})`);
if (findings.length > 20) console.log(`  and ${findings.length - 20} more not shown`);

// Say where to look next without ever reproducing the secret itself.
const onDisk = findings.filter((finding) => !finding.path.includes(':'));
if (onDisk.length > 0) {
  console.error('\nscan failed: wallet material would be pushed by this branch.');
  console.error('Remove the file and commit the removal, or rewrite the history before pushing:');
  console.error('a later delete does not take it back out of the commits a push sends.');
} else {
  console.error('\nscan failed: wallet material would be pushed by this branch.');
  console.error('The values above are masked; the lines they name hold the real ones.');
}
console.error('If a real key was ever pushed, treat it as compromised and move the funds.');
process.exit(1);
