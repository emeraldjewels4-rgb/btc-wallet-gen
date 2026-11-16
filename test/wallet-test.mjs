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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
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

// A successful --expect-file writes a timestamp, which must not land in the
// repository's own state file: every run is pointed at a scratch one instead.
const TEST_STATE = join(tmpdir(), `wallet-test-verify-state-${process.pid}.json`);

function runWallet(args, input = '', env = {}) {
  const full = args.includes('--verify-state') ? args : ['--verify-state', TEST_STATE, ...args];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['wallet.mjs', ...full], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
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

// Runs the CLI with stdin pretending to be a terminal, which is what makes it
// ask for the passphrase. Raw mode is stubbed because the input is a pipe; the
// reader still walks the same code, and a terminal would only add the tty flag.
function runWalletPrompted(args, input = '', env = {}) {
  const script = [
    "Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });",
    'process.stdin.setRawMode = () => {};',
    `process.argv = ['node', 'wallet.mjs', ...${JSON.stringify(args)}];`,
    `await import(${JSON.stringify(WALLET_URL)});`,
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, BIP39_PASSPHRASE: '', BIP39_PASSPHRASE_FILE: '', ...env },
    });
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

// Address #0 of a phrase at a given passphrase, derived here rather than by the
// tool, so a wrong passphrase wiring shows up as a mismatch.
function addressFor(phrase, passphrase, index = 0) {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase, passphrase))
    .derive("m/84'/0'/0'")
    .deriveChild(0)
    .deriveChild(index);
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey) }).address;
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

console.log('\n== writing a secret to a file instead of a redirect ==');
const secretDir = mkdtempSync(join(tmpdir(), 'wallet-out-'));
const phrasePath = join(secretDir, 'backup.txt');

