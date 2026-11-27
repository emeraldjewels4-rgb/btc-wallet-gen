#!/usr/bin/env node
// Runs the whole distribution path once, end to end, on a throwaway local chain:
// fresh wallets, a real deploy, ten transfers, a resumed rerun and the on-chain
// audit. The point is that it can be run before any real run without a faucet, a
// funded key or a hand-typed command sequence.
//
// The audit runs twice: once with a multicall3 contract at the canonical
// address, which is the path BSC itself takes, and once without it, which is the
// fallback a private node or a dev chain gets. A bare ganache only has the
// second, and covering just that would rehearse the branch the real run never
// uses.
//
// It touches nothing permanent: the treasury is a chain-local account, the
// wallets live in wallets/rehearse-tmp/, and an existing deployments/97.json is
// put back afterwards. --keep leaves the wallet dir and the deployment record
// alone so a failure can be inspected.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import solc from 'solc';
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
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const walletArg = 'wallets/rehearse-tmp';
const walletDir = join(root, walletArg);
const deploymentsDir = join(root, 'deployments');
const deploymentFile = join(deploymentsDir, '97.json');
const shown = (path) => path.slice(root.length + 1);

// Just enough of multicall3 for viem's multicall: aggregate3 with per-call
// allowFailure. Real BSC has the full deployment at this address; the audit only
// asks for aggregate3, so a faithful stub is what puts the rehearsal on the path
// a real run takes (one RPC call for the whole batch).
const MULTICALL3_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Multicall3 {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory data) = calls[i].target.call(calls[i].callData);
            if (!ok && !calls[i].allowFailure) revert();
            results[i] = Result(ok, data);
        }
    }
}
`;

function multicall3Runtime() {
  const input = {
    language: 'Solidity',
    sources: { 'Multicall3.sol': { content: MULTICALL3_SOURCE } },
    settings: {
      // Same target as the token: the chain here runs shanghai, and a cancun
      // build would use PUSH0 and fail every call.
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((error) => error.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`multicall3 stub does not compile: ${errors[0].formattedMessage.trim()}`);
  }
  return `0x${output.contracts['Multicall3.sol'].Multicall3.evm.deployedBytecode.object}`;
}

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

  // BSC has multicall3; a bare local chain does not. Install it first so the
  // audit takes the same route it will take on the real run.
  const runtime = multicall3Runtime();
  await server.provider.request({ method: 'evm_setAccountCode', params: [MULTICALL3, runtime] });
  const installed = await server.provider.request({ method: 'eth_getCode', params: [MULTICALL3, 'latest'] });
  if (!installed || installed === '0x') throw new Error('could not install the multicall3 stub');
  console.log(`multicall3 ${MULTICALL3} (stub, ${(runtime.length / 2 - 1)} bytes)`);

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
  await step('audit, with multicall3 (the path BSC takes)', [
    'scripts/audit.mjs',
    '--chain',
    'bsc-testnet',
    '--wallets',
    walletArg,
  ], env);

  // Then take it away and prove the fallback still confirms the same result.
  await server.provider.request({ method: 'evm_setAccountCode', params: [MULTICALL3, '0x'] });
  await step('audit again, without multicall3 (the fallback)', [
    'scripts/audit.mjs',
    '--chain',
    'bsc-testnet',
    '--wallets',
    walletArg,
  ], env);
} catch (error) {
  failed = true;
  console.error(`\nrehearsal failed: ${error.message}`);
} finally {
  cleanup();
}

if (failed) process.exit(1);
console.log(
  '\nrehearsal passed: deploy, ten transfers, a resume that sent nothing, and two audits that matched - one through multicall3 and one through individual balanceOf calls.',
);
