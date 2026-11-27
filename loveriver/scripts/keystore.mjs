#!/usr/bin/env node
// Web3 Secret Storage (V3) keystores for the loveriver wallet set.
//
//   encrypt            wallets/admins.csv + wallets/holders.csv
//                      -> wallets/keystores/{admins,holders}/<address>.json
//   encrypt-treasury   TREASURY_PRIVATE_KEY -> wallets/treasury.keystore.json
//   verify             open every keystore and match it to its filename
//   decrypt            one keystore -> one key file, for spending that wallet
//   remove-plaintext   delete the CSVs once every address has a keystore
//
// Each file is scrypt + aes-128-ctr + keccak256, the format geth, MyEtherWallet
// and ethers read. Private keys are only ever written to files, never printed.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flag, loadEnv } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const walletDir = resolve(root, flag('dir', 'wallets'));
const groups = ['admins', 'holders'];
const MIN_PASSPHRASE = 12;

// scrypt cost. 2^16 takes ~0.2s per wallet here, so the whole set is ~40
// minutes once; raise it with --n for a slower but stronger file.
function scryptCost() {
  const cost = Number(flag('n', 2 ** 16));
  if (!Number.isInteger(cost) || cost < 2 ** 10 || cost > 2 ** 20 || (cost & (cost - 1)) !== 0) {
    console.error('--n must be a power-of-two scrypt cost between 1024 and 1048576');
    process.exit(1);
  }
  return cost;
}

const checksum = (value) => getAddress(`0x${String(value).replace(/^0x/, '')}`);

function derive(password, salt, params) {
  return scryptSync(password.normalize('NFKD'), salt, params.dklen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.n * params.r,
  });
}

/** privateKey (0x…) + password -> Web3 Secret Storage V3 object. */
export function encryptKey(privateKey, password, n = 2 ** 16) {
  const scryptParams = { dklen: 32, n, r: 8, p: 1 };
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = derive(password, salt, scryptParams);
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.replace(/^0x/, ''), 'hex')),
    cipher.final(),
  ]);
  // Keystores carry the MAC as bare hex, so drop viem's 0x prefix.
  const mac = keccak256(`0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString('hex')}`).slice(2);

  return {
    version: 3,
    id: randomUUID(),
    address: privateKeyToAccount(privateKey).address.slice(2).toLowerCase(),
    crypto: {
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      cipher: 'aes-128-ctr',
      kdf: 'scrypt',
      kdfparams: {
        dklen: scryptParams.dklen,
        salt: salt.toString('hex'),
        n: scryptParams.n,
        r: scryptParams.r,
        p: scryptParams.p,
      },
      mac,
    },
  };
}

