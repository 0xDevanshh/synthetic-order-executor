/**
 * Worker process entrypoint — the execution engine.
 *
 * This is the ONLY process that holds EXECUTOR_PRIVATE_KEY and the only one
 * that submits transactions. It is deployed separately from the API so the
 * signing key is never resident in a process with a public HTTP surface.
 *
 * Registers all five workers. They can be split across processes later by
 * gating on an env flag; the queue names are the contract between them.
 *
 * Shutdown must be graceful: on SIGTERM stop accepting jobs, let an in-flight
 * execute-order job finish, and only then close. Killing a worker mid-broadcast
 * is the one thing that creates genuinely ambiguous state.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  // TODO(impl): validate env, connect Redis, register the five workers and the
  //             repeatable schedulers, install SIGTERM/SIGINT handlers.
  throw new Error('TODO: implement worker bootstrap');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
