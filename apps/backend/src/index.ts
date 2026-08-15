/**
 * API process entrypoint.
 *
 * This process is deliberately read-mostly with respect to the chain: it
 * quotes, reads and stores, but it NEVER submits transactions and never loads
 * EXECUTOR_PRIVATE_KEY. All signing lives in apps/worker.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  // TODO(impl): validate env (config/env.ts), build the express app, start
  //             listening on API_PORT, wire graceful shutdown on SIGTERM.
  throw new Error('TODO: implement API bootstrap');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
