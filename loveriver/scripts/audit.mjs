#!/usr/bin/env node
// Confirms a distribution on-chain instead of trusting the run's own log: reads
// balanceOf for every recipient, compares it with the allocation, and reports
// unpaid, short, overpaid and unreadable wallets plus what is left in the
// treasury. Read-only, so there is no --live switch and no key is loaded.
//
// Balances are read through multicall3 when the chain has it, and one call at a
// time when it does not (a private node, a dev chain) or when a multicall
// fails - so a missing deployment is a slow audit rather than 10,004 wallets
// reported unreadable. The run says which of the two it used.
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

// A token address can be well-formed and still not be a contract - a typo, the
// wrong chain, a deployment that never landed. Say so once, before reading (or
// printing a verdict on) 10,004 balances that cannot exist.
const tokenCode = await retry('token code', () => publicClient.getCode({ address: tokenAddress }));
if (!tokenCode || tokenCode === '0x') {
  console.error(`${tokenAddress} is not a contract on ${chain.name} (${chain.id}); check --token and --chain.`);
  process.exit(1);
}

const source =
  admins.source === holders.source ? admins.source : `${admins.source} admins, ${holders.source} holders`;
console.log(`token      ${token.name} (${token.symbol}) at ${tokenAddress}`);
console.log(`chain      ${chain.name} (${chain.id})`);
console.log(`wallets    ${shown(walletDir)} (${source})`);
console.log(`recipients ${recipients.length} (${admins.addresses.length} admin, ${holders.addresses.length} holder)`);
console.log(`expected   ${planned} base units`);
if (planned !== expectedSupply) {
  console.log(`note       this wallet set accounts for ${planned} of the ${expectedSupply} supply`);
}

// multicall3 is what makes a 10,004-wallet audit 21 calls instead of 10,004.
// Its absence is expected off the public chains, so look for the code first and
// say plainly which way the balances will be read.
const multicallAddress = chain.contracts?.multicall3?.address;
let useMulticall = Boolean(multicallAddress);
if (useMulticall) {
  const code = await retry('multicall3 code', () => publicClient.getCode({ address: multicallAddress }));
  useMulticall = Boolean(code && code !== '0x');
}
const mode = useMulticall
  ? `multicall3 at ${multicallAddress}, ${batchSize} wallets per call`
  : `individual balanceOf calls${multicallAddress ? ` (no multicall3 at ${multicallAddress})` : ' (this chain has no multicall3)'}`;
console.log(`mode       ${mode}${useMulticall || recipients.length <= batchSize ? '' : ' - slower, so be patient'}`);

const readBalance = (recipient) =>
  retry(`balanceOf ${recipient.address}`, () =>
    publicClient.readContract({
      address: tokenAddress,
      abi: artifact.abi,
      functionName: 'balanceOf',
      args: [recipient.address],
    }),
  );

const balances = new Map();
const failures = new Map();
let calls = 0;
let approved = useMulticall;

for (let start = 0; start < recipients.length; start += batchSize) {
  const slice = recipients.slice(start, start + batchSize);
  const checked = start + slice.length;
  let results;

  if (approved) {
    try {
      calls += 1;
      results = await retry(`multicall ${start + 1}-${checked}`, () =>
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
    } catch (error) {
      console.log(`multicall  ${start + 1}-${checked} failed: ${error.shortMessage ?? error.message}`);
      console.log('mode       falling back to individual balanceOf calls for the rest of this run');
      approved = false;
    }
  }

  if (results) {
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'success') balances.set(slice[index].address, result.result);
      else failed.push(slice[index]);
    });
    if (failed.length > 0) {
      console.log(`note       ${failed.length} call(s) in ${start + 1}-${checked} failed; reading them one by one`);
      // A multicall3 that exists but answers nothing useful would fail every
      // batch, so stop paying for it after the first one.
      if (failed.length === results.length) {
        console.log('mode       multicall3 returned no usable result; using individual balanceOf calls for the rest of this run');
        approved = false;
      }
      for (const recipient of failed) {
        calls += 1;
        try {
          balances.set(recipient.address, await readBalance(recipient));
        } catch (error) {
          failures.set(recipient.address, error.shortMessage ?? error.message);
        }
      }
    }
  } else {
    for (const recipient of slice) {
      calls += 1;
      try {
        balances.set(recipient.address, await readBalance(recipient));
      } catch (error) {
        failures.set(recipient.address, error.shortMessage ?? error.message);
      }
    }
  }

  if (recipients.length > batchSize) {
    console.log(`checked    ${checked}/${recipients.length}${approved ? '' : ' (individual)'}`);
  }
}

const unpaid = [];
const short = [];
const overpaid = [];
const unreadable = [];
let paid = 0;
for (const recipient of recipients) {
  const actual = balances.get(recipient.address);
  if (actual === undefined) unreadable.push({ recipient, reason: failures.get(recipient.address) });
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
for (const { recipient, reason } of unreadable.slice(0, 10)) {
  console.log(`  unreadable ${recipient.group.padEnd(6)} ${recipient.address} ${reason ?? 'no balance returned'}`);
}
if (unreadable.length > 10) console.log(`  unreadable ${unreadable.length - 10} more not shown`);
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

let supply;
try {
  supply = await retry('supply', () =>
    publicClient.readContract({ address: tokenAddress, abi: artifact.abi, functionName: 'totalSupply' }),
  );
} catch (error) {
  console.error(`cannot read totalSupply from ${tokenAddress}: ${error.shortMessage ?? error.message}`);
  console.error('is that a loveriver contract on this chain? check --token and --chain.');
  process.exit(1);
}

const expectedTreasury = supply - planned;
let treasuryBalance;
if (treasury) {
  try {
    treasuryBalance = await retry('treasury balance', () =>
      publicClient.readContract({
        address: tokenAddress,
        abi: artifact.abi,
        functionName: 'balanceOf',
        args: [treasury],
      }),
    );
  } catch (error) {
    console.error(`cannot read the treasury balance of ${treasury}: ${error.shortMessage ?? error.message}`);
    console.error('check --treasury (and that it holds a valid address), then rerun.');
    process.exit(1);
  }
}

console.log('');
console.log(`read       ${recipients.length} balances in ${calls} RPC call(s)`);
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
