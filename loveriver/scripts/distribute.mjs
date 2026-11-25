#!/usr/bin/env node
// Sends each wallet its allocation from the treasury. Dry run unless --live.
// Recipients are read from the encrypted keystores when they exist, otherwise
// from the plaintext CSVs. Progress is written to wallets/distribute-state.json
// so an interrupted run resumes where it stopped instead of sending twice.
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddress, parseUnits } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, loadEnv } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(root);

const chains = { bsc, 'bsc-testnet': bscTestnet };
const chainName = flag('chain', 'bsc');
const chain = chains[chainName];
if (!chain) {
  console.error('--chain must be bsc or bsc-testnet');
  process.exit(1);
}

const live = process.argv.includes('--live');
const limitFlag = flag('limit');
const limit = limitFlag === undefined ? Infinity : Number(limitFlag);
if (limitFlag !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error('--limit must be a positive integer');
  process.exit(1);
}

const token = JSON.parse(readFileSync(join(root, 'token.json'), 'utf8'));
const artifact = JSON.parse(readFileSync(join(root, 'build', 'LoverRiver.json'), 'utf8'));
const walletDir = resolve(root, flag('wallets', 'wallets'));
const statePath = join(walletDir, 'distribute-state.json');
const checksum = (value) => getAddress(`0x${String(value).replace(/^0x/, '')}`);

// Keystores win when present; the CSVs fallback keeps a fresh key set working.
// If both are there they have to list the same wallets, or a resume could pay
// one set against the other's state.
function readGroup(group) {
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
          `${group}: ${names.length} keystores and ${csvPath.slice(root.length + 1)} disagree; refusing to use either`,
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

const tokenFlag = flag('token');
const deploymentFile = join(root, 'deployments', `${chain.id}.json`);
const tokenAddress =
  tokenFlag ??
  (existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, 'utf8')).address : undefined);
if (tokenAddress && !isAddress(tokenAddress)) {
  console.error(`--token ${tokenAddress} is not a valid address`);
  process.exit(1);
}

const { adminAmount, holderAmount } = token.allocation;
const unit = (amount) => parseUnits(String(amount), token.decimals);
const admins = readGroup('admins');
const holders = readGroup('holders');
const recipients = [
  ...admins.addresses.map((address) => ({ address, amount: unit(adminAmount), group: 'admin' })),
  ...holders.addresses.map((address) => ({ address, amount: unit(holderAmount), group: 'holder' })),
];
if (new Set(recipients.map((recipient) => recipient.address)).size !== recipients.length) {
  console.error('the recipient list repeats an address; refusing to continue');
  process.exit(1);
}

const supply = BigInt(token.totalSupply) * 10n ** BigInt(token.decimals);
const planned = recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
if (planned !== supply) {
  console.error(`allocation ${planned} does not add up to the ${supply} supply`);
  process.exit(1);
}

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { sent: {} };
const pending = recipients.filter((recipient) => !state.sent[recipient.address]);
const batch = pending.slice(0, limit);

console.log(`token     ${token.name} (${token.symbol}) at ${tokenAddress ?? '(not deployed yet)'}`);
console.log(`chain     ${chain.name} (${chain.id})`);
console.log(`wallets   ${walletDir.slice(root.length + 1)} (${admins.source === holders.source ? admins.source : `${admins.source} admins, ${holders.source} holders`})`);
console.log(`recipients ${recipients.length} (${recipients.length - pending.length} already sent, ${pending.length} pending)`);
console.log(`total     ${planned} base units (${token.totalSupply} tokens)`);

if (!live) {
  const toSend = batch;
  console.log(`\ndry run: nothing signed or sent. next ${toSend.length} transfers:`);
  for (const recipient of toSend.slice(0, 5)) {
    console.log(`  ${recipient.group.padEnd(6)} ${recipient.address} ${recipient.amount}`);
  }
  if (toSend.length > 5) console.log(`  ... ${toSend.length - 5} more`);
  console.log('add --live to send.');
  process.exit(0);
}

if (!tokenAddress) {
  console.error('no deployment record; deploy first or pass --token 0x...');
  process.exit(1);
}

const privateKey = process.env.TREASURY_PRIVATE_KEY;
if (!privateKey) {
  console.error('set TREASURY_PRIVATE_KEY in loveriver/.env');
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);
const transport = http(process.env.BSC_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const chainId = await publicClient.getChainId();
if (chainId !== chain.id) {
  console.error(`RPC reports chain ${chainId}, expected ${chain.id}; refusing to sign`);
  process.exit(1);
}

const balance = await publicClient.readContract({
  address: tokenAddress,
  abi: artifact.abi,
  functionName: 'balanceOf',
  args: [account.address],
});
const outstanding = batch.reduce((sum, recipient) => sum + recipient.amount, 0n);
if (balance < outstanding) {
  console.error(`treasury holds ${balance}, needs ${outstanding} for this run`);
  process.exit(1);
}
console.log(`treasury  ${account.address} (${balance} base units, ${formatEther(await publicClient.getBalance({ address: account.address }))} BNB for gas)\n`);

mkdirSync(walletDir, { recursive: true });
let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
let sent = 0;

for (const recipient of batch) {
  try {
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: artifact.abi,
      functionName: 'transfer',
      args: [recipient.address, recipient.amount],
      account,
      chain,
      nonce,
    });
    nonce += 1;
    await publicClient.waitForTransactionReceipt({ hash });
    state.sent[recipient.address] = hash;
    // Recorded after every transfer: a crash mid-chunk must not pay twice.
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    sent += 1;
    if (sent % 25 === 0 || sent === batch.length) {
      console.log(`${sent} sent, last ${hash}`);
    }
  } catch (error) {
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.error(`stopped after ${sent} transfers: ${error.shortMessage ?? error.message}`);
    console.error(`progress saved in wallets/distribute-state.json; rerun --live to resume`);
    process.exit(1);
  }
}

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(`\ndone: ${sent} transfers this run, ${Object.keys(state.sent).length}/${recipients.length} recipients paid`);
