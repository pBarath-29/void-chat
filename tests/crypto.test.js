// Node 18+ ships globalThis.crypto with SubtleCrypto — no browser needed.
import { describe, it, expect } from 'vitest';
import { bufToBase64url, base64urlToBuf, computeFingerprint, deriveSharedKey } from '../public/crypto.js';

// ─── Encoding round-trips ─────────────────────────────────────────────────────

describe('bufToBase64url / base64urlToBuf', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 42, 99]);
    const encoded = bufToBase64url(original);
    const decoded = base64urlToBuf(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('produces URL-safe characters only (no +, /, or =)', () => {
    const buf = new Uint8Array(64).fill(0xff);
    const encoded = bufToBase64url(buf);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('round-trips a 12-byte IV', () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    expect(Array.from(base64urlToBuf(bufToBase64url(iv)))).toEqual(Array.from(iv));
  });
});

// ─── Full E2EE round-trip ─────────────────────────────────────────────────────

describe('E2EE round-trip', () => {
  async function generateKeyPair() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }

  it('two peers derive the same AES key and can encrypt/decrypt', async () => {
    const pairA = await generateKeyPair();
    const pairB = await generateKeyPair();

    // Each peer imports the other's public key
    const pubAexported = await crypto.subtle.exportKey('spki', pairA.publicKey);
    const pubBexported = await crypto.subtle.exportKey('spki', pairB.publicKey);

    const pubAimported = await crypto.subtle.importKey('spki', pubAexported, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const pubBimported = await crypto.subtle.importKey('spki', pubBexported, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

    const roomSecret = 'test-room-secret';
    const keyA = await deriveSharedKey(pairA.privateKey, pubBimported, roomSecret);
    const keyB = await deriveSharedKey(pairB.privateKey, pubAimported, roomSecret);

    // Encrypt with A's derived key
    const plaintext = new TextEncoder().encode('hello, void');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, plaintext);

    // Decrypt with B's derived key — must succeed and match original plaintext
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, cipherBuf);
    const result = new TextDecoder().decode(decrypted);
    expect(result).toBe('hello, void');
  });

  it('different room secrets produce different keys (domain separation)', async () => {
    const pairA = await generateKeyPair();
    const pairB = await generateKeyPair();

    const pubBexported = await crypto.subtle.exportKey('spki', pairB.publicKey);
    const pubBimported = await crypto.subtle.importKey('spki', pubBexported, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

    const keySecret1 = await deriveSharedKey(pairA.privateKey, pubBimported, 'secret-1');
    const keySecret2 = await deriveSharedKey(pairA.privateKey, pubBimported, 'secret-2');

    // Encrypt with secret-1's key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, keySecret1,
      new TextEncoder().encode('test')
    );

    // Decrypt with secret-2's key must fail (authentication tag mismatch)
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keySecret2, cipherBuf)
    ).rejects.toThrow();
  });
});

// ─── Fingerprint determinism ──────────────────────────────────────────────────

describe('computeFingerprint', () => {
  async function generateJWK() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    return crypto.subtle.exportKey('jwk', pair.publicKey);
  }

  it('produces the same fingerprint regardless of peer order', async () => {
    const [jwkA, jwkB] = await Promise.all([generateJWK(), generateJWK()]);
    const fpAB = await computeFingerprint(jwkA, jwkB);
    const fpBA = await computeFingerprint(jwkB, jwkA);
    expect(fpAB).toBe(fpBA);
  });

  it('returns a 5-group hex string (4 chars × 5 groups)', async () => {
    const [jwkA, jwkB] = await Promise.all([generateJWK(), generateJWK()]);
    const fp = await computeFingerprint(jwkA, jwkB);
    // Expected format: "xxxx xxxx xxxx xxxx xxxx"
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
  });

  it('different key pairs produce different fingerprints', async () => {
    const [jwk1A, jwk1B] = await Promise.all([generateJWK(), generateJWK()]);
    const [jwk2A, jwk2B] = await Promise.all([generateJWK(), generateJWK()]);
    const fp1 = await computeFingerprint(jwk1A, jwk1B);
    const fp2 = await computeFingerprint(jwk2A, jwk2B);
    expect(fp1).not.toBe(fp2);
  });
});
