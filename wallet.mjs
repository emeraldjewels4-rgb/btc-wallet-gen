#!/usr/bin/env node
/**
 * Local self-custody Bitcoin wallet tool.
 *
 *   generate : fresh 24-word BIP-39 seed  -> BIP-84 native SegWit addresses
 *   restore  : an existing BIP-39 seed    -> the same BIP-84 addresses
 *
 * Addresses are BIP-84 native SegWit (bech32, "bc1q..."), Bitcoin mainnet,
 * derived at m/84'/0'/0'/0/i for the receive chain.
 *
 * No network calls. Nothing is written to disk unless --fingerprint asks for a
 * public record file, or a successful --expect-file records its timestamp in
 * .wallet-verify-state.json. Neither holds a secret.
 *
 * Usage:
 *   node wallet.mjs                       generate: seed phrase + address #0
 *   node wallet.mjs --count 5             generate: first 5 receive addresses
 *   node wallet.mjs --show-key            also print the WIF key for address #0
 *   node wallet.mjs --restore < seed.txt  restore: derive addresses from a phrase
 *   node wallet.mjs --restore             restore: paste the phrase on stdin
 *   node wallet.mjs --xpub XPUB           derive addresses from a public xpub or tpub
 *   node wallet.mjs --fingerprint F       write a public record to verify a backup
 *   node wallet.mjs --restore --expect-file F < seed.txt   check a backup against it
 *
 * A BIP-39 passphrase (the optional 25th word) is read from --passphrase-file,
 * BIP39_PASSPHRASE_FILE or BIP39_PASSPHRASE, or asked for at a terminal without
 * echo - the environment is last because other processes can read it.
 */