run = await runWallet(['--phrase-only', '--out', phrasePath]);
check('--phrase-only --out exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
const written = readFileSync(phrasePath, 'utf8');
const writtenPhrase = written.trim();
check('it writes the 24 words', writtenPhrase.split(' ').length === 24, writtenPhrase);
check(
  'and no word of them reaches stdout',
  !run.stdout.includes(writtenPhrase.split(' ')[0]),
  run.stdout,
);
check('it says where it wrote', run.stdout.includes(phrasePath), run.stdout);

const mode = statSync(phrasePath).mode & 0o777;
if (process.platform === 'win32') {
  check(
    'on Windows it says the folder permissions apply',
    /kept the folder's permissions/.test(run.stdout),
    run.stdout,
  );
} else {
  check('the file is created owner-only', mode === 0o600, mode.toString(8));
}

const restored = await runWallet(['--restore', '--count', '1'], writtenPhrase);
check(
  'the written phrase restores the wallet it came from',
  restored.out.includes(addressFor(writtenPhrase, '')),
  restored.out,
);

run = await runWallet(['--phrase-only', '--out', phrasePath]);
check('writing it again exits 1', run.code === 1, `exit ${run.code}`);
check('it refuses to overwrite', /already exists - --out never overwrites/.test(run.out), run.out.trim());
check('and the first file is untouched', readFileSync(phrasePath, 'utf8') === written);

const keyPath = join(secretDir, 'key.wif');
const printedKey = await runWallet(['--restore', '--show-key', '--count', '1'], VECTOR);
const printedWif = (printedKey.stdout.match(/^ {2}([KL5][1-9A-HJ-NP-Za-km-z]{50,51})$/m) ?? [])[1] ?? '';
run = await runWallet(['--restore', '--show-key', '--count', '1', '--out', keyPath], VECTOR);
check('--show-key --out exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
check('it writes the same WIF the report prints', readFileSync(keyPath, 'utf8').trim() === printedWif, printedWif);
check('and keeps the WIF out of its own output', !run.out.includes(printedWif), run.out);

run = await runWallet(['--out', join(secretDir, 'nowhere.txt')]);
check('--out alone exits 1', run.code === 1, `exit ${run.code}`);
check('and says what it needs', /needs one of them/.test(run.out), run.out.trim());

const terminalPath = join(secretDir, 'terminal.txt');
const onTerminal = await runWalletOnTerminal(['--phrase-only', '--out', terminalPath]);
check('a terminal accepts --phrase-only --out', onTerminal.code === 0, `exit ${onTerminal.code}: ${onTerminal.out}`);
check(
  'because the phrase goes to the file, not the screen',
  !onTerminal.stdout.includes(readFileSync(terminalPath, 'utf8').trim().split(' ')[0]),
  onTerminal.stdout,
);
rmSync(secretDir, { recursive: true, force: true });

console.log('\n== change chain ==');
// Derived here from the same seed with the same libraries, independently of the
// tool's own path, so a wrong chain constant shows up as a mismatch.
const accountNode = HDKey.fromMasterSeed(mnemonicToSeedSync(VECTOR)).derive("m/84'/0'/0'");
const changeNode = accountNode.deriveChild(1);
const changeAddressAt = (index) =>
  bitcoin.payments.p2wpkh({ pubkey: Buffer.from(changeNode.deriveChild(index).publicKey) }).address;

run = await runWallet(['--restore', '--count', '2'], VECTOR);
check(
  'the report shows a change chain',
  /Change addresses \(m\/84'\/0'\/0'\/1, never handed out\):/.test(run.out),
  run.out,
);
check('with the change path spelled out', /#0\s+m\/84'\/0'\/0'\/1\/0\s+bc1q/.test(run.out), run.out);
check(
  'and the addresses the chain derives',
  run.out.includes(changeAddressAt(0)) && run.out.includes(changeAddressAt(1)),
  run.out,
);
check('which are not the receive addresses', changeAddressAt(0) !== EXPECTED_0, changeAddressAt(0));

run = await runWallet(['--xpub', receiveXpub]);
check(
  'a receive-chain xpub says the change chain is out of reach',
  /Change addresses: unavailable from a receive-chain xpub/.test(run.out),
  run.out,
);

run = await runWallet(['--xpub', accountXpub, '--count', '1']);
check('an account xpub does derive it', run.out.includes(changeAddressAt(0)), run.out);

run = await runWallet(['--restore', '--expect', changeNode.publicExtendedKey], VECTOR);
check('the change-chain xpub verifies on its own', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and is named as such', /matches --expect \(change-chain xpub\)/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', changeAddressAt(0)], VECTOR);
check('a change address verifies too', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and is reported as a change address', /matches --expect \(change #0\)/.test(run.out), run.out);

console.log('\n== fingerprint record ==');
const fpDir = mkdtempSync(join(tmpdir(), 'wallet-fingerprint-'));
const fpPath = join(fpDir, 'wallet-fingerprint.txt');

run = await runWallet(['--restore', '--fingerprint', fpPath, '--count', '3'], VECTOR);
check('recording a fingerprint exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
check('it says the file is safe to commit', /safe to commit/.test(run.stderr), run.stderr.trim());
const fpText = readFileSync(fpPath, 'utf8');
check('the record holds the account xpub', fpText.includes(accountXpub), fpText.split('\n')[6]);
check('the record holds the receive-chain xpub', fpText.includes(receiveXpub), fpText.split('\n')[7]);
check('the record holds the change-chain xpub', fpText.includes(changeNode.publicExtendedKey), fpText);
check(
  'and it is labelled as such',
  /^change-chain-xpub: xpub/m.test(fpText),
  fpText,
);

const wrongChangePath = join(fpDir, 'change-swapped.txt');
writeFileSync(wrongChangePath, fpText.replace(/^change-chain-xpub: \S+$/m, `change-chain-xpub: ${receiveXpub}`));
run = await runWallet(['--restore', '--expect-file', wrongChangePath], VECTOR);
check('a record pinning the wrong change-chain xpub exits 3', run.code === 3, `exit ${run.code}`);
check('and names that field', /change-chain xpub/.test(run.out), run.out);
check('the record holds address #0', fpText.includes(EXPECTED_0), fpText);
check('the record holds address #1', fpText.includes(EXPECTED_1), fpText);
check('the record holds three addresses', (fpText.match(/^address #\d+: /gm) ?? []).length === 3, fpText);
const defaultPath = join(fpDir, 'default.txt');
run = await runWallet(['--restore', '--fingerprint', defaultPath], VECTOR);
const defaultText = readFileSync(defaultPath, 'utf8');
check(
  'without --count a record pins five addresses',
  (defaultText.match(/^address #\d+: /gm) ?? []).length === 5,
  String((defaultText.match(/^address #\d+: /gm) ?? []).length),
);
check(
  'and they are the vector addresses',
  defaultText.includes(EXPECTED_0) && defaultText.includes(EXPECTED_1),
  defaultText,
);

run = await runWallet(['--restore', '--expect-file', defaultPath], VECTOR);
check('a five-address record verifies all five', run.code === 0, `exit ${run.code}`);
check('and summarises the range', /addresses #0\.\.#4/.test(run.out), run.out);

run = await runWallet(['--xpub', accountXpub]);
check(
  'an xpub with no --count prints one address per chain',
  (run.stdout.match(/^ {2}#\d+ /gm) ?? []).length === 2,
  run.stdout,
);
check('the receive one is #0', run.stdout.includes(EXPECTED_0), run.stdout);

run = await runWallet([]);
check(
  'the report still prints one address per chain by default',
  (run.stdout.match(/^ {2}#\d+ /gm) ?? []).length === 2,
  run.stdout,
);

check('no phrase word reaches the record', !fpText.includes('abandon'), fpText);
check('no extended private key reaches the record', !/xprv|tprv/.test(fpText), fpText);
check('it documents how to check a backup', /--expect-file/.test(fpText), fpText);
check('it records its format version', /^fingerprint-version: 1$/m.test(fpText), fpText);
check("it records the derivation path", /^path: m\/84'\/0'\/0'$/m.test(fpText), fpText);
check('it records that no 25th word was used', /^passphrase: none$/m.test(fpText), fpText);

console.log('\n== the record says which passphrase it needs ==');
const passPath = join(fpDir, 'with-passphrase.txt');
run = await runWallet(['--restore', '--fingerprint', passPath, '--count', '2'], VECTOR, {
  BIP39_PASSPHRASE: '25th word',
});
const passText = readFileSync(passPath, 'utf8');
check('a passphrase record says it is required', /^passphrase: required$/m.test(passText), passText);

run = await runWallet(['--restore', '--expect-file', passPath], VECTOR);
check('verifying it without the 25th word exits 3', run.code === 3, `exit ${run.code}`);
check(
  'the message names the passphrase, not the phrase',
  /made with a 25th word and none was supplied/.test(run.out),
  run.out,
);
check('and not the generic blame', !/phrase, the passphrase or the recorded value/.test(run.out), run.out);
check(
  'the failing check is shown as a comparison',
  /BIP-39 passphrase/.test(run.out) && /expected\s+required/.test(run.out) && /restored\s+none/.test(run.out),
  run.out,
);

run = await runWallet(['--restore', '--expect-file', passPath], VECTOR, { BIP39_PASSPHRASE: 'wrong word' });
check('a wrong 25th word still falls back to the generic blame', /phrase, the passphrase or the recorded value/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect-file', fpPath], VECTOR, { BIP39_PASSPHRASE: 'unwanted' });
check('a 25th word against a no-passphrase record exits 3', run.code === 3, `exit ${run.code}`);
check('and says one was supplied anyway', /made without a 25th word but one was supplied/.test(run.out), run.out);

console.log('\n== a record for somewhere else ==');
const futurePath = join(fpDir, 'version-99.txt');
writeFileSync(futurePath, fpText.replace('fingerprint-version: 1', 'fingerprint-version: 99'));
run = await runWallet(['--restore', '--expect-file', futurePath], VECTOR);
check('an unknown version exits 1', run.code === 1, `exit ${run.code}`);
check('and names both versions', /version 99/.test(run.out) && /reads version 1/.test(run.out), run.out.trim());

const otherPath = join(fpDir, 'testnet-path.txt');
writeFileSync(otherPath, fpText.replace(/^path: .*$/m, "path: m/84'/1'/0'"));
run = await runWallet(['--restore', '--expect-file', otherPath], VECTOR);
check('a record for another path exits 3', run.code === 3, `exit ${run.code}`);
check(
  'and explains it is not this wallet',
  /that record covers m\/84'\/1'\/0' and this tool restores m\/84'\/0'\/0'/.test(run.out),
  run.out,
);

const legacyPath = join(fpDir, 'legacy.txt');
writeFileSync(
  legacyPath,
  fpText
    .split('\n')
    .filter((line) => !/^(fingerprint-version|path|passphrase):/.test(line))
    .join('\n'),
);
run = await runWallet(['--restore', '--expect-file', legacyPath], VECTOR);
check('a record without provenance still verifies', run.code === 0, `exit ${run.code}: ${run.out}`);
check(
  'and says only what it checked',
  /matches --expect-file .*\(account xpub, receive-chain xpub, change-chain xpub, addresses #0\.\.#2\)/.test(run.out),
  run.out,
);

run = await runWallet(['--restore', '--expect-file', fpPath], VECTOR);
check('a matching record verifies', run.code === 0, `exit ${run.code}: ${run.out}`);
check(
  'and lists what it checked',
  /matches --expect-file .*\(derivation path, BIP-39 passphrase, account xpub, receive-chain xpub, change-chain xpub, addresses #0\.\.#2\)/.test(
    run.out,
  ),
  run.out,
);

run = await runWallet(['--restore', '--expect-file', fpPath], VECTOR, { BIP39_PASSPHRASE: 'wrong' });
check('the wrong passphrase against a record exits 3', run.code === 3, `exit ${run.code}`);

run = await runWallet(
  ['--restore', '--expect-file', fpPath],
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
);
check('a different wallet against a record exits 3', run.code === 3, `exit ${run.code}`);

const tamperedPath = join(fpDir, 'tampered.txt');
writeFileSync(tamperedPath, fpText.replace(/^address #2: \S+$/m, `address #2: ${EXPECTED_0}`));
run = await runWallet(['--restore', '--expect-file', tamperedPath], VECTOR);
check('a tampered address exits 3', run.code === 3, `exit ${run.code}`);
check('and names the field', /address #2/.test(run.out), run.out.trim());

const xpubOnlyPath = join(fpDir, 'xpub-only.txt');
writeFileSync(
  xpubOnlyPath,
  fpText
    .split('\n')
    .filter((line) => line.startsWith('account-xpub:') || line.startsWith('receive-chain-xpub:'))
    .join('\n'),
);
run = await runWallet(['--restore', '--expect-file', xpubOnlyPath], VECTOR);
check('a trimmed record still verifies what it keeps', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and says only that', /\(account xpub, receive-chain xpub\)/.test(run.out), run.out);

run = await runWallet(['--fingerprint', join(fpDir, 'generated.txt')]);
check(
  'a generated wallet can be recorded too',
  run.code === 0 && readFileSync(join(fpDir, 'generated.txt'), 'utf8').includes('account-xpub:'),
  `exit ${run.code}`,
);

run = await runWallet(['--restore', '--expect-file', join(fpDir, 'missing.txt')], VECTOR);
check('a missing record exits 1', run.code === 1, `exit ${run.code}`);
check('and says it cannot be read', /cannot read --expect-file/.test(run.out), run.out.trim());

writeFileSync(join(fpDir, 'junk.txt'), 'hello there\n');
run = await runWallet(['--restore', '--expect-file', join(fpDir, 'junk.txt')], VECTOR);
check('a file that is not a record exits 1', run.code === 1, `exit ${run.code}`);
check('and says so', /is not a wallet fingerprint/.test(run.out), run.out.trim());

run = await runWallet(['--expect-file', fpPath], VECTOR);
check('--expect-file without --restore exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--restore', '--expect', accountXpub, '--expect-file', fpPath], VECTOR);
check('--expect and --expect-file cannot be combined', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--xpub', receiveXpub, '--fingerprint', join(fpDir, 'x.txt')]);
check('--fingerprint with --xpub exits 1', run.code === 1, `exit ${run.code}`);

run = await runWallet(['--phrase-only', '--fingerprint', join(fpDir, 'y.txt')]);
check('--phrase-only with --fingerprint exits 1', run.code === 1, `exit ${run.code}`);

rmSync(fpDir, { recursive: true, force: true });

console.log('\n== a report is not a phrase ==');
const report = await runWallet([]);
run = await runWallet(['--restore'], report.stdout);
check('feeding the whole report exits 1', run.code === 1, `exit ${run.code}`);
check('it names the input as the report', /full report from wallet\.mjs/.test(run.out), run.out.trim());
check('it says the phrase is the 24-word line inside it', /24-word line inside it/.test(run.out), run.out.trim());
check('it points at --phrase-only', /--phrase-only/.test(run.out), run.out.trim());
check('the generic phrase error is not used', !/not a valid BIP-39 seed phrase/.test(run.out), run.out.trim());

const phraseLine = (report.stdout.match(/^ {2}([a-z]+ ){23}[a-z]+$/m) ?? [''])[0].trim();
run = await runWallet(['--restore'], phraseLine);
check('the line it points at does restore', run.code === 0, `exit ${run.code}: ${run.out.trim().slice(0, 80)}`);

run = await runWallet(['--restore'], 'hello darkness my old friend');
check('a plain bad phrase keeps the generic error', run.code === 1, `exit ${run.code}`);
check('and is not mistaken for a report', /not a valid BIP-39 seed phrase/.test(run.out), run.out.trim());

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
check('and names what matched', /matches --expect \(account xpub\)/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', receiveXpub], VECTOR);
check('a matching receive-chain xpub exits 0', run.code === 0, `exit ${run.code}`);
check('and distinguishes the depth', /matches --expect \(receive-chain xpub\)/.test(run.out), run.out);

run = await runWallet(['--restore', '--expect', EXPECTED_0], VECTOR);
check('a matching address #0 exits 0', run.code === 0, `exit ${run.code}`);
check('and names the index', /matches --expect \(address #0\)/.test(run.out), run.out);

run = await runWallet(['--restore', '--count', '3', '--expect', vectorAddress2], VECTOR);
check('an address inside --count matches', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and is reported by index', /matches --expect \(address #2\)/.test(run.out), run.out);

// The default window is the same five a fingerprint records, so an address out
// of a record needs no extra flag to verify.
const four = await runWallet(['--xpub', receiveXpub, '--count', '4']);
const vectorAddress3 = (four.out.match(/#3\s+\S+\s+(\S+)/) ?? [])[1];
run = await runWallet(['--restore', '--expect', vectorAddress3], VECTOR);
check('by default a bare address is found at #3', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and says which index matched', /matches --expect \(address #3\)/.test(run.out), run.out);

console.log('\n== --expect catches the wrong wallet ==');
run = await runWallet(['--restore', '--count', '2', '--expect', vectorAddress2], VECTOR);
check('an address outside an explicit --count exits 3', run.code === 3, `exit ${run.code}`);
check(
  'the mismatch shows both sides',
  /expected\s+bc1q/.test(run.out) && /restored\s+no match on either chain in #0\.\.#1/.test(run.out),
  run.out,
);

const missingAddress = `${vectorAddress2.slice(0, -1)}${vectorAddress2.endsWith('z') ? 'q' : 'z'}`;
run = await runWallet(['--restore', '--expect', missingAddress], VECTOR);
check('an address in no slot of the default window exits 3', run.code === 3, `exit ${run.code}`);
check(
  'and says where it looked, with #0 as the sample',
  /restored\s+no match on either chain in #0\.\.#4; #0 is bc1q[0-9a-z]{38}$/m.test(run.out),
  run.out,
);

run = await runWallet(['--restore', '--expect', accountXpub], VECTOR, { BIP39_PASSPHRASE: 'wrong' });
check('right phrase, wrong passphrase exits 3', run.code === 3, `exit ${run.code}`);
check('it says not to fund the wallet', /do not fund this wallet/.test(run.out), run.out.trim());

const otherPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
run = await runWallet(['--restore', '--expect', accountXpub], otherPhrase);
check('a different valid phrase exits 3', run.code === 3, `exit ${run.code}`);
check(
  'the expected and derived xpubs are both shown',
  /expected\s+xpub/.test(run.out) && /restored\s+account xpub xpub/.test(run.out),
  run.out,
);

run = await runWallet(['--restore', '--expect', tpubAccount], VECTOR);
check('a testnet tpub never matches a mainnet restore', run.code === 3, `exit ${run.code}`);
check('the message names the network, not the phrase', /testnet and this wallet restores mainnet only/.test(run.out), run.out.trim());
check('and does not blame the passphrase', !/passphrase or the recorded value/.test(run.out), run.out.trim());

run = await runWallet(['--restore', '--expect', EXPECTED_TESTNET_0], VECTOR);
check('a testnet address never matches either', run.code === 3, `exit ${run.code}`);
check('and is explained the same way', /testnet and this wallet restores mainnet only/.test(run.out), run.out.trim());

run = await runWallet(['--restore', '--expect', accountXpub], VECTOR, { BIP39_PASSPHRASE: 'wrong' });
check('a genuinely wrong passphrase still blames the passphrase', /passphrase or the recorded value is wrong/.test(run.out), run.out.trim());

console.log('\n== the 25th word without the environment ==');
const passDir = mkdtempSync(join(tmpdir(), 'wallet-passphrase-'));
const withNewline = join(passDir, 'pass-newline.txt');
const bare = join(passDir, 'pass-bare.txt');
const crlf = join(passDir, 'pass-crlf.txt');
writeFileSync(withNewline, 'x\n');
writeFileSync(bare, 'x');
writeFileSync(crlf, 'x\r\n');

const addressLines = (out) => (out.match(/^ {2}#\d .*$/gm) ?? []).join('|');

run = await runWallet(['--restore', '--count', '2'], VECTOR, { BIP39_PASSPHRASE: 'x' });
const envAddresses = addressLines(run.out);
check('the variable still restores a passphrased wallet', envAddresses.includes('bc1q') && run.code === 0, run.out);

run = await runWallet(['--restore', '--count', '2', '--passphrase-file', withNewline], VECTOR, {
  BIP39_PASSPHRASE: '',
});
check('a file restores the same wallet as the variable', addressLines(run.out) === envAddresses, run.out);

run = await runWallet(['--restore', '--count', '2', '--passphrase-file', bare], VECTOR, { BIP39_PASSPHRASE: '' });
check('and the file needs no final newline', addressLines(run.out) === envAddresses, run.out);

run = await runWallet(['--restore', '--count', '2', '--passphrase-file', crlf], VECTOR, { BIP39_PASSPHRASE: '' });
check('and a Windows line ending is not part of the word', addressLines(run.out) === envAddresses, run.out);

run = await runWallet(['--restore', '--count', '2'], VECTOR, {
  BIP39_PASSPHRASE: '',
  BIP39_PASSPHRASE_FILE: withNewline,
});
check('BIP39_PASSPHRASE_FILE names a file too', addressLines(run.out) === envAddresses, run.out);

run = await runWallet(['--restore', '--count', '2'], VECTOR, { BIP39_PASSPHRASE: '' });
check('with none of the three, the addresses are the unpassphrased ones', run.out.includes(EXPECTED_0), run.out);

run = await runWallet(['--restore', '--passphrase-file', join(passDir, 'missing.txt')], VECTOR);
check('a missing passphrase file exits 1', run.code === 1, `exit ${run.code}`);
check('and names the file', /cannot read the passphrase file .*missing\.txt/.test(run.out), run.out.trim());

console.log('\n== reading the passphrase from the terminal ==');
run = await runWalletPrompted(['--count', '1'], 'secret\r');
check('the prompt exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
check('it asks without saying what is typed', /BIP-39 passphrase \(empty for none\): /.test(run.out), run.out);
check('the passphrase is not echoed', !run.out.includes('secret'), run.out);

const promptedPhrase = (run.stdout.match(/^ {2}((?:[a-z]+ ){23}[a-z]+)$/m) ?? [])[1] ?? '';
const promptedAddress = (run.stdout.match(/^ {2}#0 .*(bc1q[0-9a-z]+)$/m) ?? [])[1] ?? '';
check('it generated a phrase', promptedPhrase.split(' ').length === 24, run.out);
check(
  'the typed word is the passphrase it used',
  promptedAddress === addressFor(promptedPhrase, 'secret'),
  `printed ${promptedAddress} vs derived ${addressFor(promptedPhrase, 'secret')}`,
);

run = await runWalletPrompted(['--count', '1'], '\r');
const emptyPhrase = (run.stdout.match(/^ {2}((?:[a-z]+ ){23}[a-z]+)$/m) ?? [])[1] ?? '';
const emptyAddress = (run.stdout.match(/^ {2}#0 .*(bc1q[0-9a-z]+)$/m) ?? [])[1] ?? '';
check('an empty answer means no passphrase', emptyAddress === addressFor(emptyPhrase, ''), run.out);

run = await runWalletPrompted(['--count', '1'], '\r', { BIP39_PASSPHRASE: 'x' });
check('a variable in the environment suppresses the prompt', !/BIP-39 passphrase \(empty/.test(run.out), run.out);
check('and says where it came from', /BIP39_PASSPHRASE comes from the environment/.test(run.out), run.out);

run = await runWalletPrompted(['--count', '1'], '\r');
check('with the prompt in use there is no environment note', !/comes from the environment/.test(run.out), run.out);
rmSync(passDir, { recursive: true, force: true });

console.log('\n== the check leaves a timestamp for the watchdog ==');
// Run in a scratch directory so the state file does not land in the repository.
const verifyDir = mkdtempSync(join(tmpdir(), 'wallet-verify-'));
const statePath = join(verifyDir, 'verify-state.json');
const localRecord = join(verifyDir, 'record.txt');
await runWallet(['--restore', '--fingerprint', localRecord, '--count', '2'], VECTOR);

run = await runWallet(['--restore', '--expect-file', localRecord, '--verify-state', statePath], VECTOR);
check('a successful check exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
check('and writes the state file', existsSync(statePath), verifyDir);

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
check(
  'with a timestamp that is now',
  Number.isFinite(Date.parse(state.verifiedAt)) && Math.abs(Date.now() - Date.parse(state.verifiedAt)) < 60_000,
  JSON.stringify(state),
);
check('and the record it verified', state.record === localRecord, JSON.stringify(state));
check('it says where it recorded it', run.out.includes(`Recorded in ${statePath}`), run.out);

const failedState = join(verifyDir, 'failed-state.json');
run = await runWallet(['--restore', '--expect', EXPECTED_TESTNET_0, '--verify-state', failedState], VECTOR);
check('a failed check exits 3', run.code === 3, `exit ${run.code}`);
check('and leaves no timestamp behind', !existsSync(failedState), failedState);

const planted = JSON.stringify({ verifiedAt: '2020-01-01T00:00:00.000Z', record: 'older' });
writeFileSync(statePath, planted);
run = await runWallet(['--restore', '--expect', accountXpub, '--verify-state', statePath], VECTOR);
check('a bare --expect does not touch the state file', readFileSync(statePath, 'utf8') === planted, readFileSync(statePath, 'utf8'));
rmSync(verifyDir, { recursive: true, force: true });

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
