/**
 * Copy compiled ABIs into packages/shared/src/abi so the TypeScript side can
 * never drift from the compiled contract.
 *
 *   pnpm abi:sync
 */
async function main(): Promise<void> {
  // TODO(impl): read artifacts/src/SyntheticOrderExecutor.sol/SyntheticOrderExecutor.json,
  //             write packages/shared/src/abi/syntheticOrderExecutor.ts as
  //             `export const syntheticOrderExecutorAbi = [...] as const;`
  //             (`as const` is what gives viem full type inference).
  throw new Error('TODO: implement ABI export');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
