# btc-wallet-gen

Generates a new self-custody Bitcoin wallet, or restores an existing one, on the
local machine: a BIP-39 seed phrase and the BIP-84 native SegWit (`bc1q...`)
receive addresses it derives under `m/84'/0'/0'/0/i` (Bitcoin mainnet).

No network calls, no file writes, no telemetry.

## Setup

```sh
npm install
```

Requires Node 18 or newer.

## Generate a new wallet

```sh
node wallet.mjs                # seed phrase + first receive address
node wallet.mjs --count 5      # first 5 receive addresses
node wallet.mjs --show-key     # also print the WIF private key for address #0
```

The seed phrase is printed to stdout once and never stored. To keep it out of
your scrollback, redirect into encrypted storage you control:

```sh
node wallet.mjs > /path/to/encrypted-volume/seed.txt
```

## Restore an existing seed phrase

Derives the addresses an existing BIP-84 wallet uses for the same phrase,
offline. Feed the phrase on **stdin**, not as a command-line argument, where it
would be recorded in shell history and the process list:

```sh
node wallet.mjs --restore < seed.txt
cat seed.txt | node wallet.mjs --restore --count 5
node wallet.mjs --restore        # or paste it at the prompt (input is echoed)
```

Delete `seed.txt` afterwards.

### BIP-39 passphrase (optional 25th word)

If the wallet was created with a passphrase, pass it through the environment:

```sh
BIP39_PASSPHRASE='your 25th word' node wallet.mjs --restore < seed.txt
```

The passphrase is part of the wallet: a wrong or missing passphrase yields a
different, empty set of addresses. Confirm by comparing address `#0` — or the
printed receive-chain xpub (`m/84'/0'/0'/0`) — against your existing wallet.

## Flags

| Flag | Meaning |
| --- | --- |
| `--restore` | derive from a seed phrase read from stdin instead of generating one |
| `--xpub XPUB` | derive from an account (`m/84'/COIN'/0'`) or receive-chain xpub, using `xpub` (mainnet) or `tpub` (testnet), no secret needed |
| `--count N` | how many receive addresses to print, 1-20 (default 1) |
| `--show-key` | also print the WIF private key for address #0 |
| `-h`, `--help` | usage |

Environment: `BIP39_PASSPHRASE` (default empty).

## Verify before you fund it

The derivation is the standard BIP-84 path, so the same seed restores to the
same addresses in Sparrow, Electrum, BlueWallet, Coldcard and other BIP-84
wallets — `--restore` shows exactly what those wallets will show. Test with a
small amount first.

## Watch addresses with an xpub

An xpub is public: it derives every receive address and cannot spend anything.
Use the account xpub (`m/84'/0'/0'`) or the receive-chain xpub (`m/84'/0'/0'/0`)
that `--restore` prints. A testnet key serialises as `tpub`, derives `tb1q...`
addresses from `m/84'/1'/0'`, and is accepted the same way:

```sh
node wallet.mjs --xpub xpub6... --count 5
```

Both depths give the same addresses on either network. Output is marked
watch-only; an extended private key (`xprv` or `tprv`), a malformed key, a key
with the wrong prefix or an unsupported depth is refused before anything is
printed. This is the way to collect addresses for
`treasury-summary.mjs` without handling a seed phrase.

## Refill an address from your own treasury (EVM)

`refill.mjs` tops up a target address from a treasury wallet you control when the
target balance drops below a threshold. It moves only your own money between your
own addresses: it cannot create funds and cannot touch a chain it has no key for.

Dry run by default; `--live` requires both caps:

```sh
cp .env.example .env        # paste the treasury key; .env is git-ignored
node --env-file=.env refill.mjs --to 0xYOURTARGET \
  --threshold 0.001 --amount 0.005 \
  --max-per-refill 0.01 --total-budget 0.05
```

Add `--live` to sign and broadcast, `--watch 300` to poll every five minutes,
`--chain 11155111` to rehearse on Sepolia, `--rpc URL` for your own endpoint.
`--chain 31337 --rpc http://127.0.0.1:8545` drives a local Anvil/Hardhat/Ganache
node, which is how the send path is rehearsed without touching real funds.

Rails enforced before anything is signed:

- dry run unless `--live` is passed
- `--live` refuses to start without `--max-per-refill` and `--total-budget`
- refuses when the refill breaks the per-refill cap, or when spend recorded in
  `refill-audit.jsonl` would push the chain past its budget
