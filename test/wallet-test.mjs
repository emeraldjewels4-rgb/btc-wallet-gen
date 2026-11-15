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

function runWallet(args, input = '', env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['wallet.mjs', ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
    child.stdin.end(input);
  });
}

// Runs the CLI with stdout pretending to be a terminal. A real pty is not
// available from here, so the child redefines isTTY before importing the tool
// and supplies argv itself; everything after that is the real code path.
const WALLET_URL = new URL('../wallet.mjs', import.meta.url).href;
function runWalletOnTerminal(args, input = '') {
  const script = [
    "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });",
    `process.argv = ['node', 'wallet.mjs', ...${JSON.stringify(args)}];`,
    `await import(${JSON.stringify(WALLET_URL)});`,
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
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

console.log('\n== phrase-only backup ==');
const gen = await runWallet(['--phrase-only']);
check('--phrase-only exits 0', gen.code === 0, `exit ${gen.code}: ${gen.stderr}`);
check(
  'stdout is exactly one line of 24 words',
  /^([a-z]+ ){23}[a-z]+\n$/.test(gen.stdout),
  JSON.stringify(gen.stdout),
);
// The whole point: the redirected file is a backup --restore accepts.
const roundTrip = await runWallet(['--restore'], gen.stdout);
check('the printed phrase restores from the same bytes', roundTrip.code === 0, `exit ${roundTrip.code}: ${roundTrip.out}`);
check('restore recognises all 24 words', /Restored from a 24-word BIP-39 seed phrase/.test(roundTrip.out), roundTrip.out);
check('restore prints the expected address #0', /#0\s+m\/84'\/0'\/0'\/0\/0\s+bc1q[0-9a-z]{38}/.test(roundTrip.out), roundTrip.out);

console.log('\n== phrase-only refusals ==');
run = await runWallet(['--phrase-only', '--restore'], VECTOR);
check('--phrase-only with --restore exits 1', run.code === 1, `exit ${run.code}`);
check('the refusal explains the conflict', /cannot be combined/.test(run.out), run.out.trim());

run = await runWallet(['--phrase-only', '--show-key']);
check('--phrase-only with --show-key exits 1', run.code === 1, `exit ${run.code}`);
check('the refusal prints no phrase', run.stdout === '', JSON.stringify(run.stdout));

run = await runWallet(['--phrase-only', '--xpub', accountXpub]);
check('--phrase-only with --xpub exits 1', run.code === 1, `exit ${run.code}`);

console.log('\n== secrets refuse a terminal ==');
run = await runWalletOnTerminal(['--phrase-only']);
check('--phrase-only on a terminal exits 1', run.code === 1, `exit ${run.code}`);
check('it names the redirect', /redirect it/.test(run.out), run.out.trim());
check('and no phrase reaches stdout', run.stdout.trim() === '', JSON.stringify(run.stdout));

run = await runWalletOnTerminal(['--restore', '--show-key'], VECTOR);
check('--show-key on a terminal exits 1', run.code === 1, `exit ${run.code}`);
check('it offers the override', /--allow-tty/.test(run.out), run.out.trim());
check('nothing at all was printed first', run.stdout.trim() === '', JSON.stringify(run.stdout));

run = await runWalletOnTerminal(['--restore', '--show-key', '--allow-tty'], VECTOR);
check('--allow-tty presses past the refusal', run.code === 0, `exit ${run.code}: ${run.out}`);
check('the private key is then printed', /Private key \(WIF\) for #0/.test(run.stdout), run.stdout);

run = await runWallet(['--restore', '--show-key'], VECTOR);
check('--show-key into a pipe needs no override', run.code === 0, `exit ${run.code}`);
check('and prints the key', /Private key \(WIF\) for #0/.test(run.stdout), run.stdout);

console.log('\n== --expect verification ==');
// Address #2 of the vector, taken from the tool's own listing so the test does
// not need a second derivation path.
const listing = await runWallet(['--xpub', receiveXpub, '--count', '3']);
const vectorAddress2 = (listing.out.match(/#2\s+\S+\s+(\S+)/) ?? [])[1];

run = await runWallet(['--restore', '--expect', accountXpub], VECTOR);
check('a matching account xpub exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and names what matched', /Verified: the restored account xpub matches --expect/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', receiveXpub], VECTOR);
check('a matching receive-chain xpub exits 0', run.code === 0, `exit ${run.code}`);
check('and distinguishes the depth', /Verified: the restored receive-chain xpub/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', EXPECTED_0], VECTOR);
check('a matching address #0 exits 0', run.code === 0, `exit ${run.code}`);
check('and names the index', /Verified: the restored address #0 matches --expect/.test(run.out), run.out);

run = await runWallet(['--restore', '--count', '3', '--expect', vectorAddress2], VECTOR);
check('an address inside --count matches', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and is reported by index', /the restored address #2/.test(run.out), run.out);

console.log('\n== --expect catches the wrong wallet ==');
run = await runWallet(['--restore', '--expect', vectorAddress2], VECTOR);
check('an address outside --count exits 3', run.code === 3, `exit ${run.code}`);
check('the mismatch shows both sides', /expected\s+bc1q/.test(run.out) && /restored #0/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', accountXpub], VECTOR, { BIP39_PASSPHRASE: 'wrong' });
check('right phrase, wrong passphrase exits 3', run.code === 3, `exit ${run.code}`);
check('it says not to fund the wallet', /do not fund this wallet/.test(run.out), run.out.trim());

const otherPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
run = await runWallet(['--restore', '--expect', accountXpub], otherPhrase);
check('a different valid phrase exits 3', run.code === 3, `exit ${run.code}`);
check('the expected and derived xpubs are both shown', /expected\s+xpub/.test(run.out) && /restored\s+xpub/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', tpubAccount], VECTOR);
check('a testnet tpub never matches a mainnet restore', run.code === 3, `exit ${run.code}`);

console.log('\n== --expect misuse ==');
run = await runWallet(['--expect', accountXpub], VECTOR);
check('--expect without --restore exits 1', run.code === 1, `exit ${run.code}`);
check('and says --restore is needed', /needs --restore/.test(run.out), run.out.trim());

run = await runWallet(['--restore', '--expect', 'hello'], VECTOR);
check('a value that is neither xpub nor bech32 exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--restore', '--expect'], VECTOR);
check('--expect without a value exits 1', run.code === 1, `exit ${run.code}`);

if (failures > 0) {
  console.error(`\nWALLET TESTS FAILED: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nWALLET TESTS PASSED');
}
