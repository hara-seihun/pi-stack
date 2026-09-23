import { modelBrokerUrl } from "pi-orchestrator/api";
import { voiceServiceUrl, type VoiceConnection, type VoiceResult } from "./protocol";

export class VoiceClient {
  constructor(private readonly owner: string) {}

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<VoiceResult<T>> {
    try {
      const broker = modelBrokerUrl();
      const url = broker ? `${broker}/v1/voice${path}` : new URL(path, voiceServiceUrl());
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify({ ...body as object, owner: this.owner }),
        signal: AbortSignal.timeout(35_000),
      });
      const value = await response.json();
      return response.ok ? { ok: true, value: value as T } : { ok: false, status: response.status, error: String(value.error || "Voice service request failed") };
    } catch {
      return { ok: false, status: 503, error: "The PiStack Voice API service is unavailable" };
    }
  }

  status() { return this.request<{ enabled: boolean; model: string; voice: string }>("/status"); }
  negotiate(threadId: string, sdp: string, instructions: string) {
    return this.request<VoiceConnection>("/sessions", "POST", { threadId, sdp, instructions });
  }
  heartbeat(threadId: string, voiceId: string, seconds: number, finalized: boolean) {
    return this.request(`/sessions/${encodeURIComponent(voiceId)}`, "PATCH", { threadId, seconds, finalized });
  }
  close(threadId: string, voiceId: string) {
    return this.request(`/sessions/${encodeURIComponent(voiceId)}`, "DELETE", { threadId });
  }
}