import { closeSync, fstatSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { BACKUP_STATE_DEFAULT, recordDigest } from './backup-state.mjs';
import { readPermissionVerdict } from './file-permissions.mjs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { spendProof } from './spend-check.mjs';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { encode as encodeWIF } from 'wif';

const NETWORK = bitcoin.networks.bitcoin;
const COIN = "m/84'/0'/0'"; // BIP-84 account: native SegWit, account 0
const RECEIVE = 0; // external chain: addresses handed out to payers
const CHANGE = 1; // internal chain: change from spending, never handed out
// Same meaning as in the treasury tools: a safety check said no. Used when the
// restored wallet does not match the value recorded for it.
const EXIT_MISMATCH = 3;
// A record and a check are read later, against a wallet that is no longer in
// front of you, so both cover a handful of addresses by default; --count
// overrides them, and the report's default of one lives where it is printed.
const CHECKED_ADDRESSES = 5;
// Bumped when the record's fields change shape. A reader that does not know a
// version refuses the file rather than verifying the half of it it understands.
const FINGERPRINT_VERSION = 1;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node wallet.mjs [--restore] [--count N] [--show-key] [--phrase-only] [--expect VALUE]

  --restore     derive addresses from an existing seed phrase read from stdin
                (pipe it in: node wallet.mjs --restore < seed.txt)
  --phrase-file PATH
                read the phrase to restore from PATH instead of stdin; a file
                that group or others can read is refused
  --allow-loose-permissions
                read such a --phrase-file anyway
  --xpub XPUB   derive addresses from an extended public key instead of a seed
                (xpub for mainnet, tpub for testnet; account m/84'/COIN'/0'
                or its receive chain m/84'/COIN'/0'/0)
  --count N     how many addresses to cover, 1-20: printed (default 1), or
                recorded and searched by --fingerprint and --expect (default 5)
  --show-key    also print the WIF private key for address #0; to a terminal it
                refuses unless --allow-tty is passed
  --allow-tty   print that private key to the terminal anyway
  --spend-check prove a restored backup can spend, not only derive: sign a spend
                of address #0 offline, verify the signature and discard it; needs
                --restore, and sends nothing to the network
  --out PATH    write what --show-key or --phrase-only would print to PATH
                instead, created 0600 and never overwritten
  --verify-state PATH
                where a successful --expect-file records its timestamp, for
                watchdog.mjs (default ${BACKUP_STATE_DEFAULT})
  --passphrase-file PATH
                read the BIP-39 passphrase (25th word) from the first line of
                PATH; at a terminal with no file or variable, it is asked for
                without echo
  --phrase-only print only the new seed phrase on stdout, one line and nothing
                else, so 'node wallet.mjs --phrase-only --out seed.txt' is a
                backup that --restore accepts; generation only, never with --show-key,
                and it refuses to run when stdout is a terminal
  --expect VALUE check the restored wallet against an xpub, tpub or address
                recorded when it was created (either chain); a mismatch exits 3, so a wrong
                phrase or passphrase fails instead of looking like a restore
  --fingerprint PATH
                write the account, receive-chain and change-chain xpubs plus the
                first five addresses (--count N to change) to PATH as a public
                record (no secret in it)
                that --expect-file can check a backup against years later; '-'
                writes it to stdout instead
  --expect-file PATH
                check the restored wallet against that record; needs --restore,
                and exits 3 when the phrase, the passphrase or the file is wrong
  -h, --help    show this help

BIP-39 passphrase: --passphrase-file PATH, else BIP39_PASSPHRASE_FILE (a path),
  else asked for at a terminal, else BIP39_PASSPHRASE (visible to other
  processes). Empty by default.

Exit codes: 0 ok, 1 usage or config error, 3 the restored wallet does not
            match --expect (nothing was printed that could be mistaken for
            success, and no wallet should be funded from it).`);
}

function parseArgs(argv) {
  const opts = {
    count: null,
    showKey: false,
    allowTty: false,
    spendCheck: false,
    phraseFile: null,
    allowLoosePermissions: false,
    passphraseFile: null,
    out: null,
    // Where a successful --expect-file run leaves its timestamp; watchdog.mjs
    // and the weekly roll-up read the same file. Holds no secret, git-ignored.
    verifyState: BACKUP_STATE_DEFAULT,
    restore: false,
    phraseOnly: false,
    xpub: null,
    expect: null,
    fingerprint: null,
    expectFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--show-key' || arg === '--show-private-key') {
      opts.showKey = true;
    } else if (arg === '--allow-tty') {
      opts.allowTty = true;
    } else if (arg === '--spend-check') {
      opts.spendCheck = true;
    } else if (arg === '--allow-loose-permissions') {
      opts.allowLoosePermissions = true;
    } else if (arg === '--phrase-file') {
      const value = argv[i + 1];
      if (value === undefined || value === '') fail('--phrase-file needs a path');
      opts.phraseFile = value;
      i += 1;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value === '') fail('--out needs a path');
      opts.out = value;
      i += 1;
    } else if (arg === '--passphrase-file') {
      const value = argv[i + 1];
      if (value === undefined || value === '') fail('--passphrase-file needs a path');
      opts.passphraseFile = value;
      i += 1;
    } else if (arg === '--verify-state') {
      const value = argv[i + 1];
      if (value === undefined || value === '') fail('--verify-state needs a path');
      opts.verifyState = value;
      i += 1;
    } else if (arg === '--restore') {
      opts.restore = true;
    } else if (arg === '--phrase-only') {
      opts.phraseOnly = true;
    } else if (arg === '--expect') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('--expect needs an xpub, tpub or address');
      // Only the two things this tool can derive: an extended public key, or a
      // bech32 address (BIP-84 is bech32-only, so 1.../3... never applies here).
      if (!/^[xt]pub/.test(value) && !/^(bc1|tb1)/.test(value)) {
        fail(`--expect expects an xpub, tpub or bech32 address, got "${value}"`);
      }
      opts.expect = value;
      i += 1;
    } else if (arg === '--expect-file') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('--expect-file needs a path');
      opts.expectFile = value;
      i += 1;
    } else if (arg === '--fingerprint') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('--fingerprint needs a path, or - for stdout');
      opts.fingerprint = value;
      i += 1;
    } else if (arg === '--xpub') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('--xpub needs an extended public key');
      opts.xpub = value;
      i += 1;
    } else if (arg === '--count') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        fail(`--count expects an integer from 1 to 20, got "${argv[i + 1] ?? ''}"`);
      }
      opts.count = value;
      i += 1;
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }
  if (opts.xpub !== null && opts.restore) fail('--xpub and --restore are mutually exclusive');
  if (opts.xpub !== null && opts.showKey) fail('--show-key needs a seed; an xpub has no private key');
  if (opts.phraseFile !== null && !opts.restore) {
    fail('--phrase-file is the phrase to restore, so it needs --restore');
  }
  if (opts.allowLoosePermissions && opts.phraseFile === null) {
    fail('--allow-loose-permissions only relaxes the check on --phrase-file');
  }
  if (opts.expect !== null && !opts.restore) fail('--expect compares a restored wallet, so it needs --restore');
  if (opts.expectFile !== null && !opts.restore) fail('--expect-file compares a restored wallet, so it needs --restore');
  if (opts.expect !== null && opts.expectFile !== null) {
    fail('--expect and --expect-file both say what to compare against; pass one');
  }
  if (opts.fingerprint !== null && (opts.expect !== null || opts.expectFile !== null)) {
    fail('--fingerprint writes the record that --expect-file reads; write it in one run, check it in another');
  }
  if (opts.fingerprint !== null && opts.xpub !== null) {
    fail('--fingerprint records a seed-derived wallet, so it cannot be combined with --xpub');
  }
  if (opts.phraseOnly && (opts.restore || opts.xpub !== null || opts.showKey || opts.fingerprint !== null)) {
    fail('--phrase-only writes a new seed phrase and nothing else, so it cannot be combined with --restore, --xpub, --show-key or --fingerprint');
  }
  if (opts.spendCheck && !opts.restore) {
    fail('--spend-check proves a restored backup can spend, so it needs --restore');
  }
  if (opts.out !== null && !opts.showKey && !opts.phraseOnly) {
    fail('--out writes the secret that --show-key or --phrase-only would print, so it needs one of them');
  }

  return opts;
}

async function readPhrase() {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  process.stderr.write('Paste your BIP-39 seed phrase, then press Enter (input is echoed):\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('> ');
  } finally {
    rl.close();
  }
}

// The 25th word is a second secret, so it is not echoed: raw mode when a
// terminal is attached, and the plain stream otherwise.
function readSecret(prompt) {
  process.stderr.write(prompt);
  const { stdin } = process;
  const raw = typeof stdin.setRawMode === 'function';
  if (raw) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
  }

  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
    stdin.once('end', finish);
  });
}

// A passphrase in the environment is visible to anything that can list this
// process, so a file or a terminal answer comes first and the variable is kept
// for whatever already sets it.
async function resolvePassphrase(opts, { prompt = true } = {}) {
  // An empty variable means "not set here", not "the empty passphrase": a shell
  // that exported it once should not turn the prompt off.
  const file = opts.passphraseFile ?? (process.env.BIP39_PASSPHRASE_FILE || null);
  if (file !== null) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      fail(`cannot read the passphrase file ${file}: ${err.message}`);
    }
    // One line, without the newline the file editor added: a passphrase with a
    // stray \n is a different passphrase.
    return text.split('\n')[0].replace(/\r$/, '');
  }

  if (process.env.BIP39_PASSPHRASE) {
    if (prompt) {
      process.stderr.write(
      'note: BIP39_PASSPHRASE comes from the environment, where other processes can read it;\n' +
          '  --passphrase-file or answering the prompt keeps it out of there\n',
      );
    }
    return process.env.BIP39_PASSPHRASE;
  }

  return prompt && process.stdin.isTTY
    ? await readSecret('BIP-39 passphrase (empty for none): ')
    : '';
}

// The phrase is only as private as the file holding it. --out asks for 0600 on
// the way out; this is the same question asked on the way in, of the file
// descriptor so that the file which was checked is the file that is read - and
// asked before the bytes are read, so a refused file is never opened into memory.
function readPhraseFile(path, allowLoose) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    fail(`cannot read --phrase-file ${path}: ${err.message}`);
  }

  let info;
  try {
    info = fstatSync(fd);
  } catch (err) {
    closeSync(fd);
    fail(`cannot read --phrase-file ${path}: ${err.message}`);
  }

  // Who can replace it matters as much as who can read it, and that is the
  // directory's answer. Windows reports neither, which the verdict says.
  let dirMode = 0;
  const dirPath = dirname(resolve(path));
  if (process.platform !== 'win32') {
    try {
      dirMode = statSync(dirPath).mode;
    } catch (err) {
      closeSync(fd);
      fail(`cannot check the permissions of ${dirPath}: ${err.message}`);
    }
  }

  const verdict = readPermissionVerdict({
    path,
    mode: info.mode,
    dirPath,
    dirMode,
    platform: process.platform,
    allowLoose,
  });
  if (verdict.note) process.stderr.write(verdict.note);
  if (!verdict.ok) {
    closeSync(fd);
    fail(verdict.reason);
  }

  // Everything above is a decision about the file; the phrase only enters memory
  // once that decision is yes.
  try {
    return readFileSync(fd, 'utf8');
  } catch (err) {
    fail(`cannot read --phrase-file ${path}: ${err.message}`);
  } finally {
    closeSync(fd);
  }
}

// BIP-39 phrases are compared after Unicode normalization, case folding and
// whitespace collapse, so pasted phrases with stray newlines still match.
function normalizePhrase(phrase) {
  return phrase.normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A redirected report does contain the phrase, but as prose around it. Saying
// that beats "not a valid BIP-39 seed phrase", which sends the reader looking
// for a typo that is not there.
function looksLikeReport(text) {
  return /Seed phrase \(BIP-39,?\s*\d+ words\)/.test(text) || /Receive-chain xpub:/.test(text);
}

// The account and both chains. --expect may be given any of the three xpubs, and
// @scure/bip32 does not keep a link back to the parent, so they are returned
// together rather than derived from each other later.
function walletNodes(mnemonic, passphrase) {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  const account = HDKey.fromMasterSeed(seed).derive(COIN);
  return { account, receive: account.deriveChild(RECEIVE), change: account.deriveChild(CHANGE) };
}

// The public record a backup is checked against years later: account xpub,
// receive-chain xpub and the first addresses. No phrase, no key, so it can be
// committed - though it does tie those addresses and their balances together.
function fingerprintText({ account, receive, change, count, passphrase }) {
  const lines = [
    '# wallet.mjs fingerprint - public data, safe to commit: no phrase, no private key.',
    '# It does reveal these addresses and their balances to whoever reads it.',
    '# Derivation: BIP-84 native SegWit (bech32), Bitcoin mainnet, coin 0; every',
    '# address i is <path>/<chain>/i. See RECOVERY.md if this tool is gone.',
    '# Check a backup against it with:',
    '#   node wallet.mjs --restore --expect-file <this file> < seed.txt',
    '',
    `fingerprint-version: ${FINGERPRINT_VERSION}`,
    // The derivation, spelled out, so the record means something to someone
    // without this tool: address i on a chain is <chain path>/<i>.
    `path: ${COIN}`,
    'coin: 0',
    `receive-path: ${COIN}/${RECEIVE}`,
    `change-path: ${COIN}/${CHANGE}`,
    // Provenance, so a later restore can be told it is missing the 25th word
    // rather than guessing that the phrase is wrong.
    `passphrase: ${passphrase ? 'required' : 'none'}`,
    `account-xpub: ${account.publicExtendedKey}`,
    `receive-chain-xpub: ${receive.publicExtendedKey}`,
    `change-chain-xpub: ${change.publicExtendedKey}`,
  ];
  for (let i = 0; i < count; i += 1) {
    lines.push(`address #${i}: ${addressAt(receive, i).address}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseFingerprint(text) {
  const fields = {
    version: null,
    path: null,
    passphrase: null,
    accountXpub: null,
    receiveXpub: null,
    changeXpub: null,
    addresses: [],
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const entry = /^([a-z][a-z0-9 #-]*):\s*(\S+)$/.exec(trimmed);
    if (!entry) continue;
    const [, key, value] = entry;
    if (key === 'fingerprint-version') fields.version = Number(value);
    else if (key === 'path') fields.path = value;
    else if (key === 'passphrase') fields.passphrase = value;
    else if (key === 'account-xpub') fields.accountXpub = value;
    else if (key === 'receive-chain-xpub') fields.receiveXpub = value;
    else if (key === 'change-chain-xpub') fields.changeXpub = value;
    else if (/^address #\d+$/.test(key)) fields.addresses.push([Number(key.slice('address #'.length)), value]);
  }
  fields.addresses.sort((a, b) => a[0] - b[0]);
  return fields;
}

// A source becomes expectations - what to compare, and against what. Adding a
// third source later means producing these, not another comparison and another
// way of printing the result.
function readRecord(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read --expect-file ${path}`);
  }
}

function expectationsFor(opts, recordText) {
  if (opts.expect !== null) {
    return /^[xt]pub/.test(opts.expect)
      ? [{ kind: 'xpub', value: opts.expect }]
      : [{ kind: 'address-any', value: opts.expect, limit: opts.count ?? CHECKED_ADDRESSES }];
  }

  const fields = parseFingerprint(recordText);
  if (fields.version !== null && fields.version !== FINGERPRINT_VERSION) {
    fail(
      `${opts.expectFile} is fingerprint version ${fields.version}, and this tool reads version ${FINGERPRINT_VERSION}` +
        ' - use the wallet.mjs that wrote it, or re-record the wallet with this one',
    );
  }
  const walletFields =
    fields.accountXpub !== null || fields.receiveXpub !== null || fields.changeXpub !== null || fields.addresses.length > 0;
  if (!walletFields) {
    fail(`${opts.expectFile} is not a wallet fingerprint (no account-xpub, receive-chain-xpub or address lines)`);
  }

  // Provenance first: when the record needs a 25th word, or covers a different
  // path, that is why nothing matches, and it beats comparing the xpubs.
  const expectations = [];
  if (fields.path !== null) expectations.push({ kind: 'path', value: fields.path });
  if (fields.passphrase === 'required' || fields.passphrase === 'none') {
    expectations.push({ kind: 'passphrase', value: fields.passphrase });
  }
  if (fields.accountXpub !== null) expectations.push({ kind: 'account-xpub', value: fields.accountXpub });
  if (fields.receiveXpub !== null) expectations.push({ kind: 'receive-xpub', value: fields.receiveXpub });
  if (fields.changeXpub !== null) expectations.push({ kind: 'change-xpub', value: fields.changeXpub });
  for (const [index, value] of fields.addresses) expectations.push({ kind: 'address', index, value });
  return expectations;
}

// One comparison for every source: each expectation resolves to a check, and
// every check has to agree. The failure this catches is a restore that succeeds
// and yields the wrong wallet - a mistyped phrase that still passes the
// checksum, a missing 25th word, or a backup of a different wallet.
function compareWallet(wallet, expectations) {
  const checks = expectations.map((expectation) => resolveExpectation(expectation, wallet));
  return { ok: checks.every((check) => check.ok), checks };
}

function sameValue(label, expected, actual) {
  return { label, expected, actual, ok: expected === actual };
}

// A value that can never match for a reason other than a wrong phrase says so
// itself, so the advice does not become a growing list of special cases.
function testnetAdvice() {
  return `  that value is testnet and this wallet restores mainnet only (${COIN}); compare it against the mainnet xpub or a bc1 address`;
}

function resolveExpectation(expectation, { account, receive, change, passphrase }) {
  switch (expectation.kind) {
    case 'path':
      return {
        label: 'derivation path',
        expected: expectation.value,
        actual: COIN,
        ok: expectation.value === COIN,
        advice: `  that record covers ${expectation.value} and this tool restores ${COIN} only - it belongs to another network or account`,
      };

    case 'passphrase': {
      const actual = passphrase ? 'required' : 'none';
      return {
        label: 'BIP-39 passphrase',
        expected: expectation.value,
        actual,
        ok: expectation.value === actual,
        advice:
          expectation.value === 'required'
            ? '  this record was made with a 25th word and none was supplied - pass --passphrase-file, answer the prompt, or set BIP39_PASSPHRASE'
            : '  this record was made without a 25th word but one was supplied - drop --passphrase-file, unset BIP39_PASSPHRASE, and answer the prompt with nothing',
      };
    }

    case 'account-xpub':
      return sameValue('account xpub', expectation.value, account.publicExtendedKey);

    case 'receive-xpub':
      return sameValue('receive-chain xpub', expectation.value, receive.publicExtendedKey);

    case 'change-xpub':
      return sameValue(
        'change-chain xpub',
        expectation.value,
        // A receive-chain xpub has no parent here, so its sibling is unknown.
        change === null ? 'unavailable from a receive-chain xpub' : change.publicExtendedKey,
      );

    case 'xpub': {
      // A bare xpub is accepted at either depth, so both are candidates and the
      // label reports which one matched.
      const candidates = [
        ['account xpub', account.publicExtendedKey],
        ['receive-chain xpub', receive.publicExtendedKey],
        ...(change === null ? [] : [['change-chain xpub', change.publicExtendedKey]]),
      ];
      const match = candidates.find(([, actual]) => actual === expectation.value);
      return {
        label: match ? match[0] : 'xpub',
        expected: expectation.value,
        actual: candidates.map(([label, actual]) => `${label} ${actual}`).join('\n    '),
        ok: Boolean(match),
        advice: /^tpub/.test(expectation.value) ? testnetAdvice() : undefined,
      };
    }

    case 'address':
      return sameValue(
        `address #${expectation.index}`,
        expectation.value,
        addressAt(receive, expectation.index).address,
      );

    case 'address-any': {
      // A bare address may be on either chain, at any index in the window - a
      // change address is still this wallet. When none matches, listing what was
      // compared adds nothing, so the range and a sample suffice.
      const seen = [
        ...Array.from({ length: expectation.limit }, (_, index) => ({
          label: `address #${index}`,
          address: addressAt(receive, index).address,
        })),
        ...(change === null
          ? []
          : Array.from({ length: expectation.limit }, (_, index) => ({
              label: `change #${index}`,
              address: addressAt(change, index, CHANGE).address,
            }))),
      ];
      const match = seen.find(({ address }) => address === expectation.value);
      return {
        label: match ? match.label : `address #0..#${expectation.limit - 1}`,
        expected: expectation.value,
        actual: match
          ? match.address
          : `no match on either chain in #0..#${expectation.limit - 1}; #0 is ${seen[0].address}`,
        ok: Boolean(match),
        advice: /^tb1/.test(expectation.value) ? testnetAdvice() : undefined,
      };
    }

    default:
      return sameValue(expectation.kind, expectation.value, 'no such expectation');
  }
}

// A redirect writes wherever the shell's umask or Windows ACLs put it. --out is
// the file the tool creates itself: owner-only where the platform has modes, and
// never over an existing file - overwriting an old backup silently destroys it.
function writeSecret(path, text) {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      fail(`${path} already exists - --out never overwrites; choose a new path or remove it first`);
    }
    fail(`cannot write ${path}: ${err.message}`);
  }
  // Ask the filesystem rather than trust the request: Windows ignores the mode,
  // and saying "owner-only" there would be a promise the file does not keep.
  const mode = statSync(path).mode & 0o777;
  console.log(
    (mode & 0o077) === 0
      ? `Wrote ${path} (0600: owner only).`
      : `Wrote ${path}, but this platform kept the folder's permissions (mode ${mode.toString(8)}): keep it on an encrypted volume.`,
  );
}