- refuses when the treasury cannot cover value + worst-case gas
- refuses `--to` equal to the zero address or the treasury itself
- the key comes from `TREASURY_PRIVATE_KEY` and is never printed, logged or
  audited; RPC URLs (which often carry API keys) are logged by host only

Exit codes: 0 ok/no action, 1 usage or config error, 2 runtime error, 3 refused
by a safety rule.

Limits worth knowing:

- EVM chains only (Ethereum, Optimism, Polygon, Base, Arbitrum, Sepolia). A
  Bitcoin refill needs UTXO selection and PSBT signing, which is a separate build.
- Caps are counted per chain from the local audit log, so deleting that log
  resets the budget. Keep it.
- Rehearse on Sepolia with a throwaway key before pointing this at mainnet funds.
- `npm run rehearse` starts a local Ganache chain with fake funds and drives the
  live send path end to end: five signed transactions, cap and budget refusals,
  dry-run, and audit-log assertions.

## Refill a Bitcoin address from your own treasury (UTXO + PSBT)

`btc-refill.mjs` builds, signs and broadcasts a transaction that tops up a target
address when its balance drops below a threshold. It spends only your own
confirmed UTXOs, so it cannot create funds.

```sh
# BTC_TREASURY_WIF holds the compressed WIF of the funding wallet
node --env-file=.env btc-refill.mjs --to bc1q... --amount 0.0005 \
  --threshold 0.001 --max-per-refill 0.0006 --total-budget 0.0012
```

Add `--live` to broadcast, `--network testnet|regtest` to rehearse elsewhere,
`--api URL` for a mempool.space-compatible endpoint, and `--fee-rate SATVB` to pin
the fee (otherwise the half-hour rate is fetched).

Rails enforced before anything is signed:

- dry run unless `--live`; `--live` requires both caps
- refuses on cap or budget breach (budget counted once per txid from the audit log)
- refuses when confirmed UTXOs cannot cover the amount plus fee
- refuses an address for the wrong network, an uncompressed WIF, a WIF from
  another network, and a send to the treasury itself
- every input signature is verified locally, against the treasury's P2WPKH
  script, before the transaction is broadcast
- change below 546 sats is left to miners instead of creating a dust output

Fee is a static P2WPKH model (68 vB/input, 31 vB/output); the plan prints the
fee and approximate size, so check it before going live on mainnet. There is no
RBF or CPFP, and each run handles one target address.

`npm run rehearse:btc` drives the whole path against a fake mempool API on a
regtest-style network: real PSBT signing, an independent signature check by the
fake node, UTXO chaining through change, and cap/budget/insufficiency refusals.

## Send calldata on Sepolia (testnet only)

`sepolia-call.mjs` sends one transaction carrying an arbitrary `0x` payload to a
target on Sepolia (chain 11155111). It refuses every other chain, so it can only
spend testnet funds.

```sh
node --env-file=.env sepolia-call.mjs --to 0xCONTRACT --data 0xdeadbeef \
  --value 0.001 --max-per-refill 0.01 --total-budget 0.05
```

Dry run by default; `--live` requires both caps. Rails enforced before signing:

- RPC must report chain 11155111, otherwise the run is refused (exit 3)
- `--max-per-refill` caps value + worst-case gas for the transaction
- `--total-budget` caps value + recorded fees already spent on Sepolia, read from
  `sepolia-call-audit.jsonl` (separate from the refill audit, so the weekly and
  monthly reports never count contract calls as refills)
- calldata must be whole bytes and at most 8192 bytes; the zero address and the
  treasury's own address are refused
- `--data-file PATH` reads the payload from a file instead of the command line,
  for hosts that refuse to spawn a process whose arguments carry a long hex
  string; the same format and size limits apply
- gas is estimated with the payload; if that fails, pass a reviewed `--gas-limit`
- the payload is audited as a keccak256 hash plus byte length, never raw bytes,
  and the confirmed line records the gas fee from the receipt
- the key comes from `TREASURY_PRIVATE_KEY` and is never printed or audited

`npm run test:sepolia-call` drives it against a local Ganache node pinned to
chain 11155111: dry run, both caps, the wrong-chain refusal, calldata limits, and
a real signed transaction whose calldata is verified on chain.

## Publish a treasury status page

`status-page.mjs` writes one self-contained HTML file - the only thing in this
project that is meant for a public web host. It reads the refill audit log and,
if you name wallets, their public balances, and publishes a static snapshot:
balances, all-time spend against your budget, refills in the last 24 hours, and
the eight most recent transactions.

