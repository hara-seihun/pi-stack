import { API } from "../api";
import { API_CORS_HEADERS } from "../cors";
import type { SpeechCatalog, SpeechUtterance } from "../protocol";
import { fishSpeechPlugin } from "./fish-speech";
import type { TtsEngineConfig, TtsPcmStream, TtsPlugin, TtsPluginFactory, TtsResult } from "./plugin";
import { speechSegments, speechText } from "./text";

export const SPEECH_PLUGINS: Record<string, TtsPluginFactory> = { "fish-speech": fishSpeechPlugin };

export interface SpeechConfig { engines: TtsEngineConfig[] }

/** `PI_REMOTE_SPEECH` is `{ "engines": [{ "id", "plugin", "name"?, "options"? }] }`; the first engine is the default. */
export function speechConfig(raw = process.env.PI_REMOTE_SPEECH): SpeechConfig | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (cause) { throw new Error(`PI_REMOTE_SPEECH is not JSON: ${cause instanceof Error ? cause.message : cause}`); }
  const engines = (parsed as { engines?: unknown })?.engines;
  if (!Array.isArray(engines)) throw new Error("PI_REMOTE_SPEECH needs an engines array");
  const ids = new Set<string>();
  for (const engine of engines as TtsEngineConfig[]) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(engine?.id))) throw new Error(`PI_REMOTE_SPEECH: invalid engine id ${engine?.id}`);
    if (ids.has(engine.id)) throw new Error(`PI_REMOTE_SPEECH: duplicate engine id ${engine.id}`);
    ids.add(engine.id);
    if (typeof engine.plugin !== "string") throw new Error(`PI_REMOTE_SPEECH: engine ${engine.id} needs a plugin name`);
    if (engine.name !== undefined && typeof engine.name !== "string") throw new Error(`PI_REMOTE_SPEECH: engine ${engine.id} name must be a string`);
    if (engine.options !== undefined && (typeof engine.options !== "object" || engine.options === null || Array.isArray(engine.options))) throw new Error(`PI_REMOTE_SPEECH: engine ${engine.id} options must be an object`);
  }
  return engines.length ? { engines } : null;
}

const UTTERANCE_TTL_MS = 15 * 60_000;
const UTTERANCE_LIMIT = 200;
const TEXT_LIMIT = 100_000;

interface Utterance extends SpeechUtterance {
  segments: string[];
  createdAt: number;
  plugin: TtsPlugin;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...API_CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store" } });
const error = (message: string, status = 400) => json({ error: message }, status);

export class SpeechService {
  readonly engines = new Map<string, TtsPlugin>();
  private readonly utterances = new Map<string, Utterance>();
  private readonly playing = new Map<string, AbortController>();

  constructor(config: SpeechConfig, plugins: Record<string, TtsPluginFactory> = SPEECH_PLUGINS) {
    for (const engine of config.engines) {
      const factory = plugins[engine.plugin];
      if (!factory) throw new Error(`PI_REMOTE_SPEECH: engine ${engine.id} names unknown plugin ${engine.plugin}; known: ${Object.keys(plugins).join(", ")}`);
      this.engines.set(engine.id, factory(engine));
    }
  }

  catalog(): SpeechCatalog {
    return { engines: [...this.engines.values()].map(plugin => ({ id: plugin.id, name: plugin.name, defaultVoice: plugin.defaultVoice })) };
  }

