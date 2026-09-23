class MeetPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = []; this.before = []; this.samples = 0; this.silence = 0; this.startedAt = 0;
    this.port.onmessage = ({ data }) => {
      if (data.flush) { this.flush(); this.port.postMessage({ flushed: data.flush }); }
    };
  }
  flush() {
    if (this.samples) {
      const pcm = new Int16Array(this.samples);
      let offset = 0;
      for (const buffer of this.buffers) for (const value of buffer) pcm[offset++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
      this.port.postMessage({ audio: pcm.buffer, startedAt: this.startedAt }, [pcm.buffer]);
    }
    this.buffers = []; this.samples = 0; this.silence = 0; this.before = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let energy = 0;
    for (const sample of input) energy += sample * sample;
    const speech = Math.sqrt(energy / input.length) > 0.008;
    const copy = input.slice();
    if (!this.samples && !speech) {
      this.before.push(copy);
      if (this.before.length > Math.ceil(sampleRate * 0.25 / input.length)) this.before.shift();
      return true;
    }
    if (!this.samples) {
      this.buffers = this.before; this.before = [];
      this.samples = this.buffers.reduce((n, buffer) => n + buffer.length, 0);
      this.startedAt = currentTime - this.samples / sampleRate;
    }
    this.buffers.push(copy); this.samples += copy.length;
    this.silence = speech ? 0 : this.silence + copy.length;
    if (this.silence >= sampleRate * 0.7 || this.samples >= sampleRate * 12) this.flush();
    return true;
  }
}
registerProcessor("meet-pcm", MeetPCM);
