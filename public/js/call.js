// WebRTC voice call logic using the "perfect negotiation" pattern,
// which safely handles offer collisions between the two peers.
// Audio flows peer-to-peer; only signaling goes through the server.
//
// E2EE layers on top:
//   - Media rides WebRTC's DTLS-SRTP; the DTLS fingerprint travels inside the
//     SDP, which the signaling layer HMAC-authenticates, so a malicious relay
//     cannot MITM the media.
//   - An ephemeral ECDH handshake (authenticated the same way) yields a shared
//     master secret mixed with room_secret, from which per-direction ratcheted
//     chat keys are derived. Text chat is AES-GCM encrypted end-to-end.
import { ICE_SERVERS } from './ice-config.js';
import {
  preferredEcdhAlg,
  generateEphemeralKeyPair,
  deriveMaster,
  initChain,
  ratchetStep,
  aesEncrypt,
  aesDecrypt,
  toB64url,
  fromB64url,
  encodeUtf8,
  decodeUtf8,
} from './crypto.mjs';

// Fallback screen video cap so voice always keeps bandwidth headroom;
// the caller normally passes a per-resolution cap. Voice needs ~40kbps
// and congestion control sheds video frames first thanks to the
// priority settings below.
const SCREEN_MAX_BITRATE = 2_500_000;

export class VoiceCall {
  #pc;
  #signaling;
  #localStream;
  #polite;
  #audioTransform;
  #micSender = null;
  #screenSenders = [];
  #makingOffer = false;
  #ignoreOffer = false;

  // E2EE handshake / chat state
  #roomSecret; // Uint8Array, never leaves the browser
  #ecdhAlg = null;
  #ecdhKeyPair = null;
  #masterReady = false;
  #sendChain = null;
  #recvChain = null;
  #chatChannel = null;

  onStateChange = () => {};
  onRemoteStream = () => {};
  onScreenStream = () => {};
  onScreenEnded = () => {};
  onChatReady = () => {};
  onChatMessage = () => {};

  // audioTransform: optional async (rawStream) => processedStream,
  // e.g. a noise gate. Mute still acts on the raw mic tracks.
  // roomSecret: Uint8Array from the URL fragment — root of the E2EE key schedule.
  constructor(signaling, { polite, audioTransform = null, roomSecret }) {
    this.#signaling = signaling;
    this.#polite = polite;
    this.#audioTransform = audioTransform;
    this.#roomSecret = roomSecret;
  }

