import type { MeetParticipant, MeetTrackKind } from "../../../server/meet/protocol";

export interface MeetMediaSource {
  participant: MeetParticipant;
  kind: MeetTrackKind;
  stream: MediaStream;
}

export class MeetMedia {
  readonly audio = new AudioContext();
  readonly voiceInput = this.audio.createMediaStreamDestination();
  private readonly inputs = new Map<string, MediaStreamAudioSourceNode>();
  private readonly compressor = this.audio.createDynamicsCompressor();

  constructor() { this.compressor.connect(this.voiceInput); }

  attach(source: MeetMediaSource) {
    const key = `${source.participant.id}:${source.stream.id}`;
    if (source.kind !== "camera" || !source.stream.getAudioTracks().length || this.inputs.has(key)) return;
    this.detach(source.participant.id);
    const input = this.audio.createMediaStreamSource(source.stream);
    input.connect(this.compressor);
    this.inputs.set(key, input);
  }

  detach(participantId: string) {
    for (const [key, input] of this.inputs) if (key.startsWith(`${participantId}:`)) {
      input.disconnect();
      this.inputs.delete(key);
    }
  }

  async close() {
    for (const input of this.inputs.values()) input.disconnect();
    this.inputs.clear();
    this.voiceInput.stream.getTracks().forEach((track) => track.stop());
    await this.audio.close();
  }
}

export async function avatarStream(src: string): Promise<{ stream: MediaStream; close(): void }> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#181c27";
  context.fillRect(0, 0, 512, 512);
  const scale = Math.min(400 / image.naturalWidth, 400 / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  const draw = () => context.drawImage(image, (512 - width) / 2, (512 - height) / 2, width, height);
  const stream = canvas.captureStream(2);
  draw();
  const timer = setInterval(draw, 500);
  return { stream, close() { clearInterval(timer); stream.getTracks().forEach((track) => track.stop()); } };
}
