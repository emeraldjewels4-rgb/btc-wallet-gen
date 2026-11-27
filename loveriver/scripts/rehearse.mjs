#!/usr/bin/env node
// Runs the whole distribution path once, end to end, on a throwaway local chain:
// fresh wallets, a real deploy, ten transfers, a resumed rerun and the on-chain
// audit. The point is that it can be run before any real run without a faucet, a
// funded key or a hand-typed command sequence.
//
// It touches nothing permanent: the treasury is a chain-local account, the
// wallets live in wallets/rehearse-tmp/, and an existing deployments/97.json is
// put back afterwards. --keep leaves the wallet dir and the deployment record
// alone so a failure can be inspected.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ganache adds a close listener per request and its fallback WebSocket build
// warns loudly on start; neither means anything for a short dev run.
EventEmitter.defaultMaxListeners = 64;
const { warn } = console;
console.warn = (...args) => {
  const first = String(args[0] ?? '');
  if (first.includes('µWS') || first.includes('Falling back to a NodeJS implementation')) return;
  warn(...args);
};
const { default: ganache } = await import('ganache');
console.warn = warn;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const walletArg = 'wallets/rehearse-tmp';
const walletDir = join(root, walletArg);
const deploymentsDir = join(root, 'deployments');
const deploymentFile = join(deploymentsDir, '97.json');
const shown = (path) => path.slice(root.length + 1);

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Asynchronous on purpose: the chain runs inside this process, so a blocking
// spawn would starve it and every RPC call in the child would time out.
function step(title, args, env) {
  console.log(`\n=== ${title}`);
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      if (code === 0) done();
      else fail(new Error(`${title} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

// Everything the run is allowed to disturb, recorded before it starts.
const saved = {
  deployment: existsSync(deploymentFile) ? readFileSync(deploymentFile, 'utf8') : undefined,
  deploymentsDir: existsSync(deploymentsDir),
};
let server;
let failed = false;

function cleanup() {
  if (server) {
    try {
      server.close();
    } catch {
      // already stopped
    }
  }
  if (keep) {
    console.log(`\nkept ${walletArg} and ${shown(deploymentFile)} for inspection`);
    return;
  }
  rmSync(walletDir, { recursive: true, force: true });
  if (saved.deployment === undefined) rmSync(deploymentFile, { force: true });
  else writeFileSync(deploymentFile, saved.deployment);
  if (!saved.deploymentsDir && existsSync(deploymentsDir) && readdirSync(deploymentsDir).length === 0) {
    rmdirSync(deploymentsDir);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\nrehearsal interrupted (${signal})`);
    cleanup();
    process.exit(130);
  });
}

try {
  rmSync(walletDir, { recursive: true, force: true });
  mkdirSync(walletDir, { recursive: true });

  const port = await freePort();
  server = ganache.server({
    chain: { chainId: 97, hardfork: 'shanghai' },
    wallet: { totalAccounts: 10 },
    miner: { blockGasLimit: 30_000_000 },
    logging: { quiet: true },
  });
  await server.listen(port, '127.0.0.1');

  // A chain-local account as treasury: funded on start, no faucet, no real key.
  const [[treasury, account]] = Object.entries(server.provider.getInitialAccounts());
  const env = {
    ...process.env,
    BSC_RPC_URL: `http://127.0.0.1:${port}`,
    TREASURY_PRIVATE_KEY: account.secretKey,
  };
  // Deploy prefers this one, and it would point outside the rehearsal chain.
  delete env.DEPLOYER_PRIVATE_KEY;

  console.log(`rehearsal  local chain on 127.0.0.1:${port} (chain id 97, ganache)`);
  console.log(`treasury   ${treasury} (throwaway, ${account.balance} wei)`);
  console.log(`wallets    ${walletArg} (throwaway)`);
  console.log(`restores   ${shown(deploymentFile)} afterwards, so a real deployment record is untouched`);

  await step('generate the rehearsal wallet set', [
    'scripts/generate-wallets.mjs',
    '--rehearsal',
    '--out',
    walletArg,
  ], env);
  await step('deploy', ['scripts/deploy.mjs', '--chain', 'bsc-testnet', '--live'], env);
  await step('distribute', [
    'scripts/distribute.mjs',
    '--chain',
    'bsc-testnet',
    '--wallets',
    walletArg,
    '--rehearsal',
    '--live',
  ], env);
  await step('distribute again, which must send nothing', [
    'scripts/distribute.mjs',
    '--chain',
    'bsc-testnet',
    '--wallets',
    walletArg,
    '--rehearsal',
    '--live',
  ], env);
  await step('audit', ['scripts/audit.mjs', '--chain', 'bsc-testnet', '--wallets', walletArg], env);
} catch (error) {
  failed = true;
  console.error(`\nrehearsal failed: ${error.message}`);
} finally {
  cleanup();
}

if (failed) process.exit(1);
console.log('\nrehearsal passed: deploy, ten transfers, a resume that sent nothing, and an audit that matched.');