  async start() {
    // Audio processing constraints matter more for perceived quality
    // than bitrate: echo cancellation and noise suppression are key.
    this.#localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const sendStream = this.#audioTransform
      ? await this.#audioTransform(this.#localStream)
      : this.#localStream;

    this.#pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Chat DataChannel: the impolite peer (offerer) creates it so it is part
    // of the first offer; the polite peer receives it. Payloads are E2EE at
    // the application layer, independent of the transport.
    if (!this.#polite) {
      this.#bindChatChannel(this.#pc.createDataChannel('chat'));
    } else {
      this.#pc.ondatachannel = ({ channel }) => this.#bindChatChannel(channel);
    }

    for (const track of sendStream.getTracks()) {
      const sender = this.#pc.addTrack(track, sendStream);
      if (track.kind === 'audio') this.#micSender = sender;
    }

    // A stream carrying video is the peer's screen share; the
    // audio-only stream is their voice.
    this.#pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (stream.getVideoTracks().length > 0) {
        this.onScreenStream(stream);
        stream.addEventListener('removetrack', () => {
          if (stream.getVideoTracks().length === 0) this.onScreenEnded();
        });
      } else {
        this.onRemoteStream(stream);
      }
    };

    this.#pc.onconnectionstatechange = () =>
      this.onStateChange(this.#pc.connectionState);

    this.#pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        await this.#pc.setLocalDescription();
        this.#signaling.sendSignal({ description: this.#pc.localDescription });
      } finally {
        this.#makingOffer = false;
      }
    };

    this.#pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signaling.sendSignal({ candidate });
    };

    this.#signaling.on('signal', ({ data }) => this.#handleSignal(data));

    // Kick off the ECDH handshake in parallel with media negotiation.
    await this.#startHandshake();
  }

  // --- E2EE key handshake ---

  async #startHandshake() {
    this.#ecdhAlg = await preferredEcdhAlg();
    this.#ecdhKeyPair = await generateEphemeralKeyPair(this.#ecdhAlg);
    this.#sendPublicKey();
  }

  #sendPublicKey() {
    this.#signaling.sendSignal({
      handshake: {
        alg: this.#ecdhAlg,
        pub: toB64url(this.#ecdhKeyPair.publicKeyRaw),
      },
    });
  }

  async #handleHandshake({ alg, pub }) {
    if (this.#masterReady) return; // ignore duplicate/late handshakes

    // Cross-browser negotiation: P-256 is the universal floor. If peers differ,
    // only the X25519 side downgrades to P-256 and resends; this converges in
    // one extra step without looping (no one ever upgrades).
    if (alg !== this.#ecdhAlg) {
      if (this.#ecdhAlg === 'X25519') {
        this.#ecdhAlg = 'P-256';
        this.#ecdhKeyPair = await generateEphemeralKeyPair('P-256');
        this.#sendPublicKey();
        // peer is already on P-256; derive against their key now
      } else {
        return; // we are P-256; wait for their downgraded key
      }
    }

    const master = await deriveMaster(
      this.#ecdhKeyPair.privateKey,
      fromB64url(pub),
      this.#ecdhAlg,
      this.#roomSecret
    );
    await this.#setupChat(master);
  }

  // Two independent ratchet chains keyed off the shared master; the label
  // pairing guarantees each peer's send chain matches the other's recv chain.
  async #setupChat(master) {
    const sendLabel = this.#polite ? 'p2i' : 'i2p';
    const recvLabel = this.#polite ? 'i2p' : 'p2i';
    this.#sendChain = await initChain(master, sendLabel);
    this.#recvChain = await initChain(master, recvLabel);
    this.#masterReady = true;
    if (this.#chatChannel?.readyState === 'open') this.onChatReady();
  }

  #bindChatChannel(channel) {
    this.#chatChannel = channel;
    channel.onopen = () => {
      if (this.#masterReady) this.onChatReady();
    };
    channel.onmessage = (e) => this.#receiveChat(e.data);
  }

  // Advance the send ratchet, AES-GCM encrypt, and ship ciphertext only.
  async sendChat(text) {
    if (!this.#masterReady || this.#chatChannel?.readyState !== 'open') return false;
    const { messageKey, nextChainKey } = await ratchetStep(this.#sendChain);
    this.#sendChain = nextChainKey;
    const { iv, ct } = await aesEncrypt(messageKey, encodeUtf8(text));
    this.#chatChannel.send(
      JSON.stringify({ iv: toB64url(iv), ct: toB64url(ct) })
    );
    return true;
  }

  async #receiveChat(raw) {
    if (!this.#masterReady) return;
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    const { messageKey, nextChainKey } = await ratchetStep(this.#recvChain);
    this.#recvChain = nextChainKey;
    try {
      const pt = await aesDecrypt(
        messageKey,
        fromB64url(env.iv),
        fromB64url(env.ct)
      );
      this.onChatMessage(decodeUtf8(pt));
    } catch {
      // GCM tag mismatch — tampered or out-of-sync; drop silently.
    }
  }

  async #handleSignal({ description, candidate, handshake }) {
    if (handshake) return this.#handleHandshake(handshake);
    if (description) {
      const offerCollision =
        description.type === 'offer' &&
        (this.#makingOffer || this.#pc.signalingState !== 'stable');

      this.#ignoreOffer = !this.#polite && offerCollision;
      if (this.#ignoreOffer) return;

      await this.#pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await this.#pc.setLocalDescription();
        this.#signaling.sendSignal({ description: this.#pc.localDescription });
      }
    } else if (candidate) {
      try {
        await this.#pc.addIceCandidate(candidate);
      } catch (err) {
        if (!this.#ignoreOffer) throw err;
      }
    }
  }

  // Adds screen tracks to the existing connection; perfect negotiation
  // renegotiates automatically. Voice-priority defenses (independent of
  // the chosen resolution):
  //   - screen video is bitrate-capped and marked low priority
  //   - the mic sender is boosted to high priority
  //   - keep the chosen resolution, drop framerate first under congestion
  async startScreenShare(stream, { maxBitrate } = {}) {
    if (!this.#pc) return;
    for (const track of stream.getTracks()) {
      this.#screenSenders.push(this.#pc.addTrack(track, stream));
    }
    await this.setScreenBitrate(maxBitrate);
    this.#boostVoicePriority();
  }

  // Apply / update the screen video encoding cap; safe to call live.
  async setScreenBitrate(maxBitrate) {
    const videoSender = this.#screenSenders.find(
      (s) => s.track?.kind === 'video'
    );
    if (!videoSender) return;
    const params = videoSender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    for (const enc of params.encodings ?? []) {
      enc.maxBitrate = maxBitrate ?? SCREEN_MAX_BITRATE;
      enc.priority = 'low';
      enc.networkPriority = 'low';
    }
    try {
      await videoSender.setParameters(params);
    } catch {
      // Priority hints are best-effort; the share still works without them.
    }
  }

  stopScreenShare() {
    for (const sender of this.#screenSenders) {
      try {
        this.#pc?.removeTrack(sender);
      } catch {
        // Connection may already be closed.
      }
    }
    this.#screenSenders = [];
  }

  #boostVoicePriority() {
    if (!this.#micSender) return;
    const params = this.#micSender.getParameters();
    for (const enc of params.encodings ?? []) {
      enc.priority = 'high';
      enc.networkPriority = 'high';
    }
    this.#micSender.setParameters(params).catch(() => {});
  }

  setMuted(muted) {
    for (const track of this.#localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  // Live RTT / connection-type stats, so users can see call smoothness.
  async getStats() {
    if (!this.#pc) return null;
    const stats = await this.#pc.getStats();
    let rtt = null;
    let relayed = false;
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (report.currentRoundTripTime != null) {
          rtt = Math.round(report.currentRoundTripTime * 1000);
        }
        const local = stats.get(report.localCandidateId);
        if (local?.candidateType === 'relay') relayed = true;
      }
    }
    return { rtt, relayed };
  }

  hangup() {
    this.#screenSenders = [];
    this.#micSender = null;
    try {
      this.#chatChannel?.close();
    } catch {
      // already closing/closed
    }
    this.#chatChannel = null;
    this.#sendChain = null;
    this.#recvChain = null;
    this.#masterReady = false;
    this.#ecdhKeyPair = null;
    this.#pc?.close();
    this.#pc = null;
    for (const track of this.#localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#localStream = null;
  }
}
