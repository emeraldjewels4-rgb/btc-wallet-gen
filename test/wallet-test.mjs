#!/usr/bin/env node
/**
 * Checks the public-only derivation mode of wallet.mjs.
 *
 * Uses the published BIP-84 test vector (a well-known public mnemonic, not a
 * secret) to prove that the account xpub and the receive-chain xpub produce the
 * same addresses, that the addresses match the specification, and that private
 * or malformed keys are refused.
 *
 * Run: npm run test:wallet
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from 'bip39';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// BIP-84 test vector: mnemonic "abandon ... about", Bitcoin mainnet.
const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EXPECTED_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EXPECTED_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const EXPECTED_TESTNET_0 = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl';
const EXPECTED_TESTNET_1 = 'tb1qd7spv5q28348xl4myc8zmh983w5jx32cjhkn97';

const root = HDKey.fromMasterSeed(mnemonicToSeedSync(VECTOR));
const account = root.derive("m/84'/0'/0'");
const accountXpub = account.publicExtendedKey;
const receiveXpub = account.deriveChild(0).publicExtendedKey;
const accountXprv = account.privateExtendedKey;
const shallowXpub = root.derive("m/84'").publicExtendedKey;

// Testnet uses its own version bytes, so the same seed serialises as a tpub.
const TESTNET_VERSIONS = { public: 0x043587cf, private: 0x04358394 };
const testnetRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(VECTOR), TESTNET_VERSIONS);
const testnetAccount = testnetRoot.derive("m/84'/1'/0'");
const tpubAccount = testnetAccount.publicExtendedKey;
const tpubReceive = testnetAccount.deriveChild(0).publicExtendedKey;
const testnetXprv = testnetAccount.privateExtendedKey;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function runWallet(args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['wallet.mjs', ...args], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

console.log('== account xpub (m/84\'/0\'/0\') ==');
let run = await runWallet(['--xpub', accountXpub, '--count', '3']);
check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
check('address #0 matches the BIP-84 vector', run.out.includes(EXPECTED_0), run.out);
check('address #1 matches the BIP-84 vector', run.out.includes(EXPECTED_1), run.out);
check('prints three receive addresses', ['#0', '#1', '#2'].every((n) => run.out.includes(n)));
check('says it is watch-only', /watch-only/i.test(run.out), run.out);
check('prints no private key', !/xprv|private key:/i.test(run.out), run.out);

console.log("\n== receive-chain xpub (m/84'/0'/0'/0) ==");
run = await runWallet(['--xpub', receiveXpub, '--count', '2']);
check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
check('same address #0 as the account xpub', run.out.includes(EXPECTED_0), run.out);
check('same address #1 as the account xpub', run.out.includes(EXPECTED_1), run.out);

console.log("\n== testnet tpub (m/84'/1'/0') ==");
check('the test key serialises as a tpub', tpubAccount.startsWith('tpub'), tpubAccount.slice(0, 4));
run = await runWallet(['--xpub', tpubAccount, '--count', '2']);
check('exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
check('address #0 matches the BIP-84 testnet vector', run.out.includes(EXPECTED_TESTNET_0), run.out);
check('address #1 matches the BIP-84 testnet vector', run.out.includes(EXPECTED_TESTNET_1), run.out);
check('says Bitcoin testnet', /Bitcoin testnet/.test(run.out), run.out);
check('shows the testnet account path', /m\/84'\/1'\/0'/.test(run.out), run.out);
check('prints no private key', !/tprv|private key:/i.test(run.out), run.out);

run = await runWallet(['--xpub', tpubReceive, '--count', '2']);
check('receive-chain tpub gives the same addresses', run.code === 0 && run.out.includes(EXPECTED_TESTNET_0), run.out);

console.log('\n== refusals ==');
run = await runWallet(['--xpub', accountXprv]);
check('extended private key exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub', testnetXprv]);
check('testnet tprv exits 1', run.code === 1, `exit ${run.code}`);
check('testnet key is not echoed', !run.out.includes(testnetXprv), run.out);
check('error explains an xpub is needed', /xpub/i.test(run.out), run.out.trim());
check('error never echoes the private key', !run.out.includes(accountXprv), run.out);

run = await runWallet(['--xpub', 'xpub-not-a-real-key']);
check('malformed xpub exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub', shallowXpub]);
check('shallow (depth 2) xpub exits 1', run.code === 1, `exit ${run.code}`);
check('error names the supported depths', /depth/i.test(run.out), run.out.trim());

run = await runWallet(['--xpub', accountXpub, '--show-key']);
check('--xpub with --show-key exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub', accountXpub, '--restore']);
check('--xpub with --restore exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub', accountXpub, '--count', '0']);
check('count 0 exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub']);
check('--xpub without a value exits 1', run.code === 1, `exit ${run.code}`);

if (failures > 0) {
  console.error(`\nWALLET TESTS FAILED: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nWALLET TESTS PASSED');
}