// A backup check that is never repeated is only presumed good. Record when it
// last succeeded; a failed one leaves the old timestamp alone rather than
// pretending the drill happened.
function recordVerification(path, record, recordText) {
  // The hash covers the bytes that were checked, taken from memory rather than
  // read again: a record swapped between the two reads would otherwise be pinned
  // without having been verified. Absolute, so a later run from another
  // directory still compares against the same file.
  const state = {
    verifiedAt: new Date().toISOString(),
    record: resolve(record),
    recordHash: recordDigest(recordText),
  };
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`Recorded in ${path}; watchdog.mjs reports it once it goes stale or the record changes.`);
  } catch (err) {
    console.error(`warning: the check passed but ${path} could not be written: ${err.message}`);
  }
}

// The one place the outcome is printed, whatever produced the expectations.
function reportVerdict(verdict, source) {
  console.log('');
  if (verdict.ok) {
    console.log(`Verified: the restored wallet matches ${source} (${summarize(verdict.checks)}).`);
    return;
  }

  const detail = verdict.checks
    .filter((check) => !check.ok)
    .map((check) => `  ${check.label}\n    expected  ${check.expected}\n    restored  ${check.actual}`)
    .join('\n');
  console.error(`error: ${source} does not match the restored wallet\n${detail}`);
  // The first check that knows why it failed explains; otherwise the reader gets
  // the honest guess.
  const advice = verdict.checks.find((check) => !check.ok && check.advice)?.advice;
  console.error(advice ?? '  the phrase, the passphrase or the recorded value is wrong - do not fund this wallet');
  process.exitCode = EXIT_MISMATCH;
}

