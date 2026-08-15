/**
 * Development seed: one test user and a couple of illustrative orders.
 *
 *   pnpm --filter @soe/database seed
 *
 * Never run against a production Neon branch.
 */
async function main(): Promise<void> {
  // TODO(impl): upsert a demo user; insert a PENDING
  //             "SELL 0.01 WETH when ETH/USD <= 3500" order with a placeholder
  //             signature so the UI has something to render.
  throw new Error('TODO: implement seed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
