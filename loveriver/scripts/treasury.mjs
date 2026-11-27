// The treasury key signs the deployment and then every transfer in the
// distribution, so it is live for hours and is the last secret worth leaving in
// plaintext. It can come from the environment as before, or from a keystore
// written by `npm run keystore -- encrypt-treasury`; either way it is unlocked
// once per run and only exists in memory.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { askPassphrase, decryptKey } from './keystore.mjs';

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

export function defaultKeystore(root) {
  return join(root, 'wallets', 'treasury.keystore.json');
}

/** What TREASURY_PRIVATE_KEY points at: a plaintext key, a keystore, or nothing. */
export function keySource(root, value) {
  const trimmed = value?.trim();
  if (trimmed && HEX_KEY.test(trimmed)) return { kind: 'env' };
  if (trimmed) return { kind: 'keystore', file: isAbsolute(trimmed) ? trimmed : resolve(root, trimmed) };
  const fallback = defaultKeystore(root);
  return existsSync(fallback) ? { kind: 'keystore', file: fallback } : undefined;
}

/** The 0x… key, prompting once if it is encrypted. Undefined when unconfigured. */
export async function loadPrivateKey(root, value) {
  const source = keySource(root, value);
  if (!source) return undefined;
  if (source.kind === 'env') return value.trim();
  if (!existsSync(source.file)) throw new Error(`keystore ${source.file} does not exist`);

  const keystore = JSON.parse(readFileSync(source.file, 'utf8'));
  const key = decryptKey(keystore, await askPassphrase(false, `passphrase for ${source.file}: `));
  const address = privateKeyToAccount(key).address;
  const recorded = typeof keystore.address === 'string' ? `0x${keystore.address.replace(/^0x/, '')}` : undefined;
  if (recorded && recorded.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`${source.file} decrypted to ${address}, not the address it records`);
  }
  return key;
}
