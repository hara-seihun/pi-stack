import { useSyncExternalStore } from "react";
import { API } from "../../server/api";
import type { SpeechCatalog, SpeechUtterance, SpeechVoice } from "../../server/protocol";
import { appStorageKey } from "./app-path";
import { api, piFetch } from "./client";
import { resourceUrl } from "./resource-url";

export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

export interface SpeechState {
  catalog: SpeechCatalog | null;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  error: string;
  title: string;
  rate: number;
  engine: string | null;
  voice: string | null;
  voices: SpeechVoice[];
  /** Seconds played of the current utterance. */
  position: number;
}

const rateKey = () => appStorageKey("pi-remote-speech-rate");
const voiceKey = (engine: string) => appStorageKey(`pi-remote-speech-voice:${engine}`);

function stored(key: () => string): string {
  try { return localStorage.getItem(key()) || ""; } catch { return ""; }
}
function remember(key: () => string, value: string) {
  try { localStorage.setItem(key(), value); } catch {}
}

/** One player for the whole client: the message being read, its rate and voice. */
class SpeechPlayer {
  private state: SpeechState = { catalog: null, status: "idle", error: "", title: "", rate: Number(stored(rateKey)) || 1, engine: null, voice: null, voices: [], position: 0 };
  private readonly listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private utterance: SpeechUtterance | null = null;
  private request = 0;

  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<SpeechState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  configure(catalog: SpeechCatalog | null) {
    const engines = catalog?.engines ?? [];
    const engine = engines.find(item => item.id === this.state.engine) ?? engines[0] ?? null;
    const voice = engine ? (stored(() => voiceKey(engine.id)) || engine.defaultVoice) : null;
    if (JSON.stringify(catalog) === JSON.stringify(this.state.catalog) && engine?.id === this.state.engine && voice === this.state.voice) return;
    this.patch({ catalog: engines.length ? catalog : null, engine: engine?.id ?? null, voice, voices: engine?.id === this.state.engine ? this.state.voices : [] });
    if (!engines.length && this.state.status !== "idle") this.stop();
  }

  get available() { return this.state.catalog !== null; }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "auto";
    (audio as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    audio.addEventListener("playing", () => this.patch({ status: "playing", error: "" }));
    audio.addEventListener("pause", () => { if (!audio.ended && this.state.status === "playing") this.patch({ status: "paused" }); });
    audio.addEventListener("ended", () => this.patch({ status: "idle", position: 0 }));
    audio.addEventListener("timeupdate", () => this.patch({ position: audio.currentTime }));
    audio.addEventListener("error", () => void this.failed(audio.error?.message || "Playback failed"));
    audio.addEventListener("stalled", () => { if (this.state.status === "playing") this.patch({ status: "loading" }); });
    audio.addEventListener("waiting", () => { if (this.state.status === "playing") this.patch({ status: "loading" }); });
    this.audio = audio;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => this.resume());
      navigator.mediaSession.setActionHandler("pause", () => this.pause());
      navigator.mediaSession.setActionHandler("stop", () => this.stop());
    }
    return audio;
  }

  private async failed(fallback: string) {
    if (this.state.status === "idle") return;
    let message = fallback;
    if (this.utterance) {
      try {
        const status = await api(API.speechUtterance.method, API.speechUtterance.path({ utteranceId: this.utterance.id })) as SpeechUtterance;
        if (status.error) message = status.error;
      } catch {}
    }
    this.patch({ status: "error", error: message });
  }

  /** Read `text` aloud; `title` names it in the player. Replaces whatever was playing. */
  async speak(text: string, title: string) {
    if (!this.state.engine) { this.patch({ status: "error", error: "This host reads nothing aloud: no speech engine is configured." }); return; }
    const request = ++this.request;
    const audio = this.element();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    this.utterance = null;
    this.patch({ status: "loading", error: "", title, position: 0 });
    let utterance: SpeechUtterance;
    try {
      utterance = await api(API.speechUtterances.method, API.speechUtterances.path(), { text, engine: this.state.engine, voice: this.state.voice }) as SpeechUtterance;
    } catch (cause) {
      if (request === this.request) this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    if (request !== this.request) return;
    this.utterance = utterance;
    audio.defaultPlaybackRate = this.state.rate;
    audio.playbackRate = this.state.rate;
    audio.src = resourceUrl(API.speechAudio.path({ utteranceId: utterance.id }));
    if ("mediaSession" in navigator && "MediaMetadata" in window) navigator.mediaSession.metadata = new MediaMetadata({ title, artist: `${utterance.voice} · PiStack` });
    try { await audio.play(); }
    catch (cause) { if (request === this.request) this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) }); }
  }

  pause() { this.audio?.pause(); }
  resume() { void this.audio?.play().catch(cause => this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })); }
  toggle() { this.state.status === "playing" ? this.pause() : this.resume(); }
  stop() {
    this.request++;
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); }
    this.utterance = null;
    this.patch({ status: "idle", error: "", title: "", position: 0 });
  }

  setRate(rate: number) {
    remember(rateKey, String(rate));
    if (this.audio) { this.audio.defaultPlaybackRate = rate; this.audio.playbackRate = rate; }
    this.patch({ rate });
  }

  setVoice(voice: string) {
    if (this.state.engine) { const engine = this.state.engine; remember(() => voiceKey(engine), voice); }
    this.patch({ voice });
  }

  async loadVoices() {
    const engine = this.state.engine;
    if (!engine || this.state.voices.length) return;
    try {
      const response = await piFetch(API.speechVoices.path({ engineId: engine }), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (engine !== this.state.engine) return;
      const voices = body.voices as SpeechVoice[];
      const voice = voices.some(item => item.id === this.state.voice) ? this.state.voice : body.defaultVoice ?? voices[0]?.id ?? null;
      this.patch({ voices, voice });
    } catch (cause) {
      this.patch({ error: `Voices unavailable: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
}

export const speech = new SpeechPlayer();

export function useSpeech(): SpeechState {
  return useSyncExternalStore(speech.subscribe, speech.snapshot, speech.snapshot);
}

export function speechTitle(text: string): string {
  const line = text.replace(/[#*_`>\[\]]/g, "").split("\n").map(part => part.trim()).find(Boolean) ?? "Message";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
