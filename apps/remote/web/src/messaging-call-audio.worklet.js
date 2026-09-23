class SignalCallAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSamples = options.processorOptions?.frameSamples || 960;
    this.targetFrames = options.processorOptions?.targetFrames || 3;
    this.microphone = new Int16Array(this.frameSamples);
    this.microphoneOffset = 0;
    this.remote = new Map();
    this.remoteSequence = null;
    this.playing = false;
    this.playback = null;
    this.playbackOffset = 0;
    this.port.onmessage = ({ data }) => {
      if (!(data?.remote instanceof ArrayBuffer) || data.remote.byteLength !== this.frameSamples * 2) return;
      const sequence = data.sequence;
      if (!Number.isInteger(sequence) || sequence < 0 || (this.remoteSequence !== null && sequence < this.remoteSequence) || this.remote.has(sequence)) return;
      this.remote.set(sequence, new Int16Array(data.remote));
    };
  }

  capture(input) {
    if (!input) return;
    for (let source = 0; source < input.length;) {
      const count = Math.min(this.frameSamples - this.microphoneOffset, input.length - source);
      for (let index = 0; index < count; index++) {
        const sample = Math.max(-1, Math.min(1, input[source + index]));
        this.microphone[this.microphoneOffset + index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      }
      this.microphoneOffset += count;
      source += count;
      if (this.microphoneOffset !== this.frameSamples) continue;
      const frame = this.microphone.buffer;
      this.port.postMessage({ microphone: frame }, [frame]);
      this.microphone = new Int16Array(this.frameSamples);
      this.microphoneOffset = 0;
    }
  }

  nextRemote() {
    if (!this.playing) {
      if (this.remote.size < this.targetFrames) return null;
      this.remoteSequence = Math.min(...this.remote.keys());
      this.playing = true;
    }
    const frame = this.remote.get(this.remoteSequence);
    if (!frame) { this.playing = false; return null; }
    this.remote.delete(this.remoteSequence++);
    return frame;
  }

  play(output) {
    output.fill(0);
    let target = 0;
    while (target < output.length) {
      this.playback ||= this.nextRemote();
      if (!this.playback) return;
      const count = Math.min(output.length - target, this.playback.length - this.playbackOffset);
      for (let index = 0; index < count; index++) output[target + index] = this.playback[this.playbackOffset + index] / 32768;
      target += count;
      this.playbackOffset += count;
      if (this.playbackOffset === this.playback.length) { this.playback = null; this.playbackOffset = 0; }
    }
  }

  process(inputs, outputs) {
    this.capture(inputs[0]?.[0]);
    const output = outputs[0]?.[0];
    if (output) this.play(output);
    return true;
  }
}
registerProcessor("signal-call-audio", SignalCallAudio);
