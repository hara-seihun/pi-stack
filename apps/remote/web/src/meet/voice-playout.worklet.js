class MeetVoicePlayout extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.ceil(sampleRate * 0.24));
    this.write = 0;
    this.read = 0;
    this.queued = 0;
    this.primed = false;
    this.underruns = 0;
    this.discarded = 0;
    this.frames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    const capacity = this.samples.length;
    const target = Math.ceil(sampleRate * 0.06);
    const maximum = Math.ceil(sampleRate * 0.16);
    if (input) for (let i = 0; i < input.length; i++) {
      if (this.queued === capacity) {
        this.read = (this.read + 1) % capacity;
        this.queued--;
        this.discarded++;
      }
      this.samples[this.write] = input[i];
      this.write = (this.write + 1) % capacity;
      this.queued++;
    }
    if (this.queued > maximum) {
      const excess = this.queued - target;
      this.read = (this.read + excess) % capacity;
      this.queued -= excess;
      this.discarded += excess;
    }
    if (!this.primed && this.queued >= target) this.primed = true;
    if (this.primed) for (let i = 0; i < output.length; i++) {
      if (!this.queued) {
        this.primed = false;
        this.underruns++;
        break;
      }
      output[i] = this.samples[this.read];
      this.read = (this.read + 1) % capacity;
      this.queued--;
    }
    this.frames++;
    if (this.frames % Math.max(1, Math.round(sampleRate / output.length * 5)) === 0) {
      this.port.postMessage({ queuedMs: Math.round(this.queued * 1000 / sampleRate), underruns: this.underruns,
        discardedMs: Math.round(this.discarded * 1000 / sampleRate), sampleRate });
    }
    return true;
  }
}
registerProcessor("meet-voice-playout", MeetVoicePlayout);
