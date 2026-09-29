import playoutWorklet from "./voice-playout.worklet.js?raw";

/** One stable audio track from the first frame of the Recall webpage, clocked by Web Audio. */
export class MeetVoicePlayout {
  readonly stream: MediaStream;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly node: AudioWorkletNode;
  private source: MediaStreamAudioSourceNode | null = null;
  private closed = false;

  private constructor(private readonly context: AudioContext, node: AudioWorkletNode,
    onDiagnostic: (data: unknown) => void) {
    this.node = node;
    this.destination = context.createMediaStreamDestination();
    this.stream = this.destination.stream;
    node.channelCount = 1;
    node.channelCountMode = "explicit";
    node.connect(this.destination);
    node.port.onmessage = (event) => onDiagnostic(event.data);
  }

  static async create(context: AudioContext, onDiagnostic: (data: unknown) => void): Promise<MeetVoicePlayout> {
    const url = URL.createObjectURL(new Blob([playoutWorklet], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return new MeetVoicePlayout(context, new AudioWorkletNode(context, "meet-voice-playout", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    }), onDiagnostic);
  }

  attach(stream: MediaStream): void {
    if (this.closed) return;
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.node);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source?.disconnect();
    this.node.disconnect();
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach(track => track.stop());
  }
}
