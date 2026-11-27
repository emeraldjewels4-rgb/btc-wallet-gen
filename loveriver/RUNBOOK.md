# loveriver go-live runbook

Taking `LOVER` (fixed supply **69,999,999,991**, 5 admins + 9,999 holders) from this repo to BNB Smart Chain. Testnet first, always — the contract has no owner, no mint and no rescue function, so a mistake on mainnet is permanent.

All commands run from `loveriver/`.

## 0. Prep once

```bash
cd loveriver
npm install
npm run build
```

**Check:** prints `compiled LoverRiver with solc 0.8.28…` and `runtime bytecode 1.4 KiB`.

Install the pre-push secret check once per clone. Hooks live outside the working tree (in the hooks directory git reports below), so this is opt-in and must be repeated after a fresh clone:

```bash
h=$(git rev-parse --git-path hooks) && cp scripts/pre-push "$h/pre-push" && chmod +x "$h/pre-push"
```

**Check:** `"$(git rev-parse --git-path hooks)/pre-push"` prints `clean: …` and exits 0. From then on every `git push` runs `npm run scan:secrets` first — it scans everything the push would publish for wallet CSVs, private keys and keystore JSON, and refuses the push (exit 1, naming the file) if any turns up.

CI runs the same scan on every push and pull request, but a red check only blocks a merge once it is required: under Settings → Branches → branch protection, require status checks `secrets` and `test` **and** "Require a pull request before merging" — required checks are only evaluated on pull requests, so without the second, pushes to the branch skip them. Hold `secrets` back until this branch has merged, because the job exists only here: a PR from a branch cut off `master` — the umask fix on `freebuff/wallet-test-umask`, say — can report `test` and nothing else, and would wait forever on a check it can never produce.

None of that is in force yet: `master` reports `protected: false`, so nothing is required on it and a push lands unchallenged — the rule is a plan, not a state. Check rather than assume, with `GET /repos/{owner}/{repo}/branches`, which returns a `protected` flag per branch and needs no token on a public repo, unlike the protection endpoint itself, which needs admin credentials to read or change.

`build/` is git-ignored, so **rebuild after every clone or dependency restore** — deploy and verification both read the artifact from there.

Encrypt the 10,004 keys at rest, before backing anything up:

```bash
npm run keystore -- encrypt
```

Type the passphrase twice (12+ characters, no echo). It writes one Web3 Secret Storage V3 keystore per address to `wallets/keystores/`, reads them back, and proves the passphrase opens the first and last wallet of each group. About 40 minutes at the default scrypt cost; `--n 131072` is stronger and slower, `--n 32768` faster.

The treasury key signs the deployment and then every transfer, so it is live for the whole distribution window — encrypt it too. This reads the plaintext key from `.env` and writes `wallets/treasury.keystore.json`:

```bash
npm run keystore -- encrypt-treasury
```

Then set `TREASURY_PRIVATE_KEY=wallets/treasury.keystore.json` in `.env` (or blank the line to use that path) and delete the plaintext key from it. Deploy and distribute prompt for the passphrase once per run and hold the key only in memory.

```bash
cp -r wallets/keystores /media/encrypted-offline-backup/
cp wallets/treasury.keystore.json /media/encrypted-offline-backup/
cp wallets/holders.json wallets/summary.json /media/encrypted-offline-backup/
chmod -R go-rwx /media/encrypted-offline-backup/keystores
```

**Check:** `find wallets/keystores -name '*.json' | wc -l` → 10,004 (5 admins, 9,999 holders). Keep the passphrase somewhere separate from that backup: without it the keystores are unreadable, with it the backup is the wallet set.

Before every push, run `npm run scan:secrets` — a clean result prints `clean: no wallet CSV, private key, keystore JSON, committed .env or seed phrase in anything a push would publish.` and exits 0.

Before deleting the fallback, prove every keystore is the wallet its filename claims — `encrypt` only spot-checks the first and last of each group:

```bash
npm run keystore -- verify
```

**Check:** `verified: 10004 keystores …` and exit 0. It prompts once and costs about as long as `encrypt` (~40 minutes), because it really does open every file. A keystore that does not decrypt, or that holds another wallet's key, is listed by filename and the command exits 1 — fix those before anything is deleted.

