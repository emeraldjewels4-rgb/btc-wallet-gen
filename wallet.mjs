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
 * No network calls, nothing written to disk.
 *
 * Usage:
 *   node wallet.mjs                       generate: seed phrase + address #0
 *   node wallet.mjs --count 5             generate: first 5 receive addresses
 *   node wallet.mjs --show-key            also print the WIF key for address #0
 *   node wallet.mjs --restore < seed.txt  restore: derive addresses from a phrase
 *   node wallet.mjs --restore             restore: paste the phrase on stdin
 *   node wallet.mjs --xpub XPUB           derive addresses from a public xpub or tpub
 *
 * A BIP-39 passphrase (the optional 25th word) is read from BIP39_PASSPHRASE.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { encode as encodeWIF } from 'wif';

const NETWORK = bitcoin.networks.bitcoin;
const COIN = "m/84'/0'/0'"; // BIP-84 account: native SegWit, account 0
const RECEIVE = 0; // external chain: addresses handed out to payers
// Same meaning as in the treasury tools: a safety check said no. Used when the
// restored wallet does not match the value recorded for it.
const EXIT_MISMATCH = 3;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node wallet.mjs [--restore] [--count N] [--show-key] [--phrase-only] [--expect VALUE]

  --restore     derive addresses from an existing seed phrase read from stdin
                (pipe it in: node wallet.mjs --restore < seed.txt)
  --xpub XPUB   derive addresses from an extended public key instead of a seed
                (xpub for mainnet, tpub for testnet; account m/84'/COIN'/0'
                or its receive chain m/84'/COIN'/0'/0)
  --count N     number of receive addresses to print (1-20, default 1)
  --show-key    also print the WIF private key for address #0; to a terminal it
                refuses unless --allow-tty is passed
  --allow-tty   print that private key to the terminal anyway
  --phrase-only print only the new seed phrase on stdout, one line and nothing
                else, so 'node wallet.mjs --phrase-only > seed.txt' is a backup
                that --restore accepts; generation only, never with --show-key,
                and it refuses to run when stdout is a terminal
  --expect VALUE check the restored wallet against an xpub, tpub or address
                recorded when it was created; a mismatch exits 3, so a wrong
                phrase or passphrase fails instead of looking like a restore
  -h, --help    show this help

BIP-39 passphrase: set BIP39_PASSPHRASE in the environment.

Exit codes: 0 ok, 1 usage or config error, 3 the restored wallet does not
            match --expect (nothing was printed that could be mistaken for
            success, and no wallet should be funded from it).`);
}

function parseArgs(argv) {
  const opts = { count: 1, showKey: false, allowTty: false, restore: false, phraseOnly: false, xpub: null, expect: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--show-key' || arg === '--show-private-key') {
      opts.showKey = true;
    } else if (arg === '--allow-tty') {
      opts.allowTty = true;
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
  if (opts.expect !== null && !opts.restore) fail('--expect compares a restored wallet, so it needs --restore');
  if (opts.phraseOnly && (opts.restore || opts.xpub !== null || opts.showKey)) {
    fail('--phrase-only writes a new seed phrase and nothing else, so it cannot be combined with --restore, --xpub or --show-key');
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

// BIP-39 phrases are compared after Unicode normalization, case folding and
// whitespace collapse, so pasted phrases with stray newlines still match.
function normalizePhrase(phrase) {
  return phrase.normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Returns both nodes: --expect may be given either the account xpub
// (m/84'/COIN'/0') or the receive-chain one (m/84'/COIN'/0'/0), and @scure/bip32
// does not keep a link back to the parent.
function receiveNode(mnemonic, passphrase) {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  const account = HDKey.fromMasterSeed(seed).derive(COIN);
  return { account, receive: account.deriveChild(RECEIVE) };
}

// Compares a restored wallet against a value recorded when it was created. The
// failure this catches is a restore that succeeds and yields the wrong wallet:
// a mistyped phrase that still passes the checksum, a missing 25th word, or a
// backup of a different wallet entirely.
function compareExpectation(expect, { account, receive }, count) {
  const wanted = expect.trim();

  if (/^[xt]pub/.test(wanted)) {
    const known = [
      ['receive-chain xpub', receive.publicExtendedKey],
      ['account xpub', account.publicExtendedKey],
    ];
    const match = known.find(([, value]) => value === wanted);
    if (match) return { ok: true, what: match[0] };
    return {
      ok: false,
      detail:
        `  expected     ${wanted}\n` +
        known.map(([name, value]) => `  restored     ${value} (${name})`).join('\n'),
    };
  }

  const addresses = Array.from({ length: count }, (_, index) => receiveAddress(receive, index).address);
  const index = addresses.indexOf(wanted);
  if (index !== -1) return { ok: true, what: `address #${index}` };
  return {
    ok: false,
    detail:
      `  expected     ${wanted}\n` +
      addresses.map((address, i) => `  restored #${i}  ${address}`).join('\n'),
  };
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
function xpubReceiveNode(xpub) {
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
  if (node.depth === 3) return { receive: node.deriveChild(RECEIVE), network, account, kind };
  if (node.depth === 4) return { receive: node, network, account, kind };
  fail(
    `unsupported xpub depth ${node.depth}; pass the account key (${account}) ` +
      `or its receive chain (${account}/${RECEIVE})`,
  );
}

function receiveAddress(node, index, network = NETWORK, account = COIN) {
  const child = node.deriveChild(index);
  const pubkey = Buffer.from(child.publicKey);
  const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
  if (!address) fail(`could not encode an address for index ${index}`);
  return { address, child, path: `${account}/${RECEIVE}/${index}` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const passphrase = process.env.BIP39_PASSPHRASE ?? '';

  // Both modes write a secret to stdout, and a terminal keeps it in scrollback -
  // the exact place these flags exist to keep it out of. A redirect or a pipe is
  // accepted; --show-key can be pressed past with --allow-tty, but a phrase is
  // never printed to a terminal.
  if (process.stdout.isTTY) {
    if (opts.phraseOnly) {
      fail('--phrase-only refuses to print the seed phrase to a terminal - redirect it, e.g. node wallet.mjs --phrase-only > seed.txt');
    }
    if (opts.showKey && !opts.allowTty) {
      fail('--show-key would print a private key to this terminal - redirect the output, or pass --allow-tty to print it anyway');
    }
  }

  if (opts.xpub !== null) {
    const { receive, network, account, kind } = xpubReceiveNode(opts.xpub);
    console.log('Derived from an extended public key - public data only.');
    console.log('');
    console.log(`Account ${account} - BIP-84 native SegWit (bech32), Bitcoin ${kind}`);
    console.log('');
    console.log('Receive addresses:');
    for (let i = 0; i < opts.count; i += 1) {
      const { address, path } = receiveAddress(receive, i, network, account);
      console.log(`  #${i}  ${path.padEnd(18)}  ${address}`);
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
    if (passphrase) {
      process.stderr.write(
        'note: BIP39_PASSPHRASE is set, so this phrase alone restores a different wallet\n',
      );
    }
    process.stdout.write(`${generateMnemonic(256)}\n`);
    return;
  }

  let mnemonic;
  if (opts.restore) {
    mnemonic = normalizePhrase(await readPhrase());
    if (!mnemonic) fail('no seed phrase received on stdin');
    if (!validateMnemonic(mnemonic)) {
      fail(
        'that is not a valid BIP-39 seed phrase (expects 12, 15, 18, 21 or 24 words ' +
          'with correct spelling and checksum; raw private keys and xprv/xpub are not supported)',
      );
    }
  } else {
    mnemonic = generateMnemonic(256);
  }

  const { account, receive } = receiveNode(mnemonic, passphrase);

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
  console.log('Receive addresses:');
  for (let i = 0; i < opts.count; i += 1) {
    const { address, path } = receiveAddress(receive, i);
    console.log(`  #${i}  ${path.padEnd(18)}  ${address}`);
  }

  if (opts.showKey) {
    const { address, child } = receiveAddress(receive, 0);
    const key = encodeWIF({
      version: 0x80,
      privateKey: Buffer.from(child.privateKey),
      compressed: true,
    });
    console.log('');
    console.log(`Private key (WIF) for #0 ${address}:`);
    console.log(`  ${key}`);
  }

  console.log('');
  console.log(
    opts.restore
      ? 'Any BIP-84 wallet restored from this phrase and passphrase shows these same addresses.'
      : 'Anyone holding the seed phrase or private key can spend these funds.',
  );

  // Last, so the outcome is the final line a human reads.
  if (opts.expect !== null) {
    const verdict = compareExpectation(opts.expect, { account, receive }, opts.count);
    console.log('');
    if (verdict.ok) {
      console.log(`Verified: the restored ${verdict.what} matches --expect.`);
    } else {
      console.error(`error: --expect does not match the restored wallet\n${verdict.detail}`);
      console.error('  the phrase, the passphrase or the recorded value is wrong - do not fund this wallet');
      process.exitCode = EXIT_MISMATCH;
    }
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
