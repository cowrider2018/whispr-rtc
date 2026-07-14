// Thin WebSocket signaling client. Knows nothing about WebRTC —
// it only joins a room and relays opaque messages, keeping it
// decoupled from call logic.
//
// E2EE integrity: once an auth_key (derived from room_secret) is set, every
// outgoing `signal` payload is HMAC-authenticated and every incoming one is
// verified before dispatch. The relay never learns room_secret, so it cannot
// forge or tamper with SDP / ICE / handshake messages — a modified message
// simply fails verification and is dropped.
import { macSign, macVerify, encodeUtf8, toB64url, fromB64url } from './crypto.mjs';

export class SignalingChannel {
  #ws;
  #handlers = {};
  #authKey = null;

  // Must be called before connect() so the very first signal is protected.
  setAuthKey(key) {
    this.#authKey = key;
  }

  connect(room) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.#ws = new WebSocket(`${proto}://${location.host}`);

    this.#ws.addEventListener('open', () => {
      this.#ws.send(JSON.stringify({ type: 'join', room }));
    });

    this.#ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'signal') {
        this.#handleSignal(msg);
        return;
      }
      this.#handlers[msg.type]?.(msg);
    });

    this.#ws.addEventListener('close', () => {
      this.#handlers['disconnected']?.();
    });
  }

  on(type, handler) {
    this.#handlers[type] = handler;
  }

  // Verify the MAC over the exact bytes we received, then hand the parsed
  // payload to the 'signal' handler. Unauthenticated or tampered messages
  // are dropped and reported via the 'auth-fail' handler.
  async #handleSignal(msg) {
    if (!this.#authKey) return;
    const env = msg.data;
    if (!env || typeof env.p !== 'string' || typeof env.m !== 'string') return;
    let ok = false;
    try {
      ok = await macVerify(this.#authKey, encodeUtf8(env.p), fromB64url(env.m));
    } catch {
      ok = false;
    }
    if (!ok) {
      this.#handlers['auth-fail']?.();
      return;
    }
    let data;
    try {
      data = JSON.parse(env.p);
    } catch {
      return;
    }
    this.#handlers['signal']?.({ data });
  }

  // Wrap the payload as { p: canonicalString, m: HMAC(p) } so the receiver
  // verifies the identical bytes it MACs — no canonicalization ambiguity.
  async sendSignal(data) {
    if (this.#ws?.readyState !== WebSocket.OPEN || !this.#authKey) return;
    const p = JSON.stringify(data);
    const m = toB64url(await macSign(this.#authKey, encodeUtf8(p)));
    this.#ws.send(JSON.stringify({ type: 'signal', data: { p, m } }));
  }

  close() {
    this.#handlers = {};
    this.#ws?.close();
  }
}