// "account xpub, receive-chain xpub, addresses #0..#4": consecutive addresses
// collapse, so five of them do not become five clauses.
function summarize(checks) {
  const labels = checks.map((check) => check.label);
  const isAddress = (label) => /^address #\d+$/.test(label);
  const indices = labels
    .filter(isAddress)
    .map((label) => Number(label.slice('address #'.length)))
    .sort((a, b) => a - b);
  const rest = labels.filter((label) => !isAddress(label));
  if (indices.length === 1) rest.push(`address #${indices[0]}`);
  else if (indices.length > 1) rest.push(`addresses #${indices[0]}..#${indices[indices.length - 1]}`);
  return rest.join(', ');
}

// Version bytes tell an xpub (mainnet) from a tpub (testnet); passing them keeps
// a tpub from being rejected as an invalid key.
const TESTNET = bitcoin.networks.testnet;
const XPUB_VERSIONS = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4 },
  tpub: { public: 0x043587cf, private: 0x04358394 },
};

// Accepts an account key (m/84'/COIN'/0') or its receive chain
// (m/84'/COIN'/0'/0), from an xpub (mainnet) or tpub (testnet).
function xpubNodes(xpub) {
  const prefix = xpub.slice(0, 4).toLowerCase();
  if (prefix === 'xprv' || prefix === 'tprv') {
    fail('that is an extended private key; pass its matching xpub (or tpub) instead');
  }
  const kind = prefix === 'xpub' ? 'mainnet' : prefix === 'tpub' ? 'testnet' : null;
  if (kind === null) fail('expected an extended public key: xpub (mainnet) or tpub (testnet)');

  let node;
  try {
    node = HDKey.fromExtendedKey(xpub, XPUB_VERSIONS[prefix]);
  } catch {
    fail('that is not a valid extended public key (expected an xpub or tpub)');
  }
  if (node.privateKey) fail('that is an extended private key; pass its matching xpub (or tpub) instead');

  const network = kind === 'mainnet' ? NETWORK : TESTNET;
  const account = `m/84'/${kind === 'mainnet' ? 0 : 1}'/0'`;
  if (node.depth === 3) {
    return { receive: node.deriveChild(RECEIVE), change: node.deriveChild(CHANGE), network, account, kind };
  }
  if (node.depth === 4) {
    // The change chain is a sibling of the receive chain; a depth-4 key has no
    // parent here to reach it from.
    return { receive: node, change: null, network, account, kind };
  }
  fail(
    `unsupported xpub depth ${node.depth}; pass the account key (${account}) ` +
      `or its receive chain (${account}/${RECEIVE})`,
  );
}