  /** Remember a text to read; the audio route synthesizes it when a player asks. */
  register(body: { text?: unknown; engine?: unknown; voice?: unknown }): TtsResult<SpeechUtterance> {
    if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, error: "text is required" };
    if (body.text.length > TEXT_LIMIT) return { ok: false, error: `text is longer than ${TEXT_LIMIT} characters` };
    const engineId = body.engine === undefined ? this.engines.keys().next().value : body.engine;
    const plugin = typeof engineId === "string" ? this.engines.get(engineId) : undefined;
    if (!plugin) return { ok: false, error: `Unknown speech engine ${String(engineId)}`, status: 404 };
    const voice = body.voice === undefined || body.voice === null ? plugin.defaultVoice : body.voice;
    if (typeof voice !== "string" || !voice) return { ok: false, error: `Speech engine ${plugin.id} has no default voice; choose one` };
    const segments = speechSegments(speechText(body.text), plugin.maxSegmentChars);
    if (!segments.length) return { ok: false, error: "Nothing to read: the message has no spoken text" };
    this.expire();
    const utterance: Utterance = { id: crypto.randomUUID(), engine: plugin.id, voice, segments, characters: segments.reduce((sum, segment) => sum + segment.length, 0), segmentCount: segments.length, state: "ready", error: null, createdAt: Date.now(), plugin };
    this.utterances.set(utterance.id, utterance);
    return { ok: true, value: publicUtterance(utterance) };
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, utterance] of this.utterances) if (now - utterance.createdAt > UTTERANCE_TTL_MS && !this.playing.has(id)) this.utterances.delete(id);
    while (this.utterances.size >= UTTERANCE_LIMIT) {
      const oldest = this.utterances.keys().next().value;
      if (oldest === undefined || this.playing.has(oldest)) break;
      this.utterances.delete(oldest);
    }
  }

  /** Ogg/Opus, produced as the engine speaks; the first bytes leave as soon as the engine accepts the first take. */
  async audio(id: string, signal: AbortSignal): Promise<Response> {
    const utterance = this.utterances.get(id);
    if (!utterance) return error("Unknown utterance; it may have expired", 404);
    this.playing.get(id)?.abort(new Error("Superseded by a new playback of the same utterance"));
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Playback cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    this.playing.set(id, controller);
    const finish = (state: Utterance["state"], message: string | null) => {
      if (this.playing.get(id) === controller) this.playing.delete(id);
      signal.removeEventListener("abort", abort);
      utterance.state = state;
      utterance.error = message;
    };
    utterance.state = "speaking";
    utterance.error = null;
    const first = await utterance.plugin.speak({ text: utterance.segments[0], voice: utterance.voice, signal: controller.signal });
    if (!first.ok) { finish("failed", first.error); return error(first.error, first.status ?? 502); }
    const sampleRate = first.value.sampleRate;
    const encoder = Bun.spawn(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", "-application", "audio", "-frame_duration", "20",
      "-f", "ogg", "-page_duration", "100000", "-flush_packets", "1", "pipe:1"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(encoder.stderr).text();
    const pump = async () => {
      let stream: TtsResult<TtsPcmStream> = first;
      for (let index = 0; ; index++) {
        if (!stream.ok) throw new Error(stream.error);
        if (stream.value.sampleRate !== sampleRate) throw new Error(`Speech engine changed sample rate from ${sampleRate} to ${stream.value.sampleRate} mid-utterance`);
        for await (const chunk of stream.value.chunks) {
          controller.signal.throwIfAborted();
          encoder.stdin.write(chunk);
          await encoder.stdin.flush();
        }
        if (index + 1 >= utterance.segments.length) break;
        stream = await utterance.plugin.speak({ text: utterance.segments[index + 1], voice: utterance.voice, signal: controller.signal });
      }
    };
    void pump().then(async () => {
      await encoder.stdin.end();
      const code = await encoder.exited;
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${(await stderr).trim()}`);
      finish("spoken", null);
    }).catch(cause => {
      const message = controller.signal.aborted ? String(controller.signal.reason?.message ?? "Playback cancelled") : cause instanceof Error ? cause.message : String(cause);
      finish(controller.signal.aborted ? "ready" : "failed", controller.signal.aborted ? null : message);
      if (!controller.signal.aborted) console.error(`Speech utterance ${id} failed: ${message}`);
      encoder.kill();
    });
    return new Response(encoder.stdout, { headers: { ...API_CORS_HEADERS, "content-type": "audio/ogg", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/speech")) return null;
    if (API.speech.match(req.method, url.pathname)) return json(this.catalog());
    const voices = API.speechVoices.match(req.method, url.pathname);
    if (voices) {
      const plugin = this.engines.get(voices.engineId);
      if (!plugin) return error(`Unknown speech engine ${voices.engineId}`, 404);
      const result = await plugin.voices();
      return result.ok ? json({ voices: result.value, defaultVoice: plugin.defaultVoice }) : error(result.error, result.status ?? 502);
    }
    if (API.speechUtterances.match(req.method, url.pathname)) {
      let body: unknown;
      try { body = await req.json(); } catch { return error("JSON body required"); }
      const result = this.register((body ?? {}) as Record<string, unknown>);
      return result.ok ? json(result.value, 201) : error(result.error, result.status ?? 400);
    }
    const status = API.speechUtterance.match(req.method, url.pathname);
    if (status) {
      const utterance = this.utterances.get(status.utteranceId);
      return utterance ? json(publicUtterance(utterance)) : error("Unknown utterance; it may have expired", 404);
    }
    const audio = API.speechAudio.match(req.method, url.pathname);
    if (audio) return this.audio(audio.utteranceId, req.signal);
    return null;
  }

  close(): void {
    for (const controller of this.playing.values()) controller.abort(new Error("Supervisor handing over"));
  }
}

function publicUtterance(utterance: Utterance): SpeechUtterance {
  const { id, engine, voice, characters, segmentCount, state, error } = utterance;
  return { id, engine, voice, characters, segmentCount, state, error };
}

export function createSpeechService(): SpeechService | null {
  const config = speechConfig();
  return config ? new SpeechService(config) : null;
}
