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

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node wallet.mjs [--restore] [--count N] [--show-key]

  --restore     derive addresses from an existing seed phrase read from stdin
                (pipe it in: node wallet.mjs --restore < seed.txt)
  --xpub XPUB   derive addresses from an extended public key instead of a seed
                (xpub for mainnet, tpub for testnet; account m/84'/COIN'/0'
                or its receive chain m/84'/COIN'/0'/0)
  --count N     number of receive addresses to print (1-20, default 1)
  --show-key    also print the WIF private key for address #0
  -h, --help    show this help

BIP-39 passphrase: set BIP39_PASSPHRASE in the environment.`);
}

function parseArgs(argv) {
  const opts = { count: 1, showKey: false, restore: false, xpub: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--show-key' || arg === '--show-private-key') {
      opts.showKey = true;
    } else if (arg === '--restore') {
      opts.restore = true;
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

function receiveNode(mnemonic, passphrase) {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  return HDKey.fromMasterSeed(seed).derive(COIN).deriveChild(RECEIVE);
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

  const receive = receiveNode(mnemonic, passphrase);

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
}

main().catch((err) => fail(err?.message ?? String(err)));
