// Recipient sets, shared by distribute.mjs and audit.mjs so both count the same
// 10,004 wallets. Keystores win when present; the plaintext CSVs are the
// fallback for a key set that has not been encrypted yet. If both exist they
// have to list the same wallets, or one run could pay against the other's record.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, parseUnits } from 'viem';

export const checksum = (value) => getAddress(`0x${String(value).replace(/^0x/, '')}`);

export function readGroup(walletDir, group, shown = (path) => path) {
  const csvPath = join(walletDir, `${group}.csv`);
  const keystoreDir = join(walletDir, 'keystores', group);
  const names = existsSync(keystoreDir)
    ? readdirSync(keystoreDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  const fromCsv = existsSync(csvPath)
    ? readFileSync(csvPath, 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => checksum(line.split(',')[1]))
    : undefined;

  if (names.length > 0) {
    const fromKeystores = names.map((name) => {
      const file = join(keystoreDir, name);
      const keystore = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof keystore.address !== 'string') {
        console.error(`${file} has no address; is it a keystore?`);
        process.exit(1);
      }
      return checksum(keystore.address);
    });
    if (fromCsv) {
      const known = new Set(fromCsv);
      if (fromKeystores.length !== fromCsv.length || fromKeystores.some((address) => !known.has(address))) {
        console.error(
          `${group}: ${names.length} keystores and ${shown(csvPath)} disagree; refusing to use either`,
        );
        process.exit(1);
      }
    }
    return { addresses: fromKeystores, source: 'keystores' };
  }

  if (!fromCsv) {
    console.error(`no ${group}.csv or keystores/${group}; run: npm run wallets`);
    process.exit(1);
  }
  return { addresses: fromCsv, source: 'csv' };
}

/** Every recipient with its allocation, refusing a list that repeats an address. */
export function readRecipients(walletDir, token, shown) {
  const { adminAmount, holderAmount } = token.allocation;
  const unit = (amount) => parseUnits(String(amount), token.decimals);
  const admins = readGroup(walletDir, 'admins', shown);
  const holders = readGroup(walletDir, 'holders', shown);
  const recipients = [
    ...admins.addresses.map((address) => ({ address, amount: unit(adminAmount), group: 'admin' })),
    ...holders.addresses.map((address) => ({ address, amount: unit(holderAmount), group: 'holder' })),
  ];
  if (new Set(recipients.map((recipient) => recipient.address)).size !== recipients.length) {
    console.error('the recipient list repeats an address; refusing to continue');
    process.exit(1);
  }
  return { admins, holders, recipients };
}

export function totalOf(recipients) {
  return recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
}
