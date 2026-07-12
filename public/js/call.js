// WebRTC voice call logic using the "perfect negotiation" pattern,
// which safely handles offer collisions between the two peers.
// Audio flows peer-to-peer; only signaling goes through the server.
import { ICE_SERVERS } from './ice-config.js';

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

  onStateChange = () => {};
  onRemoteStream = () => {};
  onScreenStream = () => {};
  onScreenEnded = () => {};

  // audioTransform: optional async (rawStream) => processedStream,
  // e.g. a noise gate. Mute still acts on the raw mic tracks.
  constructor(signaling, { polite, audioTransform = null }) {
    this.#signaling = signaling;
    this.#polite = polite;
    this.#audioTransform = audioTransform;
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
  }

  async #handleSignal({ description, candidate }) {
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
    this.#pc?.close();
    this.#pc = null;
    for (const track of this.#localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#localStream = null;
  }
}