/** Web3 Secret Storage V3 object + password -> private key (0x…). */
export function decryptKey(keystore, password) {
  // geth writes "crypto", the specification and ethers say "Crypto".
  const crypto = keystore.crypto ?? keystore.Crypto;
  if (crypto?.cipher !== 'aes-128-ctr' || crypto?.kdf !== 'scrypt') {
    throw new Error(`unsupported keystore (cipher ${crypto?.cipher}, kdf ${crypto?.kdf})`);
  }
  const params = crypto.kdfparams;
  const derived = derive(password, Buffer.from(params.salt, 'hex'), params);
  const ciphertext = Buffer.from(crypto.ciphertext, 'hex');
  const expected = Buffer.from(crypto.mac.replace(/^0x/, ''), 'hex');
  const actual = Buffer.from(
    keccak256(`0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString('hex')}`).slice(2),
    'hex',
  );
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('wrong passphrase (keystore MAC does not match)');
  }
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(crypto.cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${key.toString('hex')}`;
}

function readSecret(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('the passphrase prompt needs an interactive terminal'));
  }
  return new Promise((resolveValue, reject) => {
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolveValue(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char < ' ') continue;
        value += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function askPassphrase(confirm, label = 'passphrase: ') {
  const password = await readSecret(label);
  if (password.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  if (confirm) {
    const again = await readSecret('repeat passphrase: ');
    if (again !== password) throw new Error('passphrases do not match');
  }
  return password;
}

function readGroup(group) {
  const file = join(walletDir, `${group}.csv`);
  if (!existsSync(file)) {
    console.error(`missing ${file}; run: npm run wallets`);
    process.exit(1);
  }
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [index, address, privateKey] = line.split(',');
      return { index: Number(index), address: checksum(address), privateKey };
    });
}

function keystoreFiles(group) {
  const dir = join(walletDir, 'keystores', group);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

async function encrypt() {
  const cost = scryptCost();
  const password = await askPassphrase(true);
  const rows = groups.flatMap((group) =>
    readGroup(group).map((row) => ({ ...row, group, file: join(walletDir, 'keystores', group, `${row.address.slice(2).toLowerCase()}.json`) })),
  );
  const existing = rows.filter((row) => existsSync(row.file));
  if (existing.length > 0 && !process.argv.includes('--force')) {
    console.error(`${existing.length} keystores already exist; pass --force to re-encrypt them`);
    process.exit(1);
  }

  mkdirSync(join(walletDir, 'keystores', 'admins'), { recursive: true });
  mkdirSync(join(walletDir, 'keystores', 'holders'), { recursive: true });

  const started = Date.now();
  let done = 0;
  for (const row of rows) {
    writeFileSync(row.file, `${JSON.stringify(encryptKey(row.privateKey, password, cost), null, 2)}\n`, { mode: 0o600 });
    done += 1;
    if (done % 250 === 0 || done === rows.length) {
      const seconds = (Date.now() - started) / 1000;
      console.log(`${done}/${rows.length} encrypted (${seconds.toFixed(0)}s, ${(done / seconds).toFixed(1)}/s)`);
    }
  }

  // Read back what is on disk, then prove the passphrase opens a sample.
  for (const group of groups) {
    const expected = readGroup(group);
    const names = keystoreFiles(group);
    const seen = new Set();
    for (const name of names) {
      const keystore = JSON.parse(readFileSync(join(walletDir, 'keystores', group, name), 'utf8'));
      seen.add(checksum(keystore.address));
    }
    const missing = expected.filter((row) => !seen.has(row.address));
    if (missing.length > 0 || names.length !== expected.length) {
      console.error(`${group}: ${names.length} keystores for ${expected.length} wallets; not deleting anything`);
      process.exit(1);
    }
    for (const row of [expected[0], expected[expected.length - 1]]) {
      const file = join(walletDir, 'keystores', group, `${row.address.slice(2).toLowerCase()}.json`);
      const key = decryptKey(JSON.parse(readFileSync(file, 'utf8')), password);
      if (privateKeyToAccount(key).address !== row.address) {
        console.error(`${file} does not decrypt back to ${row.address}`);
        process.exit(1);
      }
    }
  }

  console.log(`\n${rows.length} keystores in ${walletDir.slice(root.length + 1)}/keystores (scrypt N=${cost}, mode 0600, git-ignored)`);
  console.log('back the folder up together with the passphrase; without it the keys are unrecoverable.');
  console.log('then run: npm run keystore -- remove-plaintext');
}

// encrypt only proves the passphrase opens the first and last wallet of each
// group, and remove-plaintext then deletes the CSV fallback. This opens every
// file instead: a keystore has to decrypt with the passphrase and yield the
// address its filename claims, or that wallet is lost the moment the CSVs go.
async function verify() {
  const total = groups.reduce((sum, group) => sum + keystoreFiles(group).length, 0);
  if (total === 0) {
    console.error(`no keystores under ${relative(root, join(walletDir, 'keystores'))}; run: npm run keystore -- encrypt`);
    process.exit(1);
  }

  const password = await askPassphrase(false);

  // Fail fast on the usual cause: one wrong passphrase fails every file, and
  // walking 10,004 scrypt derivations to say so would take the better part of
  // an hour. This cannot tell a wrong passphrase from a damaged first file, so
  // the message says both.
  const first = groups.flatMap((group) => keystoreFiles(group).map((name) => join(walletDir, 'keystores', group, name)))[0];
  try {
    decryptKey(JSON.parse(readFileSync(first, 'utf8')), password);
  } catch (error) {
    console.error(`${relative(root, first)}: ${error.message}`);
    console.error('wrong passphrase, or that one file is damaged; nothing else was checked.');
    process.exit(1);
  }

  const started = Date.now();
  const problems = [];
  let checked = 0;

  for (const group of groups) {
    for (const name of keystoreFiles(group)) {
      const file = join(walletDir, 'keystores', group, name);
      const label = `${group}/${name}`;
      let keystore;
      try {
        keystore = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        problems.push(`${label}: not readable as JSON (${error.message})`);
        continue;
      }

      let address;
      try {
        address = privateKeyToAccount(decryptKey(keystore, password)).address;
      } catch (error) {
        problems.push(
          /wrong passphrase/.test(error.message)
            ? `${label}: does not decrypt with this passphrase (damaged, or encrypted with another one)`
            : `${label}: ${error.message}`,
        );
        continue;
      }

      // The filename is what decrypt and distribution look the wallet up by.
      const expectedName = `${address.slice(2).toLowerCase()}.json`;
      if (name !== expectedName) {
        problems.push(`${label}: holds the key for ${address}, but is named for ${name.replace(/\.json$/, '')}`);
      }
      if (typeof keystore.address === 'string' && checksum(keystore.address) !== address) {
        problems.push(`${label}: holds the key for ${address}, but records ${keystore.address}`);
      }

      checked += 1;
      if (checked % 500 === 0 || checked === total) {
        const seconds = (Date.now() - started) / 1000;
        console.log(`${checked}/${total} verified (${seconds.toFixed(0)}s, ${(checked / seconds).toFixed(1)}/s)`);
      }
    }
  }

  const seconds = (Date.now() - started) / 1000;
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    if (problems.length > 20) console.error(`  ... ${problems.length - 20} more`);
    console.error(`\nverify failed: ${problems.length} problem(s) in ${total} keystores under ${relative(root, walletDir)}`);
    console.error('do not delete the CSVs while a wallet has no valid keystore.');
    process.exit(1);
  }

  console.log(
    `\nverified: ${total} keystores under ${relative(root, walletDir)} each decrypt to the address in their filename (${seconds.toFixed(0)}s)`,
  );
  console.log('the plaintext CSVs are no longer needed; keep the passphrase and an offline copy.');
}

async function encryptTreasury() {
  loadEnv(root);
  const value = (process.env.TREASURY_PRIVATE_KEY ?? '').trim();
  if (!value) {
    console.error('set TREASURY_PRIVATE_KEY in .env to the plaintext 0x... key first');
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    console.error('TREASURY_PRIVATE_KEY is not a 0x... private key; it may already be a keystore');
    process.exit(1);
  }

  const file = join(walletDir, 'treasury.keystore.json');
  if (existsSync(file) && !process.argv.includes('--force')) {
    console.error(`${relative(root, file)} already exists; pass --force to replace it`);
    process.exit(1);
  }

  const cost = scryptCost();
  const password = await askPassphrase(true);
  const address = privateKeyToAccount(value).address;
  mkdirSync(walletDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(encryptKey(value, password, cost), null, 2)}\n`, { mode: 0o600 });

  const keystore = JSON.parse(readFileSync(file, 'utf8'));
  if (privateKeyToAccount(decryptKey(keystore, password)).address !== address) {
    console.error(`${relative(root, file)} does not decrypt back to ${address}`);
    process.exit(1);
  }

  console.log(
    `\ntreasury keystore for ${address} written to ${relative(root, file)} (scrypt N=${cost}, mode 0600, git-ignored)`,
  );
  console.log('back it up with the wallet keystores, and keep the passphrase off the machine.');
  console.log('then in .env set: TREASURY_PRIVATE_KEY=wallets/treasury.keystore.json');
  console.log('(or blank the line to use that default path) and delete the plaintext key.');
  console.log('deploy and distribute prompt for the passphrase once per run.');
}

