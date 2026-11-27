#!/usr/bin/env node
// Confirms a distribution on-chain instead of trusting the run's own log: reads
// balanceOf for every recipient, compares it with the allocation, and reports
// unpaid, short, overpaid and unreadable wallets plus what is left in the
// treasury. Read-only, so there is no --live switch and no key is loaded.
import { createPublicClient, formatUnits, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, loadEnv } from './env.mjs';
import { readRecipients, totalOf } from './recipients.mjs';
import { retry } from './rpc.mjs';

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

const token = JSON.parse(readFileSync(join(root, 'token.json'), 'utf8'));
const artifact = JSON.parse(readFileSync(join(root, 'build', 'LoverRiver.json'), 'utf8'));
const walletDir = resolve(root, flag('wallets', 'wallets'));

const deploymentFile = join(root, 'deployments', `${chain.id}.json`);
const deployment = existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, 'utf8')) : undefined;
const tokenAddress = flag('token') ?? deployment?.address;
if (!tokenAddress) {
  console.error('no deployment record; deploy first or pass --token 0x...');
  process.exit(1);
}
if (!isAddress(tokenAddress)) {
  console.error(`--token ${tokenAddress} is not a valid address`);
  process.exit(1);
}
const treasury = flag('treasury') ?? deployment?.treasury;
if (treasury && !isAddress(treasury)) {
  console.error(`--treasury ${treasury} is not a valid address`);
  process.exit(1);
}

const batchSize = Number(flag('batch', '500'));
if (!Number.isInteger(batchSize) || batchSize < 1) {
  console.error('--batch must be a positive integer');
  process.exit(1);
}

const { admins, holders, recipients } = readRecipients(walletDir, token, shown);
const planned = totalOf(recipients);
const expectedSupply = BigInt(token.totalSupply) * 10n ** BigInt(token.decimals);

const publicClient = createPublicClient({ chain, transport: http(process.env.BSC_RPC_URL || undefined) });
const chainId = await retry('chain id', () => publicClient.getChainId());
if (chainId !== chain.id) {
  console.error(`RPC reports chain ${chainId}, expected ${chain.id}`);
  process.exit(1);
}

const source =
  admins.source === holders.source ? admins.source : `${admins.source} admins, ${holders.source} holders`;
console.log(`token      ${token.name} (${token.symbol}) at ${tokenAddress}`);
console.log(`chain      ${chain.name} (${chain.id})`);
console.log(`wallets    ${shown(walletDir)} (${source})`);
console.log(`recipients ${recipients.length} (${admins.addresses.length} admin, ${holders.addresses.length} holder)`);
console.log(`expected   ${planned} base units`);
console.log(`batch      ${batchSize} wallets per multicall`);
if (planned !== expectedSupply) {
  console.log(`note       this wallet set accounts for ${planned} of the ${expectedSupply} supply`);
}

const balances = new Map();
for (let start = 0; start < recipients.length; start += batchSize) {
  const slice = recipients.slice(start, start + batchSize);
  const results = await retry(`multicall ${start + 1}-${start + slice.length}`, () =>
    publicClient.multicall({
      contracts: slice.map((recipient) => ({
        address: tokenAddress,
        abi: artifact.abi,
        functionName: 'balanceOf',
        args: [recipient.address],
      })),
      allowFailure: true,
    }),
  );
  results.forEach((result, index) => {
    balances.set(slice[index].address, result.status === 'success' ? result.result : undefined);
  });
  if (recipients.length > batchSize) console.log(`checked    ${start + slice.length}/${recipients.length}`);
}

const unpaid = [];
const short = [];
const overpaid = [];
const unreadable = [];
let paid = 0;
for (const recipient of recipients) {
  const actual = balances.get(recipient.address);
  if (actual === undefined) unreadable.push({ recipient });
  else if (actual === recipient.amount) paid += 1;
  else if (actual === 0n) unpaid.push({ recipient, actual });
  else if (actual < recipient.amount) short.push({ recipient, actual });
  else overpaid.push({ recipient, actual });
}

const problems = unpaid.length + short.length + overpaid.length + unreadable.length;
console.log('');
console.log(`paid       ${paid}/${recipients.length}`);
console.log(`unpaid     ${unpaid.length}`);
console.log(`short      ${short.length}`);
console.log(`overpaid   ${overpaid.length}`);
console.log(`unreadable ${unreadable.length}`);
for (const [label, entries] of [
  ['unpaid', unpaid],
  ['short', short],
  ['overpaid', overpaid],
]) {
  for (const { recipient, actual } of entries.slice(0, 10)) {
    console.log(
      `  ${label.padEnd(8)} ${recipient.group.padEnd(6)} ${recipient.address} expected ${recipient.amount} has ${actual ?? 0}`,
    );
  }
  if (entries.length > 10) console.log(`  ${label} ${entries.length - 10} more not shown`);
}

const supply = await retry('supply', () =>
  publicClient.readContract({ address: tokenAddress, abi: artifact.abi, functionName: 'totalSupply' }),
);
const expectedTreasury = supply - planned;
let treasuryBalance;
if (treasury) {
  treasuryBalance = await retry('treasury balance', () =>
    publicClient.readContract({
      address: tokenAddress,
      abi: artifact.abi,
      functionName: 'balanceOf',
      args: [treasury],
    }),
  );
}

console.log('');
console.log(`supply     ${supply} base units${supply === expectedSupply ? '' : ` (token.json says ${expectedSupply})`}`);
if (treasury) {
  const readable = `${formatUnits(treasuryBalance, token.decimals)} ${token.symbol}`;
  console.log(
    `treasury   ${treasury} ${treasuryBalance} base units (${readable})${
      treasuryBalance === expectedTreasury ? '' : ` (expected ${expectedTreasury})`
    }`,
  );
} else {
  console.log('treasury   unknown; pass --treasury 0x... to include the remainder');
}

const treasuryWrong = treasury ? treasuryBalance !== expectedTreasury : false;
if (problems === 0 && supply === expectedSupply && !treasuryWrong) {
  console.log(
    `\nconfirmed: all ${recipients.length} recipients hold exactly their allocation${
      treasury ? ', and the treasury holds only the undistributed remainder' : ''
    }.`,
  );
  process.exit(0);
}

const reasons = [];
if (problems > 0) reasons.push(`${problems} wallet(s) do not match their allocation`);
if (supply !== expectedSupply) reasons.push(`supply reads ${supply}, token.json expects ${expectedSupply}`);
if (treasuryWrong) {
  reasons.push(`treasury holds ${treasuryBalance} base units, expected ${expectedTreasury}`);
}
console.error(`\naudit failed: ${reasons.join('; ')}`);
process.exit(1);
