/**
 * Proof that a restored key can spend, not merely derive.
 *
 * Builds a p2wpkh input spending an outpoint that is never looked up, signs it
 * with the key behind address #0, and checks that signature against the pubkey
 * the address itself commits to. Nothing here touches the network or the wallet,
 * and no fee is paid: the answer is "this key can move coins from this address",
 * which is the one thing a derivation check cannot tell you.
 *
 * The transaction is never finalized or serialized. Validation is the whole
 * proof - it recomputes the BIP-143 sighash from the input's own script and
 * checks the partial signature finalize would have consumed - so there is nothing
 * left worth building, and a txid for a spend that can never be broadcast would
 * only invite the question of why it is not on chain.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

// A placeholder outpoint, not a real UTXO: the check is about the signature over
// the sighash, and a real UTXO would make it depend on the chain being reachable.
const PLACEHOLDER_HASH = '00'.repeat(32);
const INPUT_VALUE = 10_000n;
const FEE = 1_000n;

// Returns { ok: true } or { ok: false, reason }. A key that does not belong here
// is an answer, not an exception: this never throws for a bad backup, so exit 3
// always means a verdict rather than a crash.
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

  // The library's ECDSA against the pubkey the address commits to, rather than
  // the signer's opinion of itself.
  return psbt.validateSignaturesOfInput(0, (key, hash, signature) => ecc.verify(hash, key, signature))
    ? { ok: true }
    : { ok: false, reason: 'the signature does not verify for this address' };
}