Once the backup opens, drop the plaintext CSVs — this only deletes them if every wallet has a keystore:

```bash
npm run keystore -- remove-plaintext
```

Distribution reads whichever form it finds and refuses to run if the keystore and CSV lists disagree. To spend a single wallet by hand:

```bash
npm run keystore -- decrypt --address 0x...   # writes wallets/0x....key, mode 0600
```

## 1. Deploy to testnet (Chapel, chain 97)

```bash
cp .env.example .env
```

Set in `.env`:

```
BSC_RPC_URL=https://bsc-testnet-dataseed.bnbchain.org
TREASURY_PRIVATE_KEY=0x…        # fund this address with tBNB
```

Get tBNB from the official faucet, <https://www.bnbchain.org/en/testnet-faucet>: 0.3 tBNB per address per 24h, and the address must hold ≥0.002 BNB on mainnet as an anti-bot check. If that's a problem, the QuickNode, Chainstack or Chainlink BSC faucets don't require it. One drip covers the whole rehearsal (deploy ≈0.001 tBNB, all 10,004 transfers ≈0.05 tBNB).

```bash
npm run deploy -- --chain bsc-testnet          # dry run
npm run deploy -- --chain bsc-testnet --live
```

**Check:**
- dry run shows the right `deployer`/`treasury` and `BNB Smart Chain Testnet (97)`
- live run prints `verified name=loveriver symbol=LOVER decimals=18 supply=69999999991000000000000000000`
- `deployments/97.json` exists
- <https://testnet.bscscan.com/token/ADDRESS> shows total supply 69,999,999,991 held by one address (token indexing can lag a minute)

## 2. Verify the source on testnet BscScan

```bash
npm run verify:input -- --chain bsc-testnet
```

**Check:** prints `compiler v0.8.28+commit.7893614a`, `contracts/LoverRiver.sol:LoverRiver`, and 64 hex characters of constructor args. This writes `build/standard-json-input.json` and `build/constructor-args.txt`; that input reproduces the deployed bytecode exactly.

In the explorer, open `https://testnet.bscscan.com/address/ADDRESS#code` → **Verify and Publish**:

| Field | Value |
|---|---|
| Compiler Type | Solidity (Standard-Json-Input) |
| Compiler Version | v0.8.28+commit.7893614a |
| License | MIT |
| Standard JSON Input | upload `build/standard-json-input.json` |
| Constructor Arguments | paste the contents of `build/constructor-args.txt` (no `0x`) |

**Check:** "Successfully generated ByteCode and ABI", the green **Exact Match** badge, and **Read Contract → name** returns `loveriver`.

API alternative — Etherscan V2, one key for all chains, but its chain list marks BNB (56 and 97) as paid-plan only; on the free tier use the UI:

```bash
ADDR=$(node -p 'require("./deployments/97.json").address')
curl -s "https://api.etherscan.io/v2/api?chainid=97" \
  -d module=contract -d action=verifysourcecode \
  -d apikey="$ETHERSCAN_API_KEY" \
  -d contractaddress="$ADDR" \
  -d "contractname=contracts/LoverRiver.sol:LoverRiver" \
  -d codeformat=solidity-standard-json-input \
  -d "compilerversion=v0.8.28+commit.7893614a" \
  -d licenseType=3 \
  --data-urlencode "constructorArguements@build/constructor-args.txt" \
  --data-urlencode "sourceCode@build/standard-json-input.json"
```

