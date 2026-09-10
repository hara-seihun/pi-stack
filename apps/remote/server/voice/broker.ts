import { readFileSync } from "node:fs";
import { LIVE_MODEL, LIVE_VOICE, type VoiceConnection, type VoiceResult } from "./protocol";

const API = "https://api.openai.com/v1/live/sessions";

export function boundedSdp(sdp: string): boolean {
  return sdp.startsWith("v=0") && Buffer.byteLength(sdp, "utf8") <= 128 * 1024;
}

export class VoiceBroker {
  readonly #key: string;
  constructor(credentialFile: string) {
    this.#key = readFileSync(credentialFile, "utf8").trim();
    if (!this.#key.startsWith("sk-")) throw new Error("The Voice service requires an OpenAI API key in its dedicated credential file");
  }

  async negotiate(sdp: string, instructions: string): Promise<VoiceResult<VoiceConnection>> {
    if (!boundedSdp(sdp)) return { ok: false, status: 400, error: "A bounded WebRTC SDP offer is required" };
    if (Buffer.byteLength(instructions, "utf8") > 32_000) return { ok: false, status: 400, error: "Voice instructions are too large" };
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
        body: JSON.stringify({
          session: {
            model: LIVE_MODEL,
            instructions,
            audio: { output: { voice: LIVE_VOICE } },
            delegation: { type: "client" },
            store: false,
          },
          transport: { type: "webrtc", sdp },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { ok: false, status: response.status, error: `OpenAI Live session creation failed (HTTP ${response.status})` };
      const value = await response.json() as VoiceConnection;
      if (!value.session?.id || typeof value.transport?.sdp !== "string") return { ok: false, status: 502, error: "OpenAI Live returned no session ID or SDP answer" };
      return { ok: true, value: { session: { id: value.session.id }, transport: { type: "webrtc", sdp: value.transport.sdp } } };
    } catch {
      return { ok: false, status: 502, error: "Could not connect to the OpenAI Live API" };
    }
  }

  async close(id: string): Promise<VoiceResult<{ closed: true }>> {
    try {
      const response = await fetch(`${API}/${encodeURIComponent(id)}/hangup`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || response.status === 404 || response.status === 410) return { ok: true, value: { closed: true } };
      return { ok: false, status: response.status, error: `OpenAI Live hangup failed (HTTP ${response.status})` };
    } catch {
      return { ok: false, status: 502, error: "Could not close the OpenAI Live session" };
    }
  }
}
