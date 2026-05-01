// Polyfill Web Crypto API for Node 18, where 'crypto' is not automatically
// exposed as a bare global in Vitest's worker context (it is in Node 20).
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
