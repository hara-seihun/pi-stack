import type { MeetSnapshot } from "../../../server/meet/protocol";
import { drawContainedImage } from "./media";
import type { MeetRoom } from "./room";

export class MeetBrowser {
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  constructor(
    private readonly room: MeetRoom,
    private readonly onStream: (stream: MediaStream | null) => void,
    private readonly onError: (message: string) => void,
  ) {}

  get stream() { return this.room.published.get("pi-screen") ?? null; }

  reconcile(snapshot: MeetSnapshot) {
    if (!snapshot.browser) { this.close(); return; }
    if (!this.room.joined.participant.host || this.canvas) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    this.canvas = canvas;
    this.abort = new AbortController();
    const stream = canvas.captureStream(5);
    this.room.publish("pi-screen", stream);
    this.onStream(stream);
    void this.draw(canvas, this.abort.signal);
  }

  private async draw(canvas: HTMLCanvasElement, signal: AbortSignal) {
    if (this.canvas !== canvas) return;
    let delay = 200;
    try {
      const response = await this.room.request(this.room.path("/browser/frame"), { signal });
      if (this.canvas !== canvas) return;
      const drawing = canvas.getContext("2d")!;
      if (response.status === 404) {
        drawing.fillStyle = "#101419"; drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = "#b9c0c9"; drawing.font = "24px sans-serif";
        drawing.fillText(this.room.snapshot.browser?.error || "Waiting for Kenan's browser…", 40, canvas.height / 2);
      } else {
        if (!response.ok) throw new Error(`Browser frame HTTP ${response.status}`);
        const image = await createImageBitmap(await response.blob());
        try {
          if (this.canvas === canvas) {
            drawing.fillStyle = "#101419"; drawing.fillRect(0, 0, canvas.width, canvas.height);
            drawContainedImage(drawing, image, image.width, image.height, 0, 0, canvas.width, canvas.height);
          }
        } finally { image.close(); }
      }
    } catch (cause) {
      if (signal.aborted) return;
      this.onError(`Browser frame: ${String(cause instanceof Error ? cause.message : cause)}`);
      delay = 750;
    }
    if (this.canvas === canvas) this.timer = setTimeout(() => void this.draw(canvas, signal), delay);
  }

  close() {
    if (!this.canvas) return;
    this.canvas = null;
    this.abort?.abort(); this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.room.unpublish("pi-screen");
    this.onStream(null);
  }
}
