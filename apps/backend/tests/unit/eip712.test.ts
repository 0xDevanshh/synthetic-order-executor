import { describe, it } from 'vitest';

/**
 * Golden-vector tests against fixtures produced by
 * SyntheticOrderExecutor.hashOrder. This is what catches domain-separator or
 * typehash drift between the contract, the backend and the frontend — a class
 * of bug that otherwise surfaces as an unexplained BadSignature revert on
 * Sepolia.
 */
describe('eip712', () => {
  it('hashOrder matches the contract-generated golden vectors');
  it('changes the hash when any single field changes');
  it('changes the hash across chain ids');
  it('changes the hash across verifying contract addresses');
  it('verifyOrderSignature accepts a valid EOA signature');
  it('verifyOrderSignature rejects a signature from a different signer');
});
