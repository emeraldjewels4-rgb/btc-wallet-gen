#!/usr/bin/env node
// Sends each wallet its allocation from the treasury. Dry run unless --live.
// Recipients are read from the encrypted keystores when they exist, otherwise
// from the plaintext CSVs. Progress is written to one state file per chain and
// token so an interrupted run resumes where it stopped instead of sending twice,
// and a rehearsal on testnet cannot leave mainnet reading as already paid.
//
// --rehearsal allows a wallet set that does not account for the whole supply
// (npm run wallets -- --rehearsal), so the whole path can be run end to end on
// testnet in seconds. It is refused on mainnet: a partial set there would
// strand the undistributed supply in the treasury.
import { createPublicClient, createWalletClient, formatEther, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, loadEnv } from './env.mjs';
import { readRecipients, totalOf } from './recipients.mjs';
import { retry } from './rpc.mjs';
import { loadPrivateKey } from './treasury.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shown = (path) => relative(root, path);
loadEnv(root);

const chains = { bsc, 'bsc-testnet': bscTestnet };
const chainName = flag('chain', 'bsc');
const chain = chains[chainName];
if (!chain) {
  console.error('--chain must be bsc or bsc-testnet');
  process.exit(1);
}

const rehearsal = process.argv.includes('--rehearsal');
if (rehearsal && chain.id === 56) {
  console.error(
    '--rehearsal is testnet-only: a wallet set that does not cover the supply has no place on mainnet',
  );
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
const RECEIPT_TIMEOUT = 120_000;

const tokenFlag = flag('token');
const deploymentFile = join(root, 'deployments', `${chain.id}.json`);
const tokenAddress =
  tokenFlag ??
  (existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, 'utf8')).address : undefined);
if (tokenAddress && !isAddress(tokenAddress)) {
  console.error(`--token ${tokenAddress} is not a valid address`);
  process.exit(1);
}

// One state file per chain and token. The scope is written into the file too,
// so a copied or renamed state file is refused instead of trusted.
const scope = { chainId: chain.id, token: tokenAddress ? tokenAddress.toLowerCase() : 'no-token' };
const statePath = join(walletDir, `distribute-state.${scope.chainId}-${scope.token}.json`);
const saveState = () =>
  writeFileSync(
    statePath,
    `${JSON.stringify({ chainId: scope.chainId, token: scope.token, sent: state.sent }, null, 2)}\n`,
  );

const { admins, holders, recipients } = readRecipients(walletDir, token, shown);
const supply = BigInt(token.totalSupply) * 10n ** BigInt(token.decimals);
const planned = totalOf(recipients);
const remainder = supply - planned;
if (remainder < 0n) {
  console.error(`allocation ${planned} exceeds the ${supply} supply`);
  process.exit(1);
}
if (remainder > 0n && !rehearsal) {
  console.error(`allocation ${planned} does not add up to the ${supply} supply`);
  console.error('for a small test set on testnet, add --rehearsal (and npm run wallets -- --rehearsal)');
  process.exit(1);
}

function loadState() {
  if (existsSync(join(walletDir, 'distribute-state.json'))) {
    console.warn('note      ignoring wallets/distribute-state.json: progress is now keyed by chain and token');
  }
  if (!existsSync(statePath)) return { chainId: scope.chainId, token: scope.token, sent: {} };
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  if (saved.chainId !== scope.chainId || saved.token !== scope.token) {
    console.error(
      `${shown(statePath)} is state for chain ${saved.chainId} / token ${saved.token}; refusing it`,
    );
    process.exit(1);
  }
  return { ...saved, sent: saved.sent ?? {} };
}
const state = loadState();
const pending = recipients.filter((recipient) => !state.sent[recipient.address]);
const batch = pending.slice(0, limit);

console.log(`token     ${token.name} (${token.symbol}) at ${tokenAddress ?? '(not deployed yet)'}`);
console.log(`chain     ${chain.name} (${chain.id})`);
console.log(`wallets   ${shown(walletDir)} (${admins.source === holders.source ? admins.source : `${admins.source} admins, ${holders.source} holders`})`);
console.log(`recipients ${recipients.length} (${recipients.length - pending.length} already sent, ${pending.length} pending)`);
console.log(`total     ${planned} base units (${token.totalSupply} tokens)`);
if (remainder > 0n) {
  console.log(`mode      rehearsal: this set pays ${planned} of ${supply}, ${remainder} stays in the treasury`);
}

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

let privateKey;
try {
  privateKey = await loadPrivateKey(root, process.env.TREASURY_PRIVATE_KEY);
} catch (error) {
  console.error(`treasury key: ${error.message}`);
  process.exit(1);
}
if (!privateKey) {
  console.error(
    'set TREASURY_PRIVATE_KEY in loveriver/.env, or run: npm run keystore -- encrypt-treasury',
  );
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);
const transport = http(process.env.BSC_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const chainId = await retry('chain id', () => publicClient.getChainId());
if (chainId !== chain.id) {
  console.error(`RPC reports chain ${chainId}, expected ${chain.id}; refusing to sign`);
  process.exit(1);
}

const balance = await retry('treasury token balance', () =>
  publicClient.readContract({
    address: tokenAddress,
    abi: artifact.abi,
    functionName: 'balanceOf',
    args: [account.address],
  }),
);
const outstanding = batch.reduce((sum, recipient) => sum + recipient.amount, 0n);
if (balance < outstanding) {
  console.error(`treasury holds ${balance}, needs ${outstanding} for this run`);
  process.exit(1);
}
const gasBalance = await retry('bnb balance', () => publicClient.getBalance({ address: account.address }));
console.log(`treasury  ${account.address} (${balance} base units, ${formatEther(gasBalance)} BNB for gas)\n`);

mkdirSync(walletDir, { recursive: true });
let nonce = await retry('nonce', () =>
  publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
);
let sent = 0;

for (const recipient of batch) {
  try {
    // Same nonce and same arguments on every attempt, so a retry can replace
    // its own transaction but can never pay the recipient twice.
    const hash = await retry(`send to ${recipient.address}`, () =>
      walletClient.writeContract({
        address: tokenAddress,
        abi: artifact.abi,
        functionName: 'transfer',
        args: [recipient.address, recipient.amount],
        account,
        chain,
        nonce,
      }),
    );
    nonce += 1;
    const receipt = await retry(`confirm ${hash}`, () =>
      publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT }),
    );
    if (receipt.status !== 'success') {
      saveState();
      console.error(`${recipient.address}: transfer ${hash} reverted; not recorded as sent`);
      console.error(`progress saved in ${shown(statePath)}; rerun --live to resume`);
      process.exit(1);
    }
    state.sent[recipient.address] = hash;
    // Recorded after every confirmed transfer: a crash mid-chunk must not pay twice.
    saveState();
    sent += 1;
    if (sent % 25 === 0 || sent === batch.length) {
      console.log(`${sent} sent, last ${hash}`);
    }
  } catch (error) {
    saveState();
    console.error(`stopped at ${recipient.address} after ${sent} transfers: ${error.shortMessage ?? error.message}`);
    console.error(`progress saved in ${shown(statePath)}; rerun --live to resume`);
    process.exit(1);
  }
}

saveState();
console.log(`\ndone: ${sent} transfers this run, ${Object.keys(state.sent).length}/${recipients.length} recipients paid`);
