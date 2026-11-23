#!/usr/bin/env node
// Writes the two files BscScan asks for when verifying a deployed loveriver:
//   build/standard-json-input.json  exact solc input, same settings as build
//   build/constructor-args.txt      ABI-encoded treasury argument, no 0x
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flag, loadEnv } from './env.mjs';
import { COMPILER_VERSION, solcInput } from './solc-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(root);

const chains = { bsc: 56, 'bsc-testnet': 97 };
const chainName = flag('chain', 'bsc');
const chainId = chains[chainName];
if (!chainId) {
  console.error('--chain must be bsc or bsc-testnet');
  process.exit(1);
}

const source = readFileSync(join(root, 'contracts', 'LoverRiver.sol'), 'utf8');
const deploymentFile = join(root, 'deployments', `${chainId}.json`);
const deployment = existsSync(deploymentFile)
  ? JSON.parse(readFileSync(deploymentFile, 'utf8'))
  : undefined;

const privateKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.TREASURY_PRIVATE_KEY;
const treasury =
  flag('treasury') ??
  deployment?.treasury ??
  (privateKey ? privateKeyToAccount(privateKey).address : undefined);
if (treasury && !isAddress(treasury)) {
  console.error(`--treasury ${treasury} is not a valid address`);
  process.exit(1);
}

const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });
const inputFile = join(outDir, 'standard-json-input.json');
writeFileSync(inputFile, `${JSON.stringify(solcInput(source), null, 2)}\n`);

console.log(`compiler    ${COMPILER_VERSION}`);
console.log(`contract    contracts/LoverRiver.sol:LoverRiver`);
console.log(`license     MIT`);
console.log(`deployed    ${deployment?.address ?? '(no deployment record for this chain)'}`);
console.log(`input       build/standard-json-input.json`);

if (!treasury) {
  console.error('\nno treasury address: pass --treasury 0x..., or deploy first so a');
  console.error('deployments/<chainId>.json record exists');
  process.exit(1);
}

const args = encodeAbiParameters([{ type: 'address', name: 'treasury' }], [treasury]).slice(2);
writeFileSync(join(outDir, 'constructor-args.txt'), `${args}\n`);
console.log(`treasury    ${treasury}`);
console.log(`constructor ${args}  -> build/constructor-args.txt`);
