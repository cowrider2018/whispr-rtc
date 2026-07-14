// Integration test: replays the E2EE protocol exactly as signaling.js and
// call.js orchestrate it, using the same crypto.mjs primitives, but without a
// browser/WebRTC. Validates the composition end-to-end: authenticated
// signaling envelope + ECDH handshake (incl. cross-alg downgrade) + two-way
// ratcheted chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRoomCredentials,
  fromB64url,
  deriveAuthKey,
  macSign,
  macVerify,
  toB64url,
  generateEphemeralKeyPair,
  deriveMaster,
  initChain,
  ratchetStep,
  aesEncrypt,
  aesDecrypt,
  encodeUtf8,
  decodeUtf8,
} from '../public/js/crypto.mjs';

// Mirror of signaling.js sendSignal/handleSignal envelope handling.
async function wrap(authKey, data) {
  const p = JSON.stringify(data);
  const m = toB64url(await macSign(authKey, encodeUtf8(p)));
  return { p, m };
}
async function unwrap(authKey, env) {
  const ok = await macVerify(authKey, encodeUtf8(env.p), fromB64url(env.m));
  if (!ok) return null;
  return JSON.parse(env.p);
}

test('signaling envelope survives relay round-trip; tamper is rejected', async () => {
  const secret = fromB64url(generateRoomCredentials().roomSecret);
  const authKey = await deriveAuthKey(secret);

  const env = await wrap(authKey, { description: { type: 'offer', sdp: 'a=fingerprint:AA' } });
  // Honest relay forwards bytes unchanged:
  assert.deepEqual((await unwrap(authKey, env)).description.sdp, 'a=fingerprint:AA');

  // Malicious relay swaps the DTLS fingerprint inside the SDP:
  const evil = { ...env, p: env.p.replace('AA', 'EVIL') };
  assert.equal(await unwrap(authKey, evil), null); // dropped -> no MITM
});

// Full handshake + chat between two peers. `algA/algB` let us force the
// cross-browser downgrade path (one X25519, one P-256).
async function runSession(algA, algB) {
  const secret = fromB64url(generateRoomCredentials().roomSecret);

  // Peer A = polite (first joiner), Peer B = impolite (offerer).
  let a = { alg: algA, kp: await generateEphemeralKeyPair(algA), master: null };
  let b = { alg: algB, kp: await generateEphemeralKeyPair(algB), master: null };

  // handleHandshake logic from call.js, incl. downgrade-to-P-256 floor.
  async function receive(self, peer) {
    if (self.alg !== peer.alg) {
      if (self.alg === 'X25519') {
        self.alg = 'P-256';
        self.kp = await generateEphemeralKeyPair('P-256');
        // peer already P-256 -> derive now
      } else {
        return false; // wait for peer's downgraded key
      }
    }
    self.master = await deriveMaster(self.kp.privateKey, peer.kp.publicKeyRaw, self.alg, secret);
    return true;
  }

  // Both send; deliver until both derived (handles one downgrade round).
  await receive(a, b);
  await receive(b, a);
  if (!a.master) await receive(a, b);
  if (!b.master) await receive(b, a);

  assert.ok(a.master && b.master, 'both peers derived a master');
  assert.deepEqual(a.master, b.master, 'masters agree');
  return { a: a.master, secret };
}

test('handshake agrees when both prefer X25519', async () => {
  await runSession('X25519', 'X25519');
});

test('handshake agrees on P-256 when browsers differ (downgrade path)', async () => {
  await runSession('X25519', 'P-256');
  await runSession('P-256', 'X25519');
});

test('two-way ratcheted chat with call.js chain labels', async () => {
  const { a: master } = await runSession('P-256', 'P-256');

  // call.js: polite send 'p2i'/recv 'i2p'; impolite send 'i2p'/recv 'p2i'.
  const polite = { send: await initChain(master, 'p2i'), recv: await initChain(master, 'i2p') };
  const impolite = { send: await initChain(master, 'i2p'), recv: await initChain(master, 'p2i') };

  async function send(peer, text) {
    const s = await ratchetStep(peer.send);
    peer.send = s.nextChainKey;
    const { iv, ct } = await aesEncrypt(s.messageKey, encodeUtf8(text));
    return { iv: toB64url(iv), ct: toB64url(ct) };
  }
  async function recv(peer, env) {
    const r = await ratchetStep(peer.recv);
    peer.recv = r.nextChainKey;
    const pt = await aesDecrypt(r.messageKey, fromB64url(env.iv), fromB64url(env.ct));
    return decodeUtf8(pt);
  }

  assert.equal(await recv(impolite, await send(polite, '嗨,這是加密的')), '嗨,這是加密的');
  assert.equal(await recv(polite, await send(impolite, '收到 ✅')), '收到 ✅');
  assert.equal(await recv(impolite, await send(polite, 'line 2')), 'line 2');
});

test('tampered chat ciphertext is rejected', async () => {
  const { a: master } = await runSession('P-256', 'P-256');
  const send = await initChain(master, 'p2i');
  const recv = await initChain(master, 'p2i');
  const s = await ratchetStep(send);
  const { iv, ct } = await aesEncrypt(s.messageKey, encodeUtf8('secret'));
  const bad = fromB64url(toB64url(ct));
  bad[0] ^= 0x01;
  const r = await ratchetStep(recv);
  await assert.rejects(() => aesDecrypt(r.messageKey, fromB64url(toB64url(iv)), bad));
});
