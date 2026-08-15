/**
 * Serialized nonce allocation for the executor EOA — NOT YET IMPLEMENTED.
 *
 * Nonces are allocated strictly in order behind a Redis mutex. A gap or a stuck
 * transaction blocks the queue by design: with one signer, proceeding past a
 * stuck nonce cannot work.
 */
export {};
