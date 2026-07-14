// E2EE primitives, built ONLY on Web Crypto (SubtleCrypto). No home-grown
// ciphers: HKDF-SHA256, ECDH (X25519 preferred, P-256 fallback), HMAC-SHA256,
// AES-256-GCM. Runs unchanged in any modern browser and in Node's webcrypto,
// so the same file is unit-tested under `node --test`.
//
// Trust model recap (see todos.md):
//   - room_secret (URL fragment) is the root of trust; never sent to server.
//   - auth_key derived from room_secret authenticates ALL signaling, so a
//     malicious/compromised relay cannot MITM the key or SDP exchange.
//   - an ephemeral ECDH handshake mixes in forward secrecy for chat content.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

// --- encoding helpers ---

export function randomBytes(len) {
  return globalThis.crypto.getRandomValues(new Uint8Array(len));
}

// URL-safe base64 without padding — suitable for room ids and the fragment.
export function toB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- room credentials ---
// room_id: 128-bit random (opaque room selector, seen by server).
// room_secret: 256-bit random (never leaves the browser; lives in the fragment).
export function generateRoomCredentials() {
  return {
    roomId: toB64url(randomBytes(16)),
    roomSecret: toB64url(randomBytes(32)),
  };
}

// --- HKDF-SHA256 ---
// Derive `len` bytes from input keying material, salted and labelled.
async function hkdf(ikmBytes, saltBytes, infoStr, len) {
  const ikm = await subtle.importKey('raw', ikmBytes, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: te.encode(infoStr) },
    ikm,
    len * 8
  );
  return new Uint8Array(bits);
}

// --- auth_key (from room_secret) ---
// Imported straight as an HMAC key; used to MAC every signaling message.
export async function deriveAuthKey(roomSecretBytes) {
  const raw = await hkdf(
    roomSecretBytes,
    new Uint8Array(0),
    'whispr/auth/v1',
    32
  );
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// --- HMAC over signaling ---
export async function macSign(authKey, dataBytes) {
  const sig = await subtle.sign('HMAC', authKey, dataBytes);
  return new Uint8Array(sig);
}

export async function macVerify(authKey, dataBytes, macBytes) {
  return subtle.verify('HMAC', authKey, macBytes, dataBytes);
}

// --- ephemeral ECDH handshake ---
// Prefer X25519; fall back to P-256 ECDH where X25519 is unavailable so the
// handshake works on ANY browser. Both peers must land on the same alg — they
// advertise it alongside the public key and we only proceed when they match.
export async function preferredEcdhAlg() {
  try {
    await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return 'X25519';
  } catch {
    return 'P-256';
  }
}

function ecdhParams(alg) {
  return alg === 'X25519'
    ? { name: 'X25519' }
    : { name: 'ECDH', namedCurve: 'P-256' };
}

export async function generateEphemeralKeyPair(alg) {
  const kp = await subtle.generateKey(ecdhParams(alg), false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { alg, privateKey: kp.privateKey, publicKeyRaw: pub };
}

// Compute the shared master secret and derive the chat root key from it.
// Salting HKDF with room_secret binds the session to the fragment: even a
// peer who somehow injected a public key gains nothing without room_secret.
export async function deriveMaster(privateKey, theirPublicRaw, alg, roomSecretBytes) {
  const theirPub = await subtle.importKey(
    'raw',
    theirPublicRaw,
    ecdhParams(alg),
    false,
    []
  );
  const bits = alg === 'X25519' ? 256 : 256; // both yield a 32-byte secret
  const shared = new Uint8Array(
    await subtle.deriveBits(
      alg === 'X25519'
        ? { name: 'X25519', public: theirPub }
        : { name: 'ECDH', public: theirPub },
      privateKey,
      bits
    )
  );
  // Chat root key material (bytes) — split into per-direction chains next.
  return hkdf(shared, roomSecretBytes, 'whispr/master/v1', 32);
}

// --- symmetric ratchet (forward secrecy within a session) ---
// One chain per direction so the two peers never collide on a key/nonce.
// Seed each chain from the shared master with a direction label; each step
// derives a one-time message key and advances the chain, so capturing the
// current chain key cannot decrypt earlier messages.
export async function initChain(masterBytes, label) {
  return hkdf(masterBytes, new Uint8Array(0), `whispr/chain/${label}`, 32);
}

export async function ratchetStep(chainKeyBytes) {
  const messageKeyRaw = await hkdf(
    chainKeyBytes,
    new Uint8Array(0),
    'whispr/msgkey/v1',
    32
  );
  const nextChainKey = await hkdf(
    chainKeyBytes,
    new Uint8Array(0),
    'whispr/chainstep/v1',
    32
  );
  const messageKey = await subtle.importKey(
    'raw',
    messageKeyRaw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return { messageKey, nextChainKey };
}

// --- AES-256-GCM ---
export async function aesEncrypt(key, plaintextBytes) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes)
  );
  return { iv, ct };
}

export async function aesDecrypt(key, ivBytes, ctBytes) {
  // Throws (OperationError) on any tamper — GCM tag verification failing is
  // the caller's signal to drop the message.
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return new Uint8Array(pt);
}

// --- text convenience ---
export const encodeUtf8 = (s) => te.encode(s);
export const decodeUtf8 = (b) => td.decode(b);