```sh
node status-page.mjs --evm 1:0xTREASURY --btc mainnet:bc1q... \
  --budget-eth 0.05 --budget-btc 0.001 --out site/index.html
```

- no keys are read: balances come from public endpoints, the rest from
  `refill-audit.jsonl`
- the page is static - no JavaScript, no external assets, no RPC calls from the
  browser; re-run the script and re-upload to refresh it
- before writing, the HTML is scanned for a private key, WIF, xpub, PEM block or
  Slack webhook URL, and every 32-byte hex value must be a transaction id that is
  already in the audit log; anything else exits 3 and writes nothing
- `site/` is git-ignored, so a snapshot is never committed by accident
- the page carries `noindex, nofollow` so search engines leave it alone

Upload only the generated `site/index.html`. Never upload `.env`, the audit log,
the wallet bundle or `.git`. On x10hosting, open cPanel -> File Manager, enter
`public_html`, and upload `index.html` (or use the FTP account from the panel);
the page is then served at your account's subdomain. Fetch it once in a browser
to confirm it renders before sharing the URL.

`npm run test:status` drives the exporter against a fake RPC, a fake mempool API
and a temp audit log, including the refusal cases.

### Upload it over SFTP

`upload.mjs` sends that one file to the host. Host, username and password come
from `.env.upload` (git-ignored, copied from `.env.upload.example`); nothing is
passed on the command line and the password is never printed.

```sh
cp .env.upload.example .env.upload   # then fill in SFTP_HOST / USER / PASSWORD
node upload.mjs                      # dry run: connects, reports, uploads nothing
node upload.mjs --live               # uploads site/index.html
```

- dry run is the default; it connects, stats the remote directory, and prints
the local size and sha256 plus whether the remote file would be created or
overwritten
- exactly one file is ever transferred, always `site/index.html`, and only if it
looks like the generated page - no `<script>`, valid HTML, at most 1 MiB
- `--remote-dir` must stay relative (no `..`, no absolute paths) and must
already exist; the uploader will not create directories
- a size mismatch after the write is an error, not a silent success
- `--verify URL` fetches the page back over HTTP after a live upload and fails
  unless it answers 200, serves `text/html`, is byte-for-byte the uploaded size,
  and carries the same `<title>`; a stale cached copy is retried once with a
  cache-busting query before it counts as a failure
- `SFTP_PUBLIC_URL` in `.env.upload` sets that URL once, so the weekly publish
  verifies itself without passing a flag
- the password is scrubbed from every message, including connection errors

Exit codes: 0 ok, 1 usage or config error, 2 connection or upload failure,
3 refused.

`npm run test:upload` runs an in-process SFTP server and checks the whole path:
config parsing, dry run writing nothing, a real upload whose bytes match, the
authentication failure, and the path refusals.

### Refresh and re-upload after the weekly roll-up

`publish-status.mjs` regenerates the page and hands it to `upload.mjs`, so the
published snapshot follows the weekly report instead of drifting. `run-weekly.cmd`
calls it with `--live` after the roll-up, so Monday's task also refreshes the page:

- balances come from the public addresses in `summary-wallets.txt`, the same list
  the daily summary uses; with no addresses the page still refreshes with
  activity only
- publishing is opt-in: with no `.env.upload` the page is refreshed locally,
  nothing is uploaded, and the task still exits 0
- a publish failure after a successful roll-up turns the task red, so a broken
  SFTP login is noticed rather than silently serving a stale page
- `node publish-status.mjs` on its own is a dry run: page regenerated locally,
  upload only reports what it would send

`npm run test:publish` checks the orchestration: the refreshed page, the clean
skip without an upload config, the malformed and rejected wallet lines, and an
upload that cannot connect.

## Slack alerts

Both refill tools post to a Slack incoming webhook when a safety rule refuses a
refill, or when the treasury falls below a floor you set. Create the webhook in
Slack (Apps -> Incoming Webhooks) and put it in `.env`:

```sh
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
MIN_TREASURY_ETH=0.01       # optional floor for refill.mjs
MIN_TREASURY_BTC=0.0005     # optional floor for btc-refill.mjs
ALERT_COOLDOWN_SECONDS=900  # identical alerts dedupe for this long
```

Per-run equivalents: `--min-treasury` and `--alert-cooldown`.

- No webhook set means alerts are disabled and the tools behave exactly as before.
- Alert text carries the chain, reason, target, treasury address and mode, and
  never a key, WIF, or RPC URL. The webhook URL is treated as a secret too.
