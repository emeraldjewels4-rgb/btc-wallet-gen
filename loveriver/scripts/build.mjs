#!/usr/bin/env node
import solc from 'solc';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solcInput } from './solc-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'contracts', 'LoverRiver.sol'), 'utf8');

const output = JSON.parse(solc.compile(JSON.stringify(solcInput(source))));
const errors = (output.errors ?? []).filter((error) => error.severity === 'error');
for (const warning of (output.errors ?? []).filter((error) => error.severity !== 'error')) {
  console.warn(warning.formattedMessage.trim());
}
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage.trim());
  process.exit(1);
}

const contract = output.contracts['contracts/LoverRiver.sol'].LoverRiver;
const artifact = {
  contractName: 'LoverRiver',
  compiler: solc.version(),
  source: 'contracts/LoverRiver.sol',
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
};

const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'LoverRiver.json');
writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);

const sizeKb = (contract.evm.deployedBytecode.object.length / 2 / 1024).toFixed(1);
console.log(`compiled LoverRiver with solc ${solc.version()}`);
console.log(`runtime bytecode ${sizeKb} KiB (limit 24.6) -> build/LoverRiver.json`);