function addressAt(node, index, chain = RECEIVE, network = NETWORK, account = COIN) {
  const child = node.deriveChild(index);
  const pubkey = Buffer.from(child.publicKey);
  const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
  if (!address) fail(`could not encode an address for index ${index}`);
  return { address, child, path: `${account}/${chain}/${index}` };
}

function printAddresses(label, node, { chain = RECEIVE, count, network = NETWORK, account = COIN }) {
  console.log(label);
  for (let i = 0; i < count; i += 1) {
    const { address, path } = addressAt(node, i, chain, network, account);
    console.log(`  #${i}  ${path.padEnd(18)}  ${address}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Both modes write a secret to stdout, and a terminal keeps it in scrollback -
  // the exact place these flags exist to keep it out of. A redirect or a pipe is
  // accepted; --show-key can be pressed past with --allow-tty, but a phrase is
  // never printed to a terminal.
  if (process.stdout.isTTY) {
    // With --out the secret goes to a file the tool made, not to the terminal,
    // so these refusals have nothing left to protect.
    if (opts.phraseOnly && opts.out === null) {
      fail(
        '--phrase-only refuses to print the seed phrase to a terminal - ' +
          'write it with node wallet.mjs --phrase-only --out seed.txt instead',
      );
    }
    if (opts.showKey && !opts.allowTty && opts.out === null) {
      fail('--show-key would print a private key to this terminal - redirect the output, or pass --allow-tty to print it anyway');
    }
  }

  // Printing one address answers "where do I get paid"; --count asks for more.
  const shownCount = opts.count ?? 1;

  if (opts.xpub !== null) {
    const { receive, change, network, account, kind } = xpubNodes(opts.xpub);
    console.log('Derived from an extended public key - public data only.');
    console.log('');
    console.log(`Account ${account} - BIP-84 native SegWit (bech32), Bitcoin ${kind}`);
    console.log('');
    printAddresses('Receive addresses:', receive, { count: shownCount, network, account });
    console.log('');
    if (change === null) {
      console.log('Change addresses: unavailable from a receive-chain xpub - pass the account key to derive them.');
    } else {
      printAddresses(`Change addresses (${account}/${CHANGE}, never handed out):`, change, {
        chain: CHANGE,
        count: shownCount,
        network,
        account,
      });
    }
    console.log('');
    console.log('Watch-only: an xpub yields addresses only, never a private key.');
    return;
  }

  // Phrase-only is its own mode, like --xpub: generate, write, stop. The report
  // below is not a backup, because --restore wants a phrase and not prose, so
  // this writes the 24 words and nothing else - which makes `> seed.txt` a file
  // --restore accepts.
  if (opts.phraseOnly) {
    // Phrase-only derives nothing, so it reads the passphrase to say whether one
    // would be needed - never to ask for it.
    const passphrase = await resolvePassphrase(opts, { prompt: false });
    if (passphrase) {
      process.stderr.write(
        'note: BIP39_PASSPHRASE is set, so this phrase alone restores a different wallet\n',
      );
    }
    const phrase = generateMnemonic(256);
    if (opts.out !== null) writeSecret(opts.out, `${phrase}\n`);
    else process.stdout.write(`${phrase}\n`);
    return;
  }

  let mnemonic;
  if (opts.restore) {
    const raw =
      opts.phraseFile !== null
        ? readPhraseFile(opts.phraseFile, opts.allowLoosePermissions)
        : await readPhrase();
    mnemonic = normalizePhrase(raw);
    if (!mnemonic) {
      fail(opts.phraseFile !== null ? `no seed phrase in ${opts.phraseFile}` : 'no seed phrase received on stdin');
    }
    if (looksLikeReport(raw)) {
      fail(
        'that input is the full report from wallet.mjs, not a seed phrase\n' +
          '  the phrase is the 24-word line inside it - extract just that line\n' +
          '  or generate again with --phrase-only --out seed.txt, which writes only\n' +
          '  the words and creates the file 0600, so --restore accepts it directly',
      );
    }
    if (!validateMnemonic(mnemonic)) {
      fail(
        'that is not a valid BIP-39 seed phrase (expects 12, 15, 18, 21 or 24 words ' +
          'with correct spelling and checksum; raw private keys and xprv/xpub are not supported)',
      );
    }
  } else {
    mnemonic = generateMnemonic(256);
  }

  // After the phrase, so an interactive run asks for the passphrase second.
  const passphrase = await resolvePassphrase(opts);
  const { account, receive, change } = walletNodes(mnemonic, passphrase);

  if (opts.restore) {
    const wordCount = mnemonic.split(' ').length;
    const phraseNote = passphrase ? 'with a BIP-39 passphrase' : 'no BIP-39 passphrase';
    console.log(`Restored from a ${wordCount}-word BIP-39 seed phrase (${phraseNote}).`);
    console.log(`Receive-chain xpub: ${receive.publicExtendedKey ?? '(unavailable)'}`);
    console.log('');
  } else {
    console.log('Fresh Bitcoin wallet, generated locally. No network calls, nothing written to disk.');
    console.log('');
    console.log('Seed phrase (BIP-39, 24 words) - this is the wallet. Store it offline:');
    console.log('');
    console.log(`  ${mnemonic}`);
    console.log('');
  }

  console.log(`Account ${COIN} - BIP-84 native SegWit (bech32), Bitcoin mainnet`);
  console.log('');
  printAddresses('Receive addresses:', receive, { count: shownCount });
  console.log('');
  printAddresses(`Change addresses (${COIN}/${CHANGE}, never handed out):`, change, {
    chain: CHANGE,
    count: shownCount,
  });

  if (opts.showKey) {
    const { address, child } = addressAt(receive, 0);
    const key = encodeWIF({
      version: 0x80,
      privateKey: Buffer.from(child.privateKey),
      compressed: true,
    });
    if (opts.out !== null) {
      writeSecret(opts.out, `${key}\n`);
    } else {
      console.log('');
      console.log(`Private key (WIF) for #0 ${address}:`);
      console.log(`  ${key}`);
    }
  }

  // Deriving the same address is not the same as being able to move from it, and
  // the difference only shows up on the day the backup is needed.
  if (opts.spendCheck) {
    const { address, child } = addressAt(receive, 0);
    const proof = spendProof({ child, address, network: NETWORK });
    console.log('');
    if (proof.ok) {
      console.log(`Spend check: the key for #0 ${address} signed a spend of it, and the signature verifies.`);
      console.log('  The transaction was discarded and nothing was broadcast: this backup can spend, not only derive.');
    } else {
      console.error(`error: the restored key cannot spend address #0 ${address} - ${proof.reason}`);
      console.error('  do not fund this wallet: a backup that cannot sign for its own address cannot rescue it');
      process.exitCode = EXIT_MISMATCH;
    }
  }

  console.log('');
  console.log(
    opts.restore
      ? 'Any BIP-84 wallet restored from this phrase and passphrase shows these same addresses.'
      : 'Anyone holding the seed phrase or private key can spend these funds.',
  );

  if (opts.fingerprint !== null) {
    const text = fingerprintText({
      account,
      receive,
      change,
      count: opts.count ?? CHECKED_ADDRESSES,
      passphrase,
    });
    if (opts.fingerprint === '-') {
      process.stdout.write(text);
    } else {
      writeFileSync(opts.fingerprint, text);
      console.error(`wrote ${opts.fingerprint} - no phrase and no key in it, so it is safe to commit`);
    }
  }

  // Last, so the outcome is the final line a human reads. Both sources go
  // through the same comparison and the same report.
  if (opts.expect !== null || opts.expectFile !== null) {
    const source = opts.expectFile !== null ? `--expect-file ${opts.expectFile}` : '--expect';
    const recordText = opts.expectFile !== null ? readRecord(opts.expectFile) : null;
    const verdict = compareWallet({ account, receive, change, passphrase }, expectationsFor(opts, recordText));
    reportVerdict(verdict, source);
    if (verdict.ok && opts.expectFile !== null) recordVerification(opts.verifyState, opts.expectFile, recordText);
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
