import type { TtsEngineConfig, TtsPcmStream, TtsPlugin, TtsResult, TtsSpeechRequest, TtsVoice } from "./plugin";

// Fish Speech S2 Pro behind the streaming voice daemon: `GET /voices` lists the
// reference catalog and `POST /speak` answers with chunked s16le PCM as the
// model decodes. The daemon is EverythingLIVE's on GMKtec; any server with the
// same two routes works.
export interface FishSpeechOptions {
  url: string;
  defaultVoice?: string;
  /** Fish reads one continuous take per request inside an 8K-token context; ~700 characters keeps a take well inside it. */
  maxSegmentChars?: number;
  direction?: string;
  language?: "en" | "fr";
}

function options(config: TtsEngineConfig): FishSpeechOptions {
  const raw = (config.options ?? {}) as Partial<FishSpeechOptions>;
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) throw new Error(`Speech engine ${config.id}: fish-speech needs an http(s) url`);
  if (raw.maxSegmentChars !== undefined && (!Number.isInteger(raw.maxSegmentChars) || raw.maxSegmentChars < 40)) throw new Error(`Speech engine ${config.id}: maxSegmentChars must be an integer of at least 40`);
  if (raw.language !== undefined && raw.language !== "en" && raw.language !== "fr") throw new Error(`Speech engine ${config.id}: language must be en or fr`);
  return { url: raw.url.replace(/\/+$/, ""), defaultVoice: raw.defaultVoice, maxSegmentChars: raw.maxSegmentChars ?? 700, direction: raw.direction, language: raw.language };
}

async function failure(response: Response): Promise<TtsResult<never>> {
  let message = `Fish Speech answered HTTP ${response.status}`;
  try { const body = await response.json(); if (typeof body?.error === "string") message = body.error; } catch {}
  return { ok: false, error: message, status: response.status >= 500 ? 502 : response.status };
}

export function fishSpeechPlugin(config: TtsEngineConfig): TtsPlugin {
  const settings = options(config);
  return {
    id: config.id,
    name: config.name ?? "Fish Speech",
    defaultVoice: settings.defaultVoice ?? null,
    maxSegmentChars: settings.maxSegmentChars!,
    async voices(): Promise<TtsResult<TtsVoice[]>> {
      try {
        const response = await fetch(`${settings.url}/voices`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return failure(response);
        const body = await response.json() as { voices?: Record<string, { description?: string }> };
        if (!body?.voices || typeof body.voices !== "object") return { ok: false, error: "Fish Speech returned no voice catalog", status: 502 };
        return { ok: true, value: Object.entries(body.voices).map(([id, entry]) => ({ id, name: id, description: entry?.description })) };
      } catch (cause) {
        return { ok: false, error: `Fish Speech is unreachable: ${cause instanceof Error ? cause.message : cause}`, status: 503 };
      }
    },
    async speak(request: TtsSpeechRequest): Promise<TtsResult<TtsPcmStream>> {
      const body: Record<string, string> = { text: request.text, voice: request.voice };
      if (settings.direction) body.direction = settings.direction;
      if (settings.language) body.language = settings.language;
      let response: Response;
      try {
        response = await fetch(`${settings.url}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: request.signal });
      } catch (cause) {
        if (request.signal.aborted) return { ok: false, error: "Speech cancelled", status: 499 };
        return { ok: false, error: `Fish Speech is unreachable: ${cause instanceof Error ? cause.message : cause}`, status: 503 };
      }
      if (!response.ok) return failure(response);
      if (!response.body) return { ok: false, error: "Fish Speech returned no audio", status: 502 };
      const sampleRate = Number(response.headers.get("x-sample-rate"));
      const channels = response.headers.get("x-channels") ?? "1";
      const format = response.headers.get("x-sample-format") ?? "s16le";
      if (!Number.isInteger(sampleRate) || sampleRate <= 0 || channels !== "1" || format !== "s16le") return { ok: false, error: `Fish Speech answered with unsupported audio (${sampleRate} Hz, ${channels} ch, ${format})`, status: 502 };
      return { ok: true, value: { sampleRate, chunks: response.body as AsyncIterable<Uint8Array> } };
    },
  };
}
