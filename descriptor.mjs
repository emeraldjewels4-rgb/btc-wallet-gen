/**
 * The output descriptor for the account this tool derives: BIP-380 for the script
 * type, BIP-389 for both chains in one key expression.
 *
 * The record already pins the xpub and the paths, which a wallet restoring from
 * that xpub still has to interpret: guessing p2sh-p2wpkh instead of p2wpkh gives
 * different addresses from identical key material, and looks exactly like a bad
 * backup. A descriptor says which script the addresses use, so a wallet that
 * reads descriptors derives these addresses instead of guessing them.
 *
 * The multipath step is written <0;1>, brackets included: BIP-389 defines it that
 * way and descriptor parsers look for exactly that form, so a bare 0;1 is a parse
 * error rather than a line a wallet would accept. The checksum covers the text as
 * written, so it changes whenever the line does.
 */

// Both charsets are from BIP-380 / Bitcoin Core's descriptor.cpp; the checksum is
// meaningless unless they match exactly.
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

// BigInt on purpose: this is a 40-bit shift register, and JavaScript's bitwise
// operators would truncate it to 32 bits and produce a wrong checksum.
function polymod(symbols) {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i += 1) {
      if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function expand(text) {
  const symbols = [];
  let group = [];
  for (const char of text) {
    const value = INPUT_CHARSET.indexOf(char);
    if (value === -1) throw new Error(`a descriptor cannot contain ${JSON.stringify(char)}`);
    symbols.push(value & 31);
    group.push(value >> 5);
    if (group.length === 3) {
      symbols.push(group[0] * 9 + group[1] * 3 + group[2]);
      group = [];
    }
  }
  if (group.length === 1) symbols.push(group[0]);
  else if (group.length === 2) symbols.push(group[0] * 3 + group[1]);
  return symbols;
}

export function descriptorChecksum(descriptor) {
  const symbols = [...expand(descriptor), 0, 0, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(symbols) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += CHECKSUM_CHARSET[Number((checksum >> BigInt(5 * (7 - i))) & 31n)];
  }
  return out;
}

export function withChecksum(descriptor) {
  return `${descriptor}#${descriptorChecksum(descriptor)}`;
}

// What the descriptor means without its checksum, which is only a guard against
// transcription rather than part of the derivation.
export function stripChecksum(descriptor) {
  const hash = descriptor.lastIndexOf('#');
  return hash === -1 ? descriptor : descriptor.slice(0, hash);
}

export function descriptorChecksumOf(descriptor) {
  const hash = descriptor.lastIndexOf('#');
  return hash === -1 ? null : descriptor.slice(hash + 1);
}

// The master key's fingerprint, as BIP-380 key origin spells it.
export function fingerprintHex(master) {
  return master.fingerprint.toString(16).padStart(8, '0');
}

// wpkh([d34db33f/84h/0h/0h]xpub…/<0;1>/*): the script type, the key with the
// account path that produced it, and both chains in one BIP-389 multipath step.
export function accountDescriptor({ accountXpub, origin, receive = 0, change = 1 }) {
  const body = `wpkh(${origin ? `[${origin}]` : ''}${accountXpub}/<${receive};${change}>/*)`;
  return withChecksum(body);
}
