import { OVERLAY_MAX_SAY } from "./phone-commands";
import type { OverlayAck, OverlayMessage, PhoneDevice, PhoneResult } from "./phones";

/**
 * The phone overlay is one more door onto Kenan: what the person types beside
 * Kenan's dot becomes a message in the person's managing conversation, and its
 * assistant text comes back as speech bubbles while the dot shows its state.
 */
export type OverlayHost = {
  /** null when the thread no longer exists; archived threads are not reused. */
  thread(id: string): { archived: boolean } | null;
  create(text: string, device: PhoneDevice, requestId: string): Promise<string>;
  /** Freeze display/context bytes by the phone's original source identity before admission. */
  prepare(deviceId: string, messageId: string, input: string, proposed: string): string;
  prompt(threadId: string, requestId: string, text: string): Promise<void>;
  send(deviceId: string, command: string, args: Record<string, unknown>): Promise<PhoneResult>;
  online(deviceId: string): boolean;
  load(): Array<{ deviceId: string; threadId: string }>;
  save(deviceId: string, threadId: string): void;
  log(message: string): void;
};

type DotState = "idle" | "thinking" | "working";

export function overlayBriefing(device: PhoneDevice): string {
  return [
    `[Phone overlay] You're talking through Kenan's overlay on the person's phone "${device.name}" (${device.model}, device ${device.id}). They are using the phone normally, outside the Kenan app.`,
    "Your assistant text appears in a speech bubble beside your dot, so speak briefly and conversationally; the full exchange stays in this thread.",
    "Use `pi-phone` to see and act (`screenshot --output PATH`, `tree`, `tap`, `swipe`, `text`, `action`, `launch`); every tap, swipe and edit is shown on their screen as your dot moving there.",
    "To show rather than do: `pi-phone point X Y [TEXT]`, or `pi-phone command overlay.point '{\"nodeId\":\"…\",\"text\":\"…\"}'` with a node from the latest tree. `pi-phone say TEXT` speaks mid-task. Outgoing messages, calls and anything irreversible still need their explicit intent.",
  ].join(" ");
}

export function overlayContext(message: OverlayMessage): string {
  const app = message.context.label && message.context.package ? `${message.context.label} (${message.context.package})`
    : message.context.label ?? message.context.package;
  return app ? `[Phone overlay · in ${app}]` : "[Phone overlay]";
}

/** Visible text of an assistant message, without Remote tags the bubble cannot render. */
export function spokenText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n")
    : "";
  const clean = text.replace(/<pi-remote-[a-z-]+\b[^>]*\/>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > OVERLAY_MAX_SAY ? `${clean.slice(0, OVERLAY_MAX_SAY - 1)}…` : clean;
}

export class PhoneOverlay {
  private readonly deviceFor = new Map<string, Set<string>>();
  private readonly threadFor = new Map<string, string>();
  private readonly dot = new Map<string, DotState>();
  private readonly enabled = new Set<string>();
  /** Last unspoken reply per phone, delivered when it reconnects. */
  private readonly unspoken = new Map<string, string>();

  constructor(private readonly host: OverlayHost) {
    for (const { deviceId, threadId } of host.load()) this.bind(deviceId, threadId);
  }

  private bind(deviceId: string, threadId: string) {
    const previous = this.threadFor.get(deviceId);
    if (previous) {
      const devices = this.deviceFor.get(previous);
      devices?.delete(deviceId);
      if (devices?.size === 0) this.deviceFor.delete(previous);
    }
    this.threadFor.set(deviceId, threadId);
    const devices = this.deviceFor.get(threadId) ?? new Set<string>();
    devices.add(deviceId);
    this.deviceFor.set(threadId, devices);
  }

  async message(device: PhoneDevice, message: OverlayMessage): Promise<OverlayAck> {
    if (device.capabilities.overlayEnabled !== true || !this.enabled.has(device.id)) return { ok: false, error: { code: "disabled", message: "Overlay chat is disabled on this phone" } };
    const original = `${overlayContext(message)}\n${message.text}`;
    const existing = this.threadFor.get(device.id);
    const live = existing ? this.host.thread(existing) : null;
    this.state(device.id, "thinking");
    try {
      const text = this.host.prepare(device.id, message.id, JSON.stringify(message), existing && live && !live.archived ? original : `${overlayBriefing(device)}\n\n${original}`);
      if (existing && live && !live.archived) {
        await this.host.prompt(existing, `overlay:${device.id}:${message.id}`, text);
        return { ok: true, threadId: existing };
      }
      const threadId = await this.host.create(text, device, `overlay:${device.id}:${message.id}`);
      this.bind(device.id, threadId);
      this.host.save(device.id, threadId);
      return { ok: true, threadId };
    } catch (cause) {
      this.state(device.id, "idle");
      throw cause;
    }
  }

  /** Orchestrator thread events, for every thread; only overlay threads matter. */
  event(threadId: string, event: any): void {
    const devices = this.deviceFor.get(threadId);
    if (!devices || !event || typeof event !== "object") return;
    for (const deviceId of devices) {
      if (!this.enabled.has(deviceId)) continue;
      if (event.type === "thread_message_inserted") this.state(deviceId, "thinking");
      else if (event.type === "tool_execution_start") this.state(deviceId, "working");
      else if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = spokenText(event.message);
        if (text) this.say(deviceId, text);
      } else if (event.type === "thread_settled") {
        if (event.outcome === "failed") this.say(deviceId, spokenText(event.finalMessage) || "That didn't work; the details are in the managing conversation.");
        this.state(deviceId, "idle");
      }
    }
  }

  ready(device: PhoneDevice): void {
    if (device.capabilities.overlayEnabled !== true) {
      this.enabled.delete(device.id);
      this.dot.delete(device.id);
      this.unspoken.delete(device.id);
      return;
    }
    this.enabled.add(device.id);
    const text = this.unspoken.get(device.id);
    this.dot.delete(device.id);
    if (text) { this.unspoken.delete(device.id); this.say(device.id, text); }
  }

  private say(deviceId: string, text: string): void {
    if (!this.enabled.has(deviceId)) return;
    if (!this.host.online(deviceId)) { this.unspoken.set(deviceId, text); return; }
    void this.host.send(deviceId, "overlay.say", { text }).then(result => {
      if (result.ok) return;
      if (result.error.code === "disconnected" && this.enabled.has(deviceId)) this.unspoken.set(deviceId, text);
      this.host.log(`overlay.say to ${deviceId} failed: ${result.error.code} ${result.error.message}`);
    });
  }

  private state(deviceId: string, state: DotState): void {
    if (!this.enabled.has(deviceId) || this.dot.get(deviceId) === state || !this.host.online(deviceId)) return;
    this.dot.set(deviceId, state);
    void this.host.send(deviceId, "overlay.state", { state }).then(result => {
      if (!result.ok) { this.dot.delete(deviceId); this.host.log(`overlay.state to ${deviceId} failed: ${result.error.code}`); }
    });
  }
}
