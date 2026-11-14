# Security policy

This project signs and broadcasts transactions that move real funds on Bitcoin
and EVM chains. A bug here can lose money, so security reports are welcome and
taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.** Use GitHub's private
reporting instead: open the repository's **Security** tab and choose
**Report a vulnerability**. That creates a private advisory only the maintainer
can see.

If that form is unavailable to you, open a public issue that says only that you
have a security report and asks for a private channel. Do not include the
details, a proof of concept, or anything about a key in the issue itself.

Please include:

- the affected file and the version or commit you tested
- what an attacker gains: lost funds, a bypassed cap, leaked key material, a
  misleading status page
- the smallest reproduction you can manage, ideally on a local dev chain, on
  Sepolia, or on Bitcoin testnet/regtest
- whether the issue is already public anywhere

**Never send a private key, WIF, seed phrase, xprv/xpub or webhook URL** in a
report, an issue, a screenshot or a paste. Reproduce with throwaway keys
generated for the test. A report that leaks a live key is a worse outcome than
the bug.

## What to expect

- An acknowledgement within a few days.
- An assessment of severity and a fix, or an explanation of why it is out of
  scope, once I have reproduced it.
- Credit in the advisory and the fix commit, unless you ask to stay anonymous.
- Coordinated disclosure: I will aim to ship a fix and publish an advisory
  within 90 days of the report, sooner for anything that can drain a wallet.

There is no bug bounty. This is a small project maintained in spare time, so the
thanks are genuine but not financial.

## Safety invariants

These are the guarantees the tools are built around. A report that breaks one of
them is in scope, whichever tool it affects.

1. **Dry run by default.** Nothing is signed or broadcast without `--live`. A
   run without it may read balances and print a plan, and must not send.
2. **No live spend without caps.** `--live` refuses to start unless both
   `--max-per-refill` and `--total-budget` are set (as flags or environment
   defaults). Caps are checked before signing, and the EVM and Sepolia tools
   cost the transaction at worst-case gas, not at the estimate.
3. **Chain checks before signing.** The EVM tool only signs for the chain it was
   told to use; `sepolia-call.mjs` refuses any chain other than 11155111, so it
   cannot be pointed at mainnet.
4. **Secrets stay in the environment.** Keys are read from
   `TREASURY_PRIVATE_KEY` and `BTC_TREASURY_WIF`, which live in a git-ignored
   `.env`. They are never printed, logged, put in a Slack alert, written to the
   audit log, the lock file, the spend anchor or the status page.
5. **RPC URLs are logged by host only**, because they routinely carry API keys
   in the path.
6. **The audit log holds no secrets and no raw payloads.** Amounts, addresses,
   tx hashes and fees, plus a keccak256 hash and byte length for calldata -
   never the calldata itself.
7. **Bitcoin signatures are verified locally** against the treasury's own script
   before a transaction is broadcast.
8. **One run at a time, one ledger.** A run lock stops a scheduled run and a
   manual run from racing for the same nonce or UTXO set, and a spend anchor
   beside the audit log refuses a log that has shrunk rather than reading it as
   zero spent.
9. **The published page is inert.** Static HTML, no JavaScript, no external
   assets, no key material, and the HTML is scanned for keys, WIFs, xpubs and
   PEM blocks before it is written.

## Out of scope

- The documented limits in the README: no RBF or CPFP, a static P2WPKH fee
  model, one target address per run, and caps counted from a local audit log.
- Anyone who already controls your machine, your `.env`, your terminal history
  or your backups. This tool does not defend a compromised host.
- Custody design questions: losing a key, or sending to an address you do not
  control.
- Vulnerabilities in dependencies or in third-party RPC and mempool services,
  unless this project uses them in an unsafe way that is avoidable.

## Supported versions

Fixes land on `master`, which is the only supported branch. If you run from a
copy or a fork, verify it against `master` before reporting.
