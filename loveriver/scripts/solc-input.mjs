// One definition of the compiler input, used by both the build and the
// BscScan verification file. If these drift, verification fails on a bytecode
// mismatch, so they must be generated from the same place.
import solc from 'solc';

export const COMPILER_VERSION = `v${solc.version().replace(/\+commit\.([0-9a-f]+).*$/, '+commit.$1')}`;
export const EVM_VERSION = 'paris';
export const OPTIMIZER_RUNS = 200;

export function solcInput(source) {
  return {
    language: 'Solidity',
    sources: { 'contracts/LoverRiver.sol': { content: source } },
    settings: {
      // paris: no PUSH0/MCOPY, so the token runs on every BSC-compatible fork.
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
      },
    },
  };
}