Poll with the returned `guid`:

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=97&module=contract&action=checkverifystatus&apikey=$ETHERSCAN_API_KEY&guid=GUID"
```

(`constructorArguements` is Etherscan's own spelling — keep the typo.)

## 3. Rehearse distribution on testnet

### 3a. One command, no testnet, no funding

```bash
npm run rehearse
```

That starts a throwaway chain in-process, deploys the real contract to it, sends the 10-wallet rehearsal set, reruns the distribution to prove it resumes without paying twice, and audits the result from the chain — about five seconds, no tBNB, no key, nothing left behind.

The audit runs **twice**, because there are two ways it reads balances. With a multicall3 contract at the canonical address it batches, which is what BSC does; with none it reads one `balanceOf` at a time, which is what a private node or a dev chain gets. A bare local chain only has the second, so the rehearsal installs a multicall3 stub at `0xcA11bde05977b3631167028862bE2a173976CA11` for the first pass and removes it for the second. Both must confirm the same balances.

**Check:** ends `rehearsal passed: deploy, ten transfers, a resume that sent nothing, and two audits that matched - one through multicall3 and one through individual balanceOf calls.` with exit 0, and above it:

- `=== audit, with multicall3 (the path BSC takes)` → `mode multicall3 at 0xca11…`, `read 10 balances in 1 RPC call(s)`, `paid 10/10`, `confirmed:`
- `=== audit again, without multicall3 (the fallback)` → `mode individual balanceOf calls (no multicall3 at 0xca11…)`, `read 10 balances in 10 RPC call(s)`, `paid 10/10`, `confirmed:`

It works in `wallets/rehearse-tmp/` with a chain-local treasury, restores an existing `deployments/97.json` (or removes the one it wrote), and deletes the temp wallets at the end. `npm run rehearse -- --keep` leaves both in place when something fails and you want to look. Run it after any change to the scripts and before a real distribution.

### 3b. The same path by hand, on real testnet

The run above proves the scripts; this one proves your `.env`, RPC, funded treasury and the explorer side. The real set is 10,004 transfers, too slow to repeat while you are still learning the script, so make a throwaway set of 2 admins + 8 holders in its own folder, with the real per-wallet amounts:

```bash
npm run wallets -- --rehearsal
```

**Check:** `10 wallets` and `total 58803988 / supply 69999999991 tokens (rehearsal set, the rest stays in the treasury)`.

Then run that set through the exact same commands. `--rehearsal` is what lets a set that does not add up to the supply through; without it the script still refuses:

```bash
npm run distribute -- --chain bsc-testnet --wallets wallets/rehearsal --rehearsal          # dry run
npm run distribute -- --chain bsc-testnet --wallets wallets/rehearsal --rehearsal --live
npm run distribute -- --chain bsc-testnet --wallets wallets/rehearsal --rehearsal --live   # again
```

**Check:**
- the dry run prints `mode rehearsal: this set pays 58803988000000000000000000 of …` and all 10 transfers, then `add --live to send.`
- the live run gets the treasury key (one passphrase prompt), and ends `done: 10 transfers this run, 10/10 recipients paid`
- the rerun prints `recipients 10 (10 already sent, 0 pending)` and ends `done: 0 transfers this run, 10/10 recipients paid`
- `npm run audit -- --chain bsc-testnet --wallets wallets/rehearsal` → `paid 10/10`, `unpaid`/`short`/`overpaid`/`unreadable` all 0, treasury holds the 69,999,999,991 − 58,803,988 remainder, exit 0

`--rehearsal` is refused with `--chain bsc`, so it can never be used on mainnet. The rehearsal set keeps its own state file in `wallets/rehearsal/`, so it does not touch the real run's progress. Delete `wallets/rehearsal/` once the real distribution is underway.

### 3c. The real set, at real scale

Admins are paid first, then holders in file order. Do the admin batch on its own so every later chunk is a clean 500 × 6,999,999:

```bash
npm run distribute -- --chain bsc-testnet --limit 5            # dry run
npm run distribute -- --chain bsc-testnet --limit 5 --live
npm run distribute -- --chain bsc-testnet --limit 50           # preview next 50
npm run distribute -- --chain bsc-testnet --limit 50 --live
```

**Check:**
- `node -e 'const fs=require("node:fs");const f=fs.readdirSync("wallets").find((n)=>n.startsWith("distribute-state.97-"));console.log(Object.keys(JSON.parse(fs.readFileSync("wallets/"+f)).sent).length)'` → 5, then 55
- treasury token balance fell by exactly 7,009,990 after the admins, then 50 transfers moved 349,999,950
- each new admin address holds 1,401,998 and each new holder 6,999,999 on the explorer
- treasury still has BNB for gas
- `npm run audit -- --chain bsc-testnet` reports `paid 55/10004` with `short`, `overpaid` and `unreadable` at 0 — the rest are unpaid because the rehearsal stops at 55, so it exits 1 by design

A full testnet run of all 10,004 wallets is optional — it costs ~0.05 tBNB and a couple of hours, and the small-set rehearsal above has already exercised the same code. If you want the real set on testnet too, drop `--wallets` and `--rehearsal` and run the same commands.

`wallets/distribute-state.<chainId>-<token>.json` records each transfer right after it confirms. The scope is in the name, so the testnet rehearsal cannot make the mainnet run read as already paid; keep the file, and rerunning the same command skips paid addresses and resumes at the next one.

## 4. Fund mainnet gas

10,004 transfers at ~51,000 gas each ≈ 510M gas; at BSC's ~0.05–0.1 gwei that is **0.03–0.05 BNB**, plus ~0.7M gas for the deploy. Send **0.15 BNB** to the treasury for headroom.

**Check:** `https://bscscan.com/address/TREASURY` shows the BNB balance before you deploy.

