# Recovering without this repository

This file is written to be read when `wallet.mjs`, Node, `node_modules` and this
repository are all gone - or when the machine they lived on is. It takes a
BIP-39 seed phrase to the `bc1q...` addresses the phrase owns, using a wallet
that has nothing to do with this code.

It is deliberately short. Everything here can be checked against the public
BIP-84 test vector in [Self-test](#self-test), which needs no secret and no
record.

## What you need

1. **The seed phrase** - 12, 15, 18, 21 or 24 BIP-39 words, in order.
2. **The passphrase**, if the fingerprint record says `passphrase: required`.
   It is a separate secret: it was not stored with the phrase, and without it
   the phrase restores a different, empty wallet.
3. **The fingerprint record**, if it survived: a small text file starting with
   `# wallet.mjs fingerprint`. Optional, but it is what turns "I think this is
   the wallet" into a check.
4. **A wallet you trust that is not this tool.** Any BIP-39/BIP-84 wallet does:
   Sparrow, Electrum, BlueWallet, a hardware wallet's recovery flow. The restore
   steps work in all of them; only the optional descriptor check below names a
   particular wallet.

## The derivation, in full

The record states all of this, and it is what makes the rest work:

| Field | Value | Meaning |
| --- | --- | --- |
| `path` | `m/84'/0'/0'` | BIP-84 account, coin type 0 (Bitcoin mainnet), account 0 |
| `coin` | `0` | Bitcoin mainnet. Testnet is `1`, and is a different wallet |
| `receive-path` | `m/84'/0'/0'/0` | addresses you are paid at |
| `change-path` | `m/84'/0'/0'/1` | change from spending, never handed out |
| `descriptor` | `wpkh([…/84h/0h/0h]xpub…/<0;1>/*)#…` | the account as one line a descriptor wallet can import: script type, key origin, both chains in the BIP-389 step `<0;1>` |

Address `i` on either chain is `<chain path>/i` - `m/84'/0'/0'/0/0` is the first
receive address, `m/84'/0'/0'/1/0` the first change address. Script type is
native SegWit, which is why addresses begin `bc1q`.

Two details that decide whether this works:

- **BIP-84, not BIP-44, BIP-49 or BIP-86.** A wallet restored as "Legacy" or
  "Nested SegWit" derives different addresses from the same phrase. Pick
  native SegWit / bech32.
- **The passphrase is part of the wallet**, not a password on the file. If the
  record says `passphrase: required`, the wallet's passphrase/25th-word field
  must be filled with that exact word, including case and spaces.

## Restore it in another wallet

Names differ per wallet; the shape does not.

1. Choose **restore / import an existing wallet**, not "create new".
2. Enter the seed phrase, in order, in the wallet's own word entry.
3. Enter the passphrase if the record requires one.
4. Choose **native SegWit (BIP-84)** as the script type, and account `0`. The
   record's `descriptor` line is a separate, watch-only check rather than an
   alternative to this step: see
   [Watching the record without the phrase](#watching-the-record-without-the-phrase).
5. Let the wallet show its first receive address.
6. Compare it with the record:

   ```sh
   grep '^address #0' fingerprint.txt
   ```

   That prints `address #0: bc1q...`. The part after the colon, and nothing else,
   must match the wallet's first receive address character for character.

If they match, the phrase, the passphrase and the derivation are all correct and
the wallet is the one the record describes. Its balance and history will appear
once the wallet has scanned the chain, which can take a few minutes - the
address matching is the answer, not the balance.

## Watching the record without the phrase

The `descriptor` line is the same account as one public line - script type, key
origin and both chains - and it holds no key. A wallet that reads descriptors can
import it and show whether those addresses hold anything, without the phrase ever
being typed. That makes it the quickest check that the record still describes the
wallet you think it does.

It is not a recovery. Watch-only means it cannot spend: use it to confirm, then
restore from the phrase when you want the funds.

1. Open a wallet that reads descriptors and choose importing a watch-only
   descriptor, not "restore" and not "new seed". Bitcoin Core's descriptor
   wallet is the reference one.
2. Paste the value only - everything after `descriptor: ` in the record, with the
   `#` and its eight characters kept. The two ways this fails are pasting the
   field name too, and dropping the `#...` part.
3. The check is `address #0`: the receive chain's first address must be the one
   the record lists. In Core, `listdescriptors` shows the two chains the import
   created, and `getnewaddress` returns `address #0` first.
4. A wallet that takes one chain per descriptor, rather than the BIP-389 form
   `<0;1>`, needs that step split by hand: `.../0/*` for receiving and `.../1/*`
   for change. Editing the line invalidates its checksum, so let the wallet
   compute a new one - `getdescriptorinfo` in Core does exactly that - and keep
   the split lines with the record.

## When address #0 does not match

In order of likelihood:

1. **Missing or wrong passphrase.** A record with `passphrase: required`
   verified without one gives plausible-looking addresses for a wallet that has
   never been used. Try the passphrase, then try it again with exact case.
2. **Wrong script type or account.** BIP-44/49/86, or account `1` instead of `0`.
3. **Testnet.** Addresses there start `tb1`; this wallet is mainnet only.
4. **A different phrase.** Two valid phrases can differ by one word; compare the
   words against the backup, not the addresses.
5. **The record belongs to another wallet.** Check `account-xpub` against any
   watch-only wallet you still have before concluding the phrase is wrong.

Do not move funds to an address from a restore that has not matched. A restore
that produced the wrong wallet still looks like a successful restore.

## Funds on change addresses

After any spend, the wallet holds funds at `m/84'/0'/0'/1/i` - addresses it never
showed you as payment addresses. A wallet restored as above scans them; a wallet
set up watch-only from `account-xpub` also covers them. `receive-chain-xpub`
alone does not: it is only the first chain. This is the reason the record carries
both chains, and states them again in the descriptor's `<0;1>` step.

## Moving the funds somewhere else

1. Restore into a wallet you trust, following the steps above, and confirm
   address #0.
2. Send the full balance to a new address from a wallet you control - ideally a
   new seed phrase generated offline, not the recovered one.
3. Verify the transaction, and keep the new phrase somewhere the old one is not.

Do this on a machine that is not full of strangers' software. The phrase is the
wallet: anything that reads it can spend from it.

## Reading the record without this tool

It is a text file; every line is `name: value`.

| Line | What it is |
| --- | --- |
| `fingerprint-version` | format version; a reader that does not recognise it should stop, not guess |
| `path`, `coin`, `receive-path`, `change-path` | the derivation, as in the table above |
| `passphrase` | `required` or `none` - whether a 25th word was used |
| `account-xpub` | account key `m/84'/0'/0'`, enough for a watch-only wallet |
| `receive-chain-xpub`, `change-chain-xpub` | each chain on its own |
| `descriptor` | the account as one BIP-380 descriptor with a BIP-389 `<0;1>` step: script type, key origin, both chains. No key in it, so it watches and cannot spend |
| `address #N` | receive addresses `0..N` |

Nothing in it is secret, but it does tie addresses together: whoever reads it
can see the balances at those addresses.

## Self-test

No secret is needed: this is the published BIP-84 test vector (the well-known
"abandon ... about" phrase), and these are the addresses the specification gives
for it.

| | |
| --- | --- |
| Phrase | `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` |
| Passphrase | none |
| `m/84'/0'/0'/0/0` | `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` |
| `m/84'/0'/0'/0/1` | `bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g` |
| `m/84'/0'/0'/1/0` | `bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el` |

Restore that phrase into your wallet of choice as native SegWit, account 0. If
the first address is `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`, the wallet,
the derivation and your reading of this file are all correct - and you can then
trust the same steps with the real phrase. If it is not, the wallet is using a
different derivation, and the per-wallet settings need finding before the real
phrase is worth typing anywhere.

The same vector as a descriptor, needing no phrase at all: import it watch-only
and a descriptor wallet should give you that same first address,
`bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`.

```text
wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)#qf45pmyh
```

## Limits of this document

- The restore steps are described generically on purpose: menu names change, and
  a version-specific instruction ages worse than none. The address comparison in
  step 6 is the part that must be true, and it is testable at any time with the
  self-test above. The descriptor check names Bitcoin Core because its descriptor
  wallet is the reference one; any other descriptor wallet should reach the same
  `address #0`, which is the result that matters.
- The self-test values come from the BIP-84 specification. The derivation this
  repository performs is checked against the same vector by its own tests, which
  is why the record and this file agree.
- Nothing here needs this repository, Node, or any of its dependencies. That is
  the point.
