/* E2EE utility functions — loaded before room.js in the browser.
   Exported via module.exports for Node.js (test) environments. */

function bufToBase64url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1024)
    bin += String.fromCharCode(...u8.subarray(i, i + 1024));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBuf(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Both ownJWK and peerJWK are ECDH P-256 JWK objects.
// Result is order-independent: both peers produce the same fingerprint.
async function computeFingerprint(ownJWK, peerJWK) {
  const parts = [ownJWK.x + ownJWK.y, peerJWK.x + peerJWK.y].sort();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20).match(/.{1,4}/g).join(' ');
}

// Derives a 256-bit AES-GCM key from an ECDH key exchange + HKDF.
// The roomSecret is used as the HKDF info parameter, binding the
// derived key to this specific room (two rooms can't cross-decrypt).
// Requires privateKey to have 'deriveBits' usage.
async function deriveSharedKey(privateKey, peerPublicKey, roomSecret) {
  const rawBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey }, privateKey, 256
  );
  const hkdfBase = await crypto.subtle.importKey('raw', rawBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32),
      info: new TextEncoder().encode(roomSecret) },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Allow require() in Node.js test environments (Node 18+ ships SubtleCrypto)
if (typeof module !== 'undefined') {
  module.exports = { bufToBase64url, base64urlToBuf, computeFingerprint, deriveSharedKey };
}