## 5. Deploy to mainnet

In `.env`, switch `BSC_RPC_URL` to a mainnet endpoint (`https://bsc-dataseed.binance.org` or your provider) and keep the same `TREASURY_PRIVATE_KEY`.

```bash
npm run deploy -- --chain bsc          # dry run
npm run deploy -- --chain bsc --live
```

**Check:** dry run says `BNB Smart Chain (56)` and the supply line is right — then confirm the live output shows the same read-back line, `deployments/56.json` exists, and the token page at `https://bscscan.com/token/ADDRESS` shows 69,999,999,991.

## 6. Verify the source on mainnet

```bash
npm run verify:input -- --chain bsc
```

Same Verify and Publish flow on `https://bscscan.com/address/ADDRESS#code`, same compiler version and the same two files.

**Check:** Exact Match, constructor decodes to your treasury, name is `loveriver`.

## 7. Distribute on mainnet, in chunks

```bash
npm run distribute -- --chain bsc --limit 5              # admins, preview
npm run distribute -- --chain bsc --limit 5 --live
npm run distribute -- --chain bsc --limit 500            # preview next 500 holders
npm run distribute -- --chain bsc --limit 500 --live
```

After each chunk of 500:

- state count rises by 500
- treasury token balance falls by exactly **3,499,999,500**
- one sampled holder has 6,999,999

Repeat until 10,004 recipients are paid, or drop `--limit` to run the remainder in one go — transfers are sequential and confirmed one at a time, so a full run takes a few hours.

## 8. Final state

Confirm it from the chain rather than from the distribution run's own log:

```bash
npm run audit -- --chain bsc
```

**Check:** `paid 10004/10004`, `unpaid`, `short`, `overpaid` and `unreadable` all 0, treasury 0 base units, and a last line starting `confirmed:` with exit 0. Any wallet that does not match is printed by address and the command exits 1; `--batch 500` is the multicall size, `--token` and `--treasury` override the deployment record.

The `mode` line says how it reads balances: `multicall3 at 0xcA11…` normally, or `individual balanceOf calls` on a node without multicall3 (a local dev chain, a private node) — same result, 10,004 calls instead of 21, so it takes minutes rather than seconds. A multicall that fails mid-run drops to individual calls for the rest of that run and says so.

- `totalSupply` = 69,999,999,991
- Holders tab = 10,004 addresses
- Treasury token balance = 0 (only BNB gas dust left)
- State file has 10,004 entries
- Spot-check three holders (6,999,999) and one admin (1,401,998)
- Source verified on BscScan

## If something goes wrong

- **Chunk stops mid-run:** read the printed reason, then rerun the identical command. Progress is saved per transfer, so nothing is paid twice.
- **Transaction stuck:** wait for it to confirm or replace it at the same nonce before rerunning; the script re-reads the nonce from `pending` at the start of each run.
- **Wrong balance arithmetic:** stop and compare the state file against the explorer before sending anything else.
- **Anything else on mainnet:** there is no owner, pause or rescue. Tokens already sent cannot be pulled back — this is why steps 1–3 exist.

After launch, retire the treasury key: it sat in `.env` on this machine, so treat it as hot and move any remaining BNB out.