async function decrypt() {
  const addressFlag = flag('address');
  if (!addressFlag) {
    console.error('usage: npm run keystore -- decrypt --address 0x... [--out file]');
    process.exit(1);
  }
  const address = checksum(addressFlag);
  const name = `${address.slice(2).toLowerCase()}.json`;
  const file = groups.map((group) => join(walletDir, 'keystores', group, name)).find((path) => existsSync(path));
  if (!file) {
    console.error(`no keystore for ${address} under wallets/keystores`);
    process.exit(1);
  }

  const password = await askPassphrase(false);
  const key = decryptKey(JSON.parse(readFileSync(file, 'utf8')), password);
  if (privateKeyToAccount(key).address !== address) {
    console.error(`${file} decrypted to the wrong address`);
    process.exit(1);
  }

  const out = resolve(root, flag('out', join('wallets', `${address}.key`)));
  writeFileSync(out, `${key}\n`, { mode: 0o600 });
  console.log(`key for ${address} written to ${out} (mode 0600, plaintext)`);
  console.log('use it, then delete that file.');
}

function removePlaintext() {
  for (const group of groups) {
    if (!existsSync(join(walletDir, `${group}.csv`))) continue;
    const expected = readGroup(group);
    const keystoreDir = join(walletDir, 'keystores', group);
    const seen = new Set(
      keystoreFiles(group).map((name) =>
        checksum(JSON.parse(readFileSync(join(keystoreDir, name), 'utf8')).address),
      ),
    );
    const missing = expected.filter((row) => !seen.has(row.address));
    if (missing.length > 0 || seen.size !== expected.length) {
      console.error(`${group}: ${missing.length} of ${expected.length} wallets have no keystore yet; keeping ${group}.csv`);
      process.exit(1);
    }
  }
  for (const group of groups) {
    const file = join(walletDir, `${group}.csv`);
    if (!existsSync(file)) continue;
    unlinkSync(file);
    console.log(`deleted ${file}`);
  }
  console.log('only the keystores remain; distribution reads their addresses.');
}

// Importable for tests; the CLI only runs when this file is the entry point.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === 'encrypt') await encrypt();
    else if (command === 'encrypt-treasury') await encryptTreasury();
    else if (command === 'verify') await verify();
    else if (command === 'decrypt') await decrypt();
    else if (command === 'remove-plaintext') removePlaintext();
    else {
      console.error(
        'usage: npm run keystore -- encrypt | encrypt-treasury | verify | decrypt --address 0x... | remove-plaintext',
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(`keystore: ${error.message}`);
    process.exit(1);
  }
}
