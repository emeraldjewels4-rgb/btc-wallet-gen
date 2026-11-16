/**
 * Proof that a restored key can spend, not merely derive.
 *
 * Builds a p2wpkh input spending an outpoint that is never looked up, signs it
 * with the key behind address #0, checks the signature against the pubkey that
 * address commits to, and throws the transaction away. Nothing here touches the
 * network or the wallet, and no fee is paid: the answer is "this key can move
 * coins from this address", which is the one thing a derivation check cannot
 * tell you.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

// A placeholder outpoint, not a real UTXO: the check is about the signature over
// the sighash, and a real UTXO would make it depend on the chain being reachable.
const PLACEHOLDER_HASH = '00'.repeat(32);
const INPUT_VALUE = 10_000n;
const FEE = 1_000n;

// Returns { ok: true } or { ok: false, reason }. A key that does not belong here
// is an answer, not an exception.
export function spendProof({ child, address, network }) {
  const pubkey = Buffer.from(child.publicKey);
  const own = bitcoin.payments.p2wpkh({ pubkey, network });
  if (own.address !== address) {
    return { ok: false, reason: `the key belongs to ${own.address}, not to ${address}` };
  }

  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({ hash: PLACEHOLDER_HASH, index: 0, witnessUtxo: { script: own.output, value: INPUT_VALUE } });
  // Back to the same address: the spend is complete, and the fee is absurd on
  // purpose because this transaction must never be broadcast.
  psbt.addOutput({ address, value: INPUT_VALUE - FEE });
  psbt.signInput(0, {
    publicKey: pubkey,
    sign: (hash) => Buffer.from(ecc.sign(hash, Buffer.from(child.privateKey))),
  });

  // The signature must verify against the pubkey the address commits to, by the
  // library's ECDSA rather than by the signer's opinion of itself. This runs
  // before finalizing, which is when the partial signature is still visible.
  let verified;
  try {
    verified = psbt.validateSignaturesOfInput(0, (key, hash, signature) => ecc.verify(hash, key, signature));
  } catch (err) {
    return { ok: false, reason: `the signature could not be checked: ${err.message}` };
  }
  if (!verified) return { ok: false, reason: 'the signature does not verify for this address' };

  // A verified signature is not yet a spend: finalizing has to produce the
  // witness a p2wpkh input needs, with this key's own bytes in it.
  psbt.finalizeInput(0);
  const witness = psbt.extractTransaction().ins[0].witness ?? [];
  if (witness.length !== 2 || Buffer.compare(Buffer.from(witness[1]), pubkey) !== 0) {
    return { ok: false, reason: 'the finalized input does not carry a signature for that key' };
  }
  return { ok: true };
}
