import type { MeetParticipant, MeetThreadState, MeetTrackKind } from "../../../server/meet/protocol";
import { threadStatus, type ThreadStatus } from "../features/status/thread-status";

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

export interface MeetCameraState {
  voice: string;
  playback: string;
  muted: boolean;
  threads: MeetThreadState[];
}

export function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
  context.drawImage(image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

const cameraColors = {
  text: "#eff4ff", secondary: "#acbad0", muted: "#8192ac",
  accent: "#a4bcff", green: "#81dfbd", amber: "#f3cd86", red: "#ff9caa",
};
const cameraFont = '"Inter", ui-sans-serif, system-ui, sans-serif';
const pageDuration = 8_000;
const overviewSize = 12;
const detailLines = 5;
type CameraLine = { text: string; label: boolean };

function stateColor(state: string): string {
  if (/error|fail|disconnect|blocked/i.test(state)) return cameraColors.red;
  if (/running|speaking|playing|active|working|thinking|compact|retry|listening|connected|^unmuted$/i.test(state)) return cameraColors.green;
  if (/wait|pause|mute|connecting|stopped/i.test(state)) return cameraColors.amber;
  return cameraColors.accent;
}

export function meetThreadStatus(thread: MeetThreadState): ThreadStatus {
  return threadStatus({
    state: thread.state,
    held: thread.held,
    activity: thread.activity,
    activeTools: thread.tools,
    idleUnread: false,
    archivedAt: null,
  });
}

function cameraText(context: CanvasRenderingContext2D, text: string, x: number, y: number, size = 22, color: string = cameraColors.text, weight = 400) {
  context.font = `${weight} ${size}px ${cameraFont}`;
  context.fillStyle = color;
  context.fillText(text, x, y);
}

function fitCameraText(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  const characters = Array.from(text);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${characters.slice(0, middle).join("")}…`).width <= width) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}…`;
}

function wrapCameraText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/( +)/)) {
      if (context.measureText(line + word).width <= width) { line += word; continue; }
      if (line) { lines.push(line); line = ""; }
      for (const character of word) {
        if (line && context.measureText(line + character).width > width) { lines.push(line); line = ""; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function eventLabel(kind: string): string {
  const labels: Record<string, string> = { tool_start: "Calling", tool_end: "Output", tool_error: "Tool error", assistant: "Message", notice: "Status" };
  return labels[kind] || kind;
}

function threadLines(context: CanvasRenderingContext2D, thread: MeetThreadState): CameraLine[] {
  const lines: CameraLine[] = [];
  const add = (text: string, label = false) => {
    context.font = `${label ? 600 : 400} 22px ${cameraFont}`;
    for (const line of wrapCameraText(context, text, 832)) lines.push({ text: line, label });
  };
  const status = meetThreadStatus(thread);
  add(status.label, true);
  if (status.title) add(`TOOLS · ${status.title}`, true);
  if (thread.output && !thread.events.some((event) => event.kind === "assistant" && event.text === thread.output)) {
    add("ASSISTANT OUTPUT", true); add(thread.output);
  }
  for (const event of [...thread.events].reverse()) {
    add(`${eventLabel(event.kind)}${event.name ? ` · ${event.name}` : ""}  #${event.id}`, true);
    if (event.text) add(event.text);
  }
  if (!thread.output && !thread.events.length) add("No tool calls or assistant output yet.");
  return lines;
}

export async function avatarStream(src: string, getState: () => MeetCameraState): Promise<{ stream: MediaStream; close(): void }> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext("2d")!;
  context.textBaseline = "top";
  const content = new Map<string, { signature: string; lines: CameraLine[]; page: number }>();
  let selectedId: string | null = null;
  let nextPageAt = performance.now() + pageDuration;
  let overviewPage = 0;
  let closed = false;

  const card = (x: number, y: number, width: number, height: number, fill = "#182333") => {
    context.beginPath();
    context.roundRect(x, y, width, height, 18);
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = "#2a3a51";
    context.lineWidth = 1;
    context.stroke();
  };
  const fitted = (text: string, x: number, y: number, width: number, size = 22, color: string = cameraColors.text, weight = 400) => {
    context.font = `${weight} ${size}px ${cameraFont}`;
    cameraText(context, fitCameraText(context, text, width), x, y, size, color, weight);
  };
  const draw = () => {
    if (closed) return;
    const now = performance.now();
    const state = getState();
    const threads = state.threads;
    const ids = new Set(threads.map((thread) => thread.id));
    for (const id of content.keys()) if (!ids.has(id)) content.delete(id);
    let selected = threads.findIndex((thread) => thread.id === selectedId);
    if (selected < 0) selected = 0;
    if (now >= nextPageAt) {
      const previous = selectedId ? content.get(selectedId) : undefined;
      if (previous) previous.page = (previous.page + 1) % Math.max(1, Math.ceil(previous.lines.length / detailLines));
      selected = threads.length ? (selected + 1) % threads.length : 0;
      overviewPage++;
      nextPageAt = now + pageDuration;
    }
    selectedId = threads[selected]?.id ?? null;
    const overviewPages = Math.max(1, Math.ceil(threads.length / overviewSize));
    overviewPage %= overviewPages;

    const background = context.createLinearGradient(0, 0, 1024, 1024);
    background.addColorStop(0, "#17243a");
    background.addColorStop(1, "#0b111c");
    context.fillStyle = background;
    context.fillRect(0, 0, 1024, 1024);

    card(64, 64, 72, 72, "#202e43");
    drawContainedImage(context, image, image.naturalWidth, image.naturalHeight, 74, 74, 52, 52);
    cameraText(context, "Kenan", 156, 65, 36, cameraColors.text, 650);
    cameraText(context, "MEETING CAMERA", 158, 111, 16, cameraColors.secondary, 600);
    context.beginPath();
    context.arc(796, 85, 5, 0, Math.PI * 2);
    context.fillStyle = cameraColors.green;
    context.fill();
    cameraText(context, "LIVE STATE", 812, 76, 18, cameraColors.secondary, 600);

    const statuses = [
      { label: "VOICE", value: state.voice || "Off" },
      { label: "PLAYBACK", value: state.playback || "Stopped" },
      { label: "VOICE OUTPUT", value: state.muted ? "Muted" : "Unmuted" },
    ];
    statuses.forEach((status, index) => {
      const x = 64 + index * 304;
      card(x, 160, 288, 84);
      cameraText(context, status.label, x + 18, 176, 14, cameraColors.secondary, 600);
      fitted(status.value, x + 18, 201, 252, 23, stateColor(status.value), 500);
    });

    cameraText(context, `THREAD OVERVIEW · ${threads.length}`, 64, 269, 17, cameraColors.secondary, 600);
    cameraText(context, `PAGE ${overviewPage + 1}/${overviewPages}`, 832, 269, 17, cameraColors.secondary, 600);
    const visible = threads.slice(overviewPage * overviewSize, (overviewPage + 1) * overviewSize);
    const compact = threads.length > 6;
    const columns = compact ? 3 : 2;
    const cellWidth = compact ? 288 : 440;
    const rowHeight = compact ? 48 : 64;
    visible.forEach((thread, index) => {
      const x = 64 + (index % columns) * (cellWidth + 16);
      const y = 302 + Math.floor(index / columns) * rowHeight;
      const active = thread.id === selectedId;
      context.fillStyle = active ? "#253a56" : "#182333";
      context.beginPath(); context.roundRect(x, y, cellWidth, rowHeight - 6, 8); context.fill();
      const status = meetThreadStatus(thread);
      context.fillStyle = stateColor(status.label);
      context.beginPath(); context.arc(x + 12, y + 14, 3, 0, Math.PI * 2); context.fill();
      fitted(thread.name || thread.id, x + 23, y + 3, cellWidth - 34, compact ? 17 : 21, cameraColors.text, 500);
      fitted(status.label, x + 23, y + (compact ? 23 : 32), cellWidth - 34, compact ? 14 : 18, stateColor(status.label));
    });
    if (!threads.length) {
      cameraText(context, "No delegated threads", 64, 324, 27, cameraColors.text, 500);
      cameraText(context, "Thread activity will appear here when a delegation starts.", 64, 369, 20, cameraColors.secondary);
    }

    card(64, 510, 896, 138, "#1a2b40");
    const latest = threads.flatMap((thread) => {
      const event = thread.events.at(-1);
      return event ? [{ thread, event }] : [];
    }).reduce<{ thread: MeetThreadState; event: MeetThreadState["events"][number] } | null>(
      (current, item) => !current || item.event.id > current.event.id ? item : current, null);
    if (latest) {
      fitted(`LATEST · ${latest.thread.name} · ${eventLabel(latest.event.kind)} · ${latest.event.name}`, 88, 529, 848, 19,
        latest.event.kind === "tool_error" ? cameraColors.red : cameraColors.accent, 600);
      context.font = `400 22px ${cameraFont}`;
      const lines = wrapCameraText(context, latest.event.text || "Waiting for output…", 832);
      lines.slice(0, 2).forEach((line, index) => fitted(line + (index === 1 && lines.length > 2 ? " …" : ""), 88, 565 + index * 29, 848));
    } else {
      cameraText(context, "LATEST ACTIVITY", 88, 529, 19, cameraColors.accent, 600);
      cameraText(context, "Tool calls and outputs will appear here as they arrive.", 88, 577, 22, cameraColors.secondary);
    }

    card(64, 664, 896, 256, "#121d2d");
    const thread = threads[selected];
    if (thread) {
      const signature = JSON.stringify([thread.name, thread.state, thread.held, thread.activity, thread.tools, thread.output, thread.events]);
      let entry = content.get(thread.id);
      if (!entry || entry.signature !== signature) {
        entry = { signature, lines: threadLines(context, thread), page: entry?.page ?? 0 };
        content.set(thread.id, entry);
      }
      const pages = Math.max(1, Math.ceil(entry.lines.length / detailLines));
      entry.page %= pages;
      fitted(thread.name || thread.id, 88, 682, 570, 24, cameraColors.text, 600);
      cameraText(context, `THREAD ${selected + 1}/${threads.length}`, 740, 687, 17, cameraColors.accent, 600);
      cameraText(context, `RECENT HISTORY · PAGE ${entry.page + 1}/${pages}`, 88, 718, 16, cameraColors.secondary, 600);
      context.fillStyle = "#2a3a51"; context.fillRect(88, 744, 848, 1);
      entry.lines.slice(entry.page * detailLines, (entry.page + 1) * detailLines).forEach((line, index) => {
        cameraText(context, line.text, 88, 758 + index * 28, 22, line.label ? cameraColors.accent : cameraColors.text, line.label ? 600 : 400);
      });
    } else {
      cameraText(context, "Recent history", 88, 682, 24, cameraColors.text, 600);
      cameraText(context, "No thread activity to display.", 88, 764, 23, cameraColors.secondary);
    }

    const seconds = Math.max(1, Math.ceil((nextPageAt - now) / 1000));
    cameraText(context, threads.length ? `Next panel in ${seconds}s · Every thread and content page rotates` : "Voice state updates live", 64, 945, 18, cameraColors.secondary);
    context.fillStyle = "#29394f"; context.fillRect(64, 976, 896, 2);
    context.fillStyle = cameraColors.accent;
    context.fillRect(64, 976, 896 * Math.max(0, 1 - (nextPageAt - now) / pageDuration), 2);
  };

  draw();
  const stream = canvas.captureStream(4);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    content.clear();
    stream.getTracks().forEach((track) => track.stop());
  };
  const timer = setInterval(() => {
    if (stream.getVideoTracks().every((track) => track.readyState === "ended")) { close(); return; }
    draw();
  }, 250);
  stream.getVideoTracks().forEach((track) => track.addEventListener("ended", close, { once: true }));
  return { stream, close };
}