- A refusal names the rule that fired - per-refill cap, total spend budget or
  treasury balance - and states its numbers: the limit, what was already spent,
  what this refill asked for, and the amount over the limit (or short of the
  treasury balance). The same line is written to the run log. Example:

    ```
    :rotating_light: *refill refused (high)* - Ethereum (1)
    budget on Ethereum is spent - sent 0.02 ETH of 0.02 ETH, this refill needs 0.005 ETH
    limit 0.02 ETH | spent 0.02 ETH | remaining 0 ETH | requested 0.005 ETH | over by 0.005 ETH
    target 0xTARGET | treasury 0xTREASURY
    mode LIVE | severity high | rule budget (total spend budget)
    ```
- A failing or slow webhook is logged and ignored, so alerting can never block or
  fail a refill.
- Repeated identical alerts are suppressed for the cooldown window, which keeps a
  `--watch` loop from spamming the channel.

### Routing alerts to separate channels

A Slack incoming webhook belongs to one channel, so sending severities to
different channels means different webhook URLs:

| Alert | Severity | Env var |
| --- | --- | --- |
| Safety-rule refusal | high, `:rotating_light:` | `SLACK_ALERT_WEBHOOK_URL` |
| Treasury below floor | medium, `:warning:` | `SLACK_WARNING_WEBHOOK_URL` |
| Refill sent, daily summary | info, `:white_check_mark:` / `:bank:` | `SLACK_WEBHOOK_URL` |

Routing follows the alert key (`refused:*` to the alert channel, `low:*` to the
warning channel, everything else to the default), so no call site can bypass it.
An unset dedicated URL falls back to `SLACK_WEBHOOK_URL`; with none of the three
set, alerting is disabled.
Each URL can also come from a file: set `SLACK_WEBHOOK_FILE`,
`SLACK_ALERT_WEBHOOK_FILE` or `SLACK_WARNING_WEBHOOK_FILE` to a path holding just
the URL, and the tool reads it at run time (a `*_FILE` value wins over the
inline URL), so the secret can live outside the project. An unreadable or empty
file fails before anything is sent, and the error names the path, never the URL. Start-up logs the resolved routing using channel names
only, never URLs. Refusal and low-treasury messages also carry an explicit
`severity high` / `severity medium` line, so filters and searches still work if
you keep everything in one channel.

Successful refills also post a short `:white_check_mark:` message with the tx hash,
so the channel shows activity as well as problems.

### Daily treasury summary

`treasury-summary.mjs` prints, and with `--post` sends, a read-only daily summary:
balances for the wallets you list plus refills recorded in the audit log over the
last 24 hours. It needs no private key and signs nothing.

```sh
node --env-file=.env treasury-summary.mjs \
  --evm 1:0xTREASURY --evm 8453:0xTREASURY --btc mainnet:bc1q... --post
```

Schedule it once a day (cron `15 8 * * *`, or Windows Task Scheduler). `--state`
records the last posted date, so a second run the same day is skipped unless
`--force` is passed; a failed post leaves the state untouched so the next run
retries. With no webhook configured it logs a skip once per day and exits 0, and
an empty `summary-wallets.txt` is a once-per-day skip at the wrapper level. On Windows the registered task fires three times a day (08:15, 11:15,
14:15) for exactly that reason: the morning run is the real one and the later
triggers are retries that do nothing once the day's post has succeeded.
`--evm-rpc` / `--btc-api` point it at your own endpoints.

On Windows, `run-summary.cmd` is the scheduler entry point: it reads public
addresses from `summary-wallets.txt` (one `--evm CHAIN:ADDRESS` or
`--btc NETWORK:ADDRESS` pair per line, `#` comments allowed), runs the summary
with `--post`, appends output to
`treasury-summary.log`, and returns node's exit code. Register or refresh it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\register-summary.ps1
```

That creates one task with three daily triggers (08:15, 11:15, 14:15) and
`StartWhenAvailable`, so a failed or missed morning post is retried a few hours
later instead of skipping the day. Both config files are git-ignored, andthe task runs only while you are logged on.

### Weekly roll-up

`treasury-weekly.mjs` totals the refills in one ISO calendar week (Monday to
Sunday, UTC) and compares them with the week before, per chain and network:
refill count, spend, recorded fees, daily average, the largest single refill and
the change against the previous week. It reads
only `refill-audit.jsonl`, so it needs no key, RPC or wallet list and still works
when a chain is unreachable.

```sh
node --env-file=.env treasury-weekly.mjs --post
```

`--week YYYY-Www` picks the ISO week (Monday to Sunday, UTC); with no `--week`
it reports the previous week by local date, so the window is the same whichever
day the run happens. `--audit PATH` points at another log, and `--state` records
the posted week so a retry for the same week skips unless `--force` is passed; a
failed post leaves it untouched so the next run retries. With no webhook
configured it logs a skip once per ISO week and exits 0.

On Windows, `run-weekly.cmd` posts it and logs to `treasury-weekly.log`;
`register-weekly.ps1` registers the Monday task with three triggers (08:30,
12:30, 15:30). The morning run is the real one; the lunchtime and afternoon runs
only act if it failed, because `--state` still records the posted window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\register-weekly.ps1
```

