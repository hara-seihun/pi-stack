import type { MeetParticipant } from "../../../server/meet/protocol";

export interface MeetMediaSource {
  participant: MeetParticipant;
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
    if (!source.stream.getAudioTracks().length || this.inputs.has(key)) return;
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

export function drawContainedImage(
  context: CanvasRenderingContext2D, image: CanvasImageSource,
  sourceWidth: number, sourceHeight: number, x: number, y: number, width: number, height: number,
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
  context.drawImage(image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

export async function logoStream(src: string): Promise<{ stream: MediaStream; close(): void }> {
  if (!src.trim()) throw new Error("The external meeting requires its Liminal logo");
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Meeting logo canvas is unavailable");
  const draw = () => {
    context.fillStyle = "#181822";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContainedImage(context, image, image.naturalWidth, image.naturalHeight, 0, 0, canvas.width, canvas.height);
  };
  draw();
  const stream = canvas.captureStream(1);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    stream.getTracks().forEach(track => track.stop());
  };
  const timer = setInterval(() => {
    if (stream.getVideoTracks().every(track => track.readyState === "ended")) { close(); return; }
    draw();
  }, 1000);
  stream.getVideoTracks().forEach(track => track.addEventListener("ended", close, { once: true }));
  return { stream, close };
}
