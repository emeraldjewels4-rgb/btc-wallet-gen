#!/usr/bin/env node
/**
 * End-to-end rehearsal for btc-refill.mjs against a fake mempool.space-compatible
 * API on a regtest-style network with fake UTXOs.
 *
 * This exercises the real PSBT path: UTXO selection, signing, local verification
 * and broadcast. The fake server independently re-verifies every input signature
 * and rejects invalid transactions, so a passing run proves the signed witness
 * data is correct.
 *
 * Run: npm run rehearse:btc
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { startFakeSlack } from './fake-slack.mjs';

const ECPair = ECPairFactory(ecc);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = bitcoin.networks.regtest;
const FEE_RATE = 5;
const AUDIT = join(tmpdir(), 'btc-refill-rehearsal-audit.jsonl');
const DRY_AUDIT = join(tmpdir(), 'btc-refill-rehearsal-dry.jsonl');
// The spend anchor beside each log. The rehearsal resets the ledger, so a
// leftover anchor from an earlier run must go too - otherwise the run is
// refused for contradicting a log that was deliberately reset.
const ANCHOR = `${AUDIT}.state.json`;
const DRY_ANCHOR = `${DRY_AUDIT}.state.json`;
const AMOUNT = 50000n; // 0.0005 BTC
const DUST = 546n;

let failures = 0;
const outputs = [];
let slack = null;
let alertSlack = null;
let warningSlack = null;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

// Signatures commit to the BIP-143 scriptCode (P2PKH form), computed below.

const treasury = ECPair.makeRandom({ network: NETWORK });
const treasuryPayment = bitcoin.payments.p2wpkh({ pubkey: treasury.publicKey, network: NETWORK });
const treasuryAddress = treasuryPayment.address;
const treasuryScript = treasuryPayment.output;
const treasuryScriptCode = bitcoin.payments.p2pkh({ pubkey: treasury.publicKey, network: NETWORK }).output;
const treasuryWif = treasury.toWIF();

const target = ECPair.makeRandom({ network: NETWORK });
const targetAddress = bitcoin.payments.p2wpkh({ pubkey: target.publicKey, network: NETWORK }).address;

const mainnetTarget = ECPair.makeRandom({ network: bitcoin.networks.bitcoin });

// wallet: address -> confirmed UTXOs
const wallet = new Map([
  [treasuryAddress, [200000n, 150000n, 100000n].map((value, vout) => ({ txid: randomBytes(32).toString('hex'), vout, value }))],
  [targetAddress, []],
]);

const broadcasts = [];
let apiBase = '';

function verifyTx(tx, snapshot) {
  for (let i = 0; i < tx.ins.length; i += 1) {
    const input = tx.ins[i];
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    const utxo = snapshot.get(`${txid}:${input.index}`);
    if (!utxo) return `input ${i} spends unknown outpoint ${txid}:${input.index}`;
    const witness = input.witness;
    if (!witness || witness.length !== 2) return `input ${i} has a malformed witness`;
    const [signatureWithType, pubkey] = witness;
    let decoded;
    try {
      decoded = bitcoin.script.signature.decode(signatureWithType);
    } catch {
      return `input ${i} has an undecodable signature`;
    }
    const hash = tx.hashForWitnessV0(i, treasuryScriptCode, BigInt(utxo.value), decoded.hashType);
    if (!ecc.verify(hash, pubkey, Buffer.from(decoded.signature))) return `input ${i} has an invalid signature`;
    if (!Buffer.from(bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).output).equals(treasuryScript)) {
      return `input ${i} is not signed by the treasury key`;
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  if (url.pathname === '/v1/fees/recommended') {
    return send(200, JSON.stringify({ fastestFee: 9, halfHourFee: FEE_RATE, hourFee: 3, economyFee: 1, minimumFee: 1 }));
  }

  const utxoMatch = /^\/address\/([^/]+)\/utxo$/.exec(url.pathname);
  if (utxoMatch) {
    const address = decodeURIComponent(utxoMatch[1]);
    const list = (wallet.get(address) ?? []).map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: Number(utxo.value),
      status: { confirmed: true },
    }));
    return send(200, JSON.stringify(list));
  }

  if (url.pathname === '/tx' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const hex = Buffer.concat(chunks).toString('utf8').trim();

    let tx;
    try {
      tx = bitcoin.Transaction.fromHex(hex);
    } catch {
      return send(400, 'unparseable transaction');
    }

    const snapshot = new Map();
    for (const list of wallet.values()) {
      for (const utxo of list) snapshot.set(`${utxo.txid}:${utxo.vout}`, utxo);
    }

    const problem = verifyTx(tx, snapshot);
    if (problem) return send(400, problem);

    const spentSum = tx.ins.reduce(
      (acc, input) => acc + BigInt(snapshot.get(`${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`).value),
      0n,
    );
    const spentKeys = new Set(
      tx.ins.map((input) => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`),
    );

    for (const [address, list] of wallet) {
      wallet.set(address, list.filter((utxo) => !spentKeys.has(`${utxo.txid}:${utxo.vout}`)));
    }

    const txid = tx.getId();
    tx.outs.forEach((out, vout) => {
      let address;
      try {
        address = bitcoin.address.fromOutputScript(out.script, NETWORK);
      } catch {
        return;
      }
      const list = wallet.get(address);
      if (list) list.push({ txid, vout, value: out.value });
    });

    broadcasts.push({ hex, txid, spentSum, tx });
    return send(200, txid, 'text/plain');
  }

  return send(404, 'not found');
});

function runRefill(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['btc-refill.mjs', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        BTC_TREASURY_WIF: treasuryWif,
        SLACK_WEBHOOK_URL: slack.url,
        SLACK_ALERT_WEBHOOK_URL: alertSlack.url,
        SLACK_WARNING_WEBHOOK_URL: warningSlack.url,
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => {
      outputs.push(out);
      resolve({ code, out });
    });
  });
}

try {
  rmSync(AUDIT, { force: true });
  rmSync(DRY_AUDIT, { force: true });
  rmSync(ANCHOR, { force: true });
  rmSync(DRY_ANCHOR, { force: true });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}`;
  slack = await startFakeSlack();
  alertSlack = await startFakeSlack();
  warningSlack = await startFakeSlack();
  console.log(`fake mempool API on ${apiBase}`);
  console.log(`treasury ${treasuryAddress} (450000 sats), target ${targetAddress}\n`);

  const base = ['--to', targetAddress, '--network', 'regtest', '--api', apiBase, '--audit', AUDIT];
  const live = [...base, '--live', '--max-per-refill', '0.0006', '--total-budget', '0.0012'];

  console.log('== live refills ==');
  let run = await runRefill([...live, '--amount', '0.0005', '--threshold', '0.001']);
  check('refill #1 exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #1 broadcast one transaction', broadcasts.length === 1, String(broadcasts.length));

  const first = broadcasts[0];
  const firstOut = first ? first.tx.outs.map((out) => out.value) : [];
  const firstFee = first ? first.spentSum - firstOut.reduce((acc, value) => acc + value, 0n) : 0n;
  check('target received exactly 0.0005 BTC', firstOut.includes(AMOUNT), firstOut.join(',') || 'no transaction');
  check(
    'change returned to the treasury',
    Boolean(first) && first.tx.outs.some((out) => bitcoin.address.fromOutputScript(out.script, NETWORK) === treasuryAddress),
  );
  check(
    'fee pays at least the requested rate',
    Boolean(first) && firstFee >= BigInt(first.tx.virtualSize()) * BigInt(FEE_RATE),
    first ? `${firstFee} sats for ${first.tx.virtualSize()} vB` : 'no transaction',
  );
  check('target balance is 50000 sats', wallet.get(targetAddress).reduce((acc, utxo) => acc + utxo.value, 0n) === AMOUNT, String(wallet.get(targetAddress).reduce((acc, utxo) => acc + utxo.value, 0n)));

  run = await runRefill([...live, '--amount', '0.0005', '--threshold', '0.001']);
  check('refill #2 exits 0', run.code === 0, `exit ${run.code}: ${run.out.trim()}`);
  check('refill #2 broadcast a second transaction', broadcasts.length === 2, String(broadcasts.length));
  check('target balance is 100000 sats', wallet.get(targetAddress).reduce((acc, utxo) => acc + utxo.value, 0n) === AMOUNT * 2n);

  run = await runRefill([...live, '--amount', '0.0005', '--threshold', '0.002']);
  check('refill #3 refused by budget (exit 3)', run.code === 3, `exit ${run.code}`);
  check('refusal names the budget', /REFUSING: budget/.test(run.out), run.out.trim());
  check('refused run broadcast nothing', broadcasts.length === 2, String(broadcasts.length));

  console.log('\n== dry run ==');
  run = await runRefill([
    ...base, '--audit', DRY_AUDIT, '--fee-rate', '6',
    '--amount', '0.0005', '--threshold', '1', '--max-per-refill', '0.001', '--total-budget', '0.01',
  ]);
  check('dry run exits 0 and prints a plan', run.code === 0 && /DRY RUN/.test(run.out), `exit ${run.code}`);
  check('dry run shows the fee rate it would use', /6 sat\/vB/.test(run.out), run.out.trim());
  check('dry run broadcasts nothing', broadcasts.length === 2, String(broadcasts.length));
  check('dry run writes no audit log', !existsSync(DRY_AUDIT));

  run = await runRefill([
    ...base, '--audit', DRY_AUDIT, '--amount', '0.0005', '--threshold', '0.5',
    '--min-treasury', '0.01', '--max-per-refill', '0.001', '--total-budget', '0.01',
  ]);
  check('dry run with a treasury floor exits 0', run.code === 0, `exit ${run.code}`);

  console.log('\n== refusals ==');
  run = await runRefill([
    '--to', targetAddress, '--network', 'regtest', '--api', apiBase, '--audit', AUDIT,
    '--live', '--amount', '0.01', '--threshold', '1',
    '--max-per-refill', '0.01', '--total-budget', '0.02',
  ]);
  check('insufficient confirmed funds refused (exit 3)', run.code === 3, `exit ${run.code}`);
  check('refusal explains the shortfall', /cannot cover/.test(run.out), run.out.trim());

  run = await runRefill(['--to', targetAddress, '--network', 'mainnet', '--api', apiBase, '--fee-rate', '5', '--amount', '0.0005', '--threshold', '1', '--live', '--max-per-refill', '0.001', '--total-budget', '0.01', '--audit', AUDIT]);
  check('wrong-network WIF rejected (exit 1, before any API call)', run.code === 1, `exit ${run.code}`);
  check('error names the network mismatch', /different network/.test(run.out), run.out.trim());

  run = await runRefill(['--to', 'notanaddress', '--network', 'regtest', '--api', apiBase, '--fee-rate', '5', '--amount', '0.0005', '--audit', AUDIT]);
  check('invalid address rejected (exit 1)', run.code === 1, `exit ${run.code}`);

  run = await runRefill(['--to', targetAddress, '--network', 'regtest', '--api', apiBase, '--fee-rate', '5', '--amount', '0.0005', '--live', '--audit', AUDIT]);
  check('live without caps rejected (exit 1)', run.code === 1, `exit ${run.code}`);

  run = await runRefill(['--to', mainnetTarget.publicKey && bitcoin.payments.p2wpkh({ pubkey: mainnetTarget.publicKey, network: bitcoin.networks.bitcoin }).address, '--network', 'regtest', '--api', apiBase, '--fee-rate', '5', '--amount', '0.0005', '--audit', AUDIT]);
  check('mainnet address rejected on regtest (exit 1)', run.code === 1, `exit ${run.code}`);

  console.log('\n== audit log ==');
  const auditExists = existsSync(AUDIT);
  const auditText = auditExists ? readFileSync(AUDIT, 'utf8') : '';
  const entries = auditText.trim() ? auditText.trim().split('\n').map((line) => JSON.parse(line)) : [];
  check('audit log was written', auditExists);
  check('two audit entries', entries.length === 2, String(entries.length));
  check(
    'entries are tagged bitcoin/regtest',
    entries.length === 2 && entries.every((entry) => entry.chain === 'bitcoin' && entry.network === 'regtest'),
  );
  check('entries record 50000 sats each', entries.length === 2 && entries.every((entry) => entry.amountSats === '50000'));
  check(
    'entries carry the broadcast txids',
    entries.length === broadcasts.length && entries.map((entry) => entry.txid).join() === broadcasts.map((b) => b.txid).join(),
  );
  check('entries record a positive fee', entries.length === 2 && entries.every((entry) => BigInt(entry.feeSats) > 0n));
  check('no WIF in the audit log', !auditText.includes(treasuryWif));

  console.log('\n== slack alerts ==');
  const alerts = slack.messages.map((message) => message.text ?? '');
  const refusalTexts = alertSlack.messages.map((message) => message.text ?? '');
  const warningTexts = warningSlack.messages.map((message) => message.text ?? '');
  check('two refusal alerts posted to the alert channel', refusalTexts.filter((text) => /refill refused/.test(text)).length === 2, String(refusalTexts.length));
  check(
    'refusal alert names bitcoin regtest',
    refusalTexts.some((text) => /refill refused/.test(text) && /bitcoin regtest/.test(text)),
    refusalTexts.join(' | '),
  );
  check(
    'budget refusal spells out the limit, spend and overage',
    refusalTexts.some(
      (text) =>
        /rule budget \(total spend budget\)/.test(text) &&
        /limit 0\.0012 BTC \| spent 0\.001 BTC \| remaining 0\.0002 BTC \| requested 0\.0005 BTC \| over by 0\.0003 BTC/.test(
          text,
        ),
    ),
    refusalTexts.join(' | '),
  );
  check(
    'treasury-shortfall refusal spells out what is missing',
    refusalTexts.some(
      (text) =>
        /rule treasury-low \(confirmed treasury balance\)/.test(text) &&
        /treasury holds 0\.003\d+ BTC \| short by about 0\.006\d+ BTC/.test(text),
    ),
    refusalTexts.join(' | '),
  );
  check('refusals carry the high severity marker', refusalTexts.every((text) => /severity high/.test(text)), refusalTexts.join(' | '));
  check('low-treasury alert posted to the warning channel', warningTexts.some((text) => /treasury low/.test(text)), warningTexts.join(' | '));
  check('low-treasury alert carries the medium severity marker', /severity medium/.test(warningTexts.join('\n')), warningTexts.join(' | '));
  check(
    'no alert is cross-posted',
    !alerts.some((text) => /refill refused|treasury low/.test(text)) &&
      !refusalTexts.some((text) => /refill sent|treasury low/.test(text)) &&
      !warningTexts.some((text) => /refill (refused|sent)/.test(text)),
  );
  check('success alert posted for each of the 2 sends', alerts.filter((text) => /refill sent/.test(text)).length === 2, String(alerts.length));
  check(
    'success alerts carry txids',
    alerts.filter((text) => /refill sent/.test(text)).every((text) => /[0-9a-f]{64}/.test(text)),
    alerts.join(' | '),
  );
  check('no WIF in any alert', ![...alerts, ...refusalTexts, ...warningTexts].some((text) => text.includes(treasuryWif)));

  console.log('\n== secret hygiene ==');
  check('WIF never appears in any run output', !outputs.join('').includes(treasuryWif));

  if (failures > 0) {
    console.error(`\nBTC REHEARSAL FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nBTC REHEARSAL PASSED');
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await slack?.close();
  await alertSlack?.close();
  await warningSlack?.close();
  rmSync(AUDIT, { force: true });
  rmSync(DRY_AUDIT, { force: true });
  rmSync(ANCHOR, { force: true });
  rmSync(DRY_ANCHOR, { force: true });
}
