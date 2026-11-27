#!/usr/bin/env node
// Deploys loveriver to BNB Smart Chain. Dry run unless --live, matching the
// repo's rule that nothing is signed or broadcast without an explicit flag.
import { createPublicClient, createWalletClient, formatEther, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, loadEnv } from './env.mjs';
import { loadPrivateKey } from './treasury.mjs';

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
const token = JSON.parse(readFileSync(join(root, 'token.json'), 'utf8'));
const artifact = JSON.parse(readFileSync(join(root, 'build', 'LoverRiver.json'), 'utf8'));

let privateKey;
try {
  privateKey = await loadPrivateKey(root, process.env.DEPLOYER_PRIVATE_KEY ?? process.env.TREASURY_PRIVATE_KEY);
} catch (error) {
  console.error(`treasury key: ${error.message}`);
  process.exit(1);
}
if (!privateKey && live) {
  console.error(
    'set TREASURY_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in loveriver/.env, or run: npm run keystore -- encrypt-treasury',
  );
  process.exit(1);
}

const account = privateKey ? privateKeyToAccount(privateKey) : undefined;
const treasury = flag('treasury') ?? account?.address;
if (treasury && !isAddress(treasury)) {
  console.error(`--treasury ${treasury} is not a valid address`);
  process.exit(1);
}
if (!treasury && live) {
  console.error('no treasury address: set TREASURY_PRIVATE_KEY or pass --treasury 0x...');
  process.exit(1);
}

const transport = http(process.env.BSC_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const supply = BigInt(token.totalSupply) * 10n ** BigInt(token.decimals);

console.log(`token     ${token.name} (${token.symbol}), ${token.decimals} decimals`);
console.log(`supply    ${token.totalSupply} tokens (${supply} base units, fixed in the contract)`);
console.log(`chain     ${chain.name} (${chain.id})`);
console.log(`deployer  ${account ? account.address : '(set TREASURY_PRIVATE_KEY to deploy)'}`);
console.log(`treasury  ${treasury ?? '(the deployer)'} (receives the whole supply)`);

if (!live) {
  console.log('\ndry run: nothing signed or sent. add --live to deploy.');
  process.exit(0);
}

if (!account) {
  console.error(
    'set TREASURY_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in loveriver/.env, or run: npm run keystore -- encrypt-treasury',
  );
  process.exit(1);
}

const chainId = await publicClient.getChainId();
if (chainId !== chain.id) {
  console.error(`RPC reports chain ${chainId}, expected ${chain.id}; refusing to sign`);
  process.exit(1);
}

const balance = await publicClient.getBalance({ address: account.address });
console.log(`balance   ${formatEther(balance)} BNB`);
if (balance === 0n) {

  console.error('deployer has no BNB to pay for gas');
  process.exit(1);
}

const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [treasury],
  account,
  chain,
});
console.log(`sent      ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  console.error(`deployment failed (status ${receipt.status})`);
  process.exit(1);
}

const address = receipt.contractAddress;
const read = (functionName, args = []) =>
  publicClient.readContract({ address, abi: artifact.abi, functionName, args });

const [name, symbol, decimals, onChainSupply, treasuryBalance] = await Promise.all([
  read('name'),
  read('symbol'),
  read('decimals'),
  read('totalSupply'),
  read('balanceOf', [treasury]),
]);

const ok =
  name === token.name &&
  symbol === token.symbol &&
  Number(decimals) === token.decimals &&
  onChainSupply === supply &&
  treasuryBalance === supply;
if (!ok) {
  console.error('deployed contract does not read back as expected', {
    name,
    symbol,
    decimals,
    onChainSupply,
    treasuryBalance,
  });
  process.exit(1);
}

const record = {
  name,
  symbol,
  decimals: Number(decimals),
  totalSupply: onChainSupply.toString(),
  address,
  chainId: chain.id,
  treasury,
  deployer: account.address,
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  deployedAt: new Date().toISOString(),
};
const outDir = join(root, 'deployments');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${chain.id}.json`), `${JSON.stringify(record, null, 2)}\n`);

console.log(`\ndeployed  ${address}`);
console.log(`verified  name=${name} symbol=${symbol} decimals=${decimals} supply=${onChainSupply}`);
console.log(`treasury holds ${treasuryBalance} base units`);
console.log(`record    deployments/${chain.id}.json`);
if (chain.blockExplorers) {
  console.log(`explorer  ${chain.blockExplorers.default.url}/token/${address}`);
}
