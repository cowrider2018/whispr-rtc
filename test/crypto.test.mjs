// Unit tests for the E2EE primitives. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRoomCredentials,
  fromB64url,
  deriveAuthKey,
  macSign,
  macVerify,
  preferredEcdhAlg,
  generateEphemeralKeyPair,
  deriveMaster,
  initChain,
  ratchetStep,
  aesEncrypt,
  aesDecrypt,
  encodeUtf8,
  decodeUtf8,
} from '../public/js/crypto.mjs';

test('room credentials: 128-bit id, 256-bit secret, random', () => {
  const a = generateRoomCredentials();
  const b = generateRoomCredentials();
  assert.equal(fromB64url(a.roomId).length, 16);
  assert.equal(fromB64url(a.roomSecret).length, 32);
  assert.notEqual(a.roomSecret, b.roomSecret); // not reused
});

test('signaling MAC: valid passes, tamper fails, wrong secret fails', async () => {
  const secret = fromB64url(generateRoomCredentials().roomSecret);
  const authKey = await deriveAuthKey(secret);
  const msg = encodeUtf8(JSON.stringify({ sdp: 'v=0...', fingerprint: 'AA:BB' }));

  const mac = await macSign(authKey, msg);
  assert.equal(await macVerify(authKey, msg, mac), true);

  const tampered = encodeUtf8(JSON.stringify({ sdp: 'v=0...', fingerprint: 'EVIL' }));
  assert.equal(await macVerify(authKey, tampered, mac), false);

  // A relay that does not know room_secret derives a different auth_key and
  // cannot produce a MAC our client will accept — this is the anti-MITM core.
  const attackerKey = await deriveAuthKey(fromB64url(generateRoomCredentials().roomSecret));
  const forged = await macSign(attackerKey, tampered);
  assert.equal(await macVerify(authKey, tampered, forged), false);
});

test('ECDH handshake: both peers derive the same master (with room_secret mix)', async () => {
  const secret = fromB64url(generateRoomCredentials().roomSecret);
  const alg = await preferredEcdhAlg();

  const alice = await generateEphemeralKeyPair(alg);
  const bob = await generateEphemeralKeyPair(alg);

  const mAlice = await deriveMaster(alice.privateKey, bob.publicKeyRaw, alg, secret);
  const mBob = await deriveMaster(bob.privateKey, alice.publicKeyRaw, alg, secret);

  assert.deepEqual(mAlice, mBob);
  assert.equal(mAlice.length, 32);
});

test('ECDH handshake: P-256 fallback path also agrees', async () => {
  const secret = fromB64url(generateRoomCredentials().roomSecret);
  const alice = await generateEphemeralKeyPair('P-256');
  const bob = await generateEphemeralKeyPair('P-256');
  const mAlice = await deriveMaster(alice.privateKey, bob.publicKeyRaw, 'P-256', secret);
  const mBob = await deriveMaster(bob.privateKey, alice.publicKeyRaw, 'P-256', secret);
  assert.deepEqual(mAlice, mBob);
});

test('different room_secret => different master (fragment binds the session)', async () => {
  const alice = await generateEphemeralKeyPair('P-256');
  const bob = await generateEphemeralKeyPair('P-256');
  const s1 = fromB64url(generateRoomCredentials().roomSecret);
  const s2 = fromB64url(generateRoomCredentials().roomSecret);
  const m1 = await deriveMaster(alice.privateKey, bob.publicKeyRaw, 'P-256', s1);
  const m2 = await deriveMaster(alice.privateKey, bob.publicKeyRaw, 'P-256', s2);
  assert.notDeepEqual(m1, m2);
});

test('chat E2EE: roundtrip across the ratchet, both directions', async () => {
  const master = await initChain(fromB64url(generateRoomCredentials().roomSecret), 'x');
  // Alice sends on chain "a2b"; Bob receives on the same labelled chain.
  let aliceSend = await initChain(master, 'a2b');
  let bobRecv = await initChain(master, 'a2b');

  for (const text of ['你好', 'second message', '🔒']) {
    const s = await ratchetStep(aliceSend);
    const { iv, ct } = await aesEncrypt(s.messageKey, encodeUtf8(text));
    aliceSend = s.nextChainKey;

    const r = await ratchetStep(bobRecv);
    const pt = decodeUtf8(await aesDecrypt(r.messageKey, iv, ct));
    bobRecv = r.nextChainKey;

    assert.equal(pt, text);
  }
});

test('GCM tamper is rejected', async () => {
  const master = await initChain(fromB64url(generateRoomCredentials().roomSecret), 'x');
  const { messageKey } = await ratchetStep(await initChain(master, 'a2b'));
  const { iv, ct } = await aesEncrypt(messageKey, encodeUtf8('secret'));
  ct[0] ^= 0xff; // flip a bit
  await assert.rejects(() => aesDecrypt(messageKey, iv, ct));
});

test('forward secrecy: a later message key cannot decrypt an earlier message', async () => {
  const master = await initChain(fromB64url(generateRoomCredentials().roomSecret), 'x');
  let ck = await initChain(master, 'a2b');

  const s1 = await ratchetStep(ck);
  const c1 = await aesEncrypt(s1.messageKey, encodeUtf8('first'));
  ck = s1.nextChainKey;

  const s2 = await ratchetStep(ck); // attacker who captured only s2's key...
  // ...must not be able to read message 1.
  await assert.rejects(() => aesDecrypt(s2.messageKey, c1.iv, c1.ct));
});