### Monthly roll-up

`treasury-monthly.mjs` summarises one calendar month per chain and network:
refill count, total spend, recorded fees, average refill size and the largest
single refill with its transaction reference, plus a year-to-date block with
cumulative refills, spend and recorded fees per chain since 1 January. Like the
weekly roll-up it reads only the audit log, so it needs no key, RPC or wallet
list. `--webhook-file PATH` posts through a webhook stored in that file, which
wins over `.env` and needs no environment change. The wrapper takes the same path
as its first argument (`run-monthly.cmd C:\path\webhook.txt`), and
`register-monthly.ps1 -WebhookFile C:\path\webhook.txt` passes it to the task.
The weekly and daily wrappers accept the same optional argument. With `--post`
and no webhook configured at all, the monthly run logs that skip once per month
and exits 0, so a scheduled run does not report a failure and the retries stay
quiet; a configured but unreadable file is still an error (exit 2).

```sh
node --env-file=.env treasury-monthly.mjs --post
```

`--month YYYY-MM` picks the calendar month (whole month, UTC). With no
`--month`, it reports the previous month by local date, which is what the
1st-of-month task should post. `--state` records the posted month so a retry for
the same month skips unless `--force` is passed, and a failed post leaves it
untouched so the next run retries.

On Windows, `run-monthly.cmd` posts it and logs to `treasury-monthly.log`;
`register-monthly.ps1` registers the 1st-of-month task with 09:00, 13:00 and
16:00 triggers (the later two are retries that exit immediately once the window
has posted):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\register-monthly.ps1
```

## Tests

`npm test` runs every suite and both rehearsals in order, stopping at the first
failure (about 2.5 minutes, mostly the summary and the EVM rehearsal):

```sh
npm test
```

The chain is:

- `npm run test:notify` - notifier against a fake webhook
- `npm run test:summary` - summary against a fake JSON-RPC node, mempool API and webhook
- `npm run test:weekly` - ISO-week roll-up: totals, fees, trend, largest refill, skip and guard
- `npm run test:monthly` - calendar-month and YTD roll-ups, fees, skip and guard
- `npm run test:wallet` - BIP-39/84 derivation, xpub/tpub watch-only, key refusals
- `npm run test:sepolia-call` - Sepolia calldata sender: dry run, caps, wrong-chain refusal, live send
- `npm run rehearse` - EVM refill on a local Ganache chain with fake funds
- `npm run rehearse:btc` - PSBT signing, independent signature check and refusals on a regtest-style network
- `npm run verify:tree` - clone HEAD into a temp directory, `npm ci` from the committed
  lockfile and run the whole suite there, so ignored files and uncommitted edits cannot
  influence the result; `--strict` refuses to run on a dirty tree and `--keep` leaves the
  checkout behind

Every script exits non-zero on failure and ends with a `... TESTS PASSED` or
`... REHEARSAL PASSED` banner. No real network, funds, webhook or `.env` secret is
used: the suites start loopback servers and use temporary state files, and read
only their own fixtures rather than the live audit log.

## Verifying before a push

`hooks/pre-push` runs `npm run verify:tree -- --strict`, so a push cannot leave
this machine from a dirty tree or from a commit that fails the suite. Note the
`--`: without it npm treats `--strict` as its own flag and the verifier runs
without it. Enable the hook once per clone:

```sh
chmod +x hooks/pre-push
git config core.hooksPath hooks
```

Bypass a single push with `git push --no-verify`. Expect several minutes: the
check clones the repository, installs from the committed lockfile and runs the
full suite inside the clone.

## Handling the secret

- The seed phrase *is* the wallet: anyone who reads it can spend the funds.
- `--show-key` prints a WIF key in plain text; only use it to import into
  software that asks for one, then destroy the output.
- Generated on a networked desktop means the secret passed through that machine.
  For real balances, generate on an offline machine or a hardware wallet.
- There is no recovery service. Lose the phrase, lose the coins.
