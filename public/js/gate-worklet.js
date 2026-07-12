// Noise gate running on the audio rendering thread.
// Designed to never clip speech tails:
//   - hysteresis: closes at (threshold - 6dB), so quiet word endings stay open
//   - hold: keeps the gate open for holdMs after level drops below threshold
//   - smooth release: fades out over ~300ms instead of hard-cutting
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -60, minValue: -90, maxValue: -10, automationRate: 'k-rate' },
      { name: 'holdMs', defaultValue: 500, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.gain = 1;
    this.holdRemaining = 0;
    this.levelPostCountdown = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const samples = input[0];
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const db = 20 * Math.log10(rms + 1e-8);

    const threshold = params.threshold[0];
    const bypass = params.bypass[0] >= 0.5;
    const blockMs = (samples.length / sampleRate) * 1000;
    const HYSTERESIS_DB = 6;

    let targetGain;
    if (bypass || db > threshold) {
      targetGain = 1;
      this.holdRemaining = params.holdMs[0];
    } else if (db > threshold - HYSTERESIS_DB && this.gain > 0.5) {
      // Inside hysteresis band while already open: treat as speech.
      targetGain = 1;
      this.holdRemaining = params.holdMs[0];
    } else if (this.holdRemaining > 0) {
      this.holdRemaining -= blockMs;
      targetGain = 1;
    } else {
      targetGain = 0;
    }

    // One-pole smoothing: fast attack (5ms) so speech onsets aren't
    // swallowed, slow release (300ms) so tails fade out naturally.
    const tau = targetGain > this.gain ? 5 : 300;
    const coef = Math.exp(-blockMs / tau);
    this.gain = targetGain + (this.gain - targetGain) * coef;

    for (let c = 0; c < output.length; c++) {
      const inCh = input[c] || samples;
      const outCh = output[c];
      for (let i = 0; i < outCh.length; i++) outCh[i] = inCh[i] * this.gain;
    }

    // Level report for the UI meter, ~every 32ms.
    if (--this.levelPostCountdown <= 0) {
      this.levelPostCountdown = 12;
      this.port.postMessage({ db, gateOpen: this.gain > 0.5 });
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
