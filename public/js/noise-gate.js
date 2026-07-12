// Main-thread wrapper for the noise gate worklet. Takes a raw mic
// stream and returns a gated stream to send over WebRTC. Exposes
// live level readings (for the UI meter) and runtime-tunable params.
export class NoiseGate {
  #ctx;
  #node;

  onLevel = () => {}; // ({ db, gateOpen }) => void

  async process(rawStream) {
    this.#ctx = new AudioContext();
    await this.#ctx.audioWorklet.addModule('js/gate-worklet.js');

    const source = this.#ctx.createMediaStreamSource(rawStream);
    this.#node = new AudioWorkletNode(this.#ctx, 'noise-gate');
    const dest = this.#ctx.createMediaStreamDestination();
    source.connect(this.#node).connect(dest);

    this.#node.port.onmessage = (event) => this.onLevel(event.data);

    if (this.#ctx.state === 'suspended') await this.#ctx.resume();
    return dest.stream;
  }

  setThreshold(db) {
    this.#setParam('threshold', db);
  }

  setHoldMs(ms) {
    this.#setParam('holdMs', ms);
  }

  setEnabled(enabled) {
    this.#setParam('bypass', enabled ? 0 : 1);
  }

  #setParam(name, value) {
    const param = this.#node?.parameters.get(name);
    if (param) param.value = value;
  }

  close() {
    this.#node?.port.close();
    this.#ctx?.close();
    this.#node = null;
    this.#ctx = null;
  }
}
