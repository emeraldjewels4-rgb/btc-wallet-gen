#!/usr/bin/env node
// Generates the loveriver wallet set: 5 admin wallets and 9,999 holder
// wallets, each a fresh secp256k1 key pair, plus the address-only list the
// distribution script reads.
//
// --rehearsal writes a small throwaway set to wallets/rehearsal instead, so a
// distribution run can be rehearsed on testnet without 10,004 transfers. Its
// total deliberately does not account for the whole supply.
//
// Private keys are written only to files, never to stdout/terminal history.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rehearsal = process.argv.includes('--rehearsal');
const outDir = resolve(root, flag('out', rehearsal ? 'wallets/rehearsal' : 'wallets'));
const force = process.argv.includes('--force');

const token = JSON.parse(readFileSync(join(root, 'token.json'), 'utf8'));
const { adminAmount, holderAmount } = token.allocation;
// A rehearsal set keeps the real per-wallet amounts and group sizes small.
const adminCount = rehearsal ? 2 : token.allocation.adminCount;
const holderCount = rehearsal ? 8 : token.allocation.holderCount;

const supply = BigInt(token.totalSupply);
const planned =
  BigInt(adminAmount) * BigInt(adminCount) + BigInt(holderAmount) * BigInt(holderCount);
// The real plan has to account for the entire supply, to the last token. A
// rehearsal set only has to leave the rest of the supply in the treasury.
if (!rehearsal && planned !== supply) {
  console.error(`allocation ${planned} does not add up to the ${supply} supply in token.json`);
  process.exit(1);
}
if (rehearsal && planned >= supply) {
  console.error(`rehearsal allocation ${planned} leaves nothing of the ${supply} supply`);
  process.exit(1);
}

const files = {
  admins: join(outDir, 'admins.csv'),
  holders: join(outDir, 'holders.csv'),
  addresses: join(outDir, 'holders.json'),
  summary: join(outDir, 'summary.json'),
};

if (!force) {
  const existing = Object.values(files).filter((file) => existsSync(file));
  if (existing.length > 0) {
    console.error(`refusing to overwrite ${existing.map((f) => f.slice(root.length + 1)).join(', ')}`);
    console.error('pass --force if you really mean to replace these keys');
    process.exit(1);
  }
}

const seen = new Set();
function newWallet() {
  for (;;) {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    if (!seen.has(address)) {
      seen.add(address);
      return { address, privateKey };
    }
  }
}

const started = Date.now();
const admins = Array.from({ length: adminCount }, () => newWallet());
const holders = Array.from({ length: holderCount }, () => newWallet());

function csv(rows) {
  return [
    'index,address,private_key',
    ...rows.map((row, index) => `${index + 1},${row.address},${row.privateKey}`),
  ].join('\n') + '\n';
}

mkdirSync(outDir, { recursive: true });
writeFileSync(files.admins, csv(admins), { mode: 0o600 });
writeFileSync(files.holders, csv(holders), { mode: 0o600 });
writeFileSync(files.addresses, `${JSON.stringify(holders.map((w) => w.address), null, 2)}\n`);
writeFileSync(
  files.summary,
  `${JSON.stringify(
    {
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      chainId: token.chainId,
      totalSupply: token.totalSupply,
      rehearsal,
      generatedAt: new Date().toISOString(),
      wallets: { admins: adminCount, holders: holderCount, unique: seen.size },
      allocation: {
        perAdmin: adminAmount,
        adminTotal: (BigInt(adminAmount) * BigInt(adminCount)).toString(),
        perHolder: holderAmount,
        holderTotal: (BigInt(holderAmount) * BigInt(holderCount)).toString(),
      },
      files: {
        admins: 'admins.csv',
        holders: 'holders.csv',
        addresses: 'holders.json',
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

// Read the key files back once and verify what is on disk, not what we meant.
function readCsv(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','));
}

const readAdmins = readCsv(files.admins);
const readHolders = readCsv(files.holders);
const onDisk = new Set([...readAdmins, ...readHolders].map((row) => row[1]));
const keysOk = [...readAdmins, ...readHolders].every(
  (row) => privateKeyToAccount(row[2]).address === row[1],
);
if (
  readAdmins.length !== adminCount ||
  readHolders.length !== holderCount ||
  onDisk.size !== adminCount + holderCount ||
  !keysOk
) {
  console.error('verification failed: wallet files do not match the plan');
  process.exit(1);
}

console.log(`loveriver (${token.symbol}) — ${adminCount + holderCount} wallets in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`admins    ${adminCount} x ${adminAmount} = ${BigInt(adminAmount) * BigInt(adminCount)}`);
console.log(`holders   ${holderCount} x ${holderAmount} = ${BigInt(holderAmount) * BigInt(holderCount)}`);
console.log(
  `total     ${planned} / supply ${supply} tokens${rehearsal ? ' (rehearsal set, the rest stays in the treasury)' : ''}`,
);
console.log(`files (mode 0600, git-ignored): ${Object.values(files).map((f) => f.slice(root.length + 1)).join(', ')}`);
console.log(`sample admin  ${admins[0].address}`);
console.log(`sample holder ${holders[0].address}`);
